/**
 * MBA service HTTP surface (ADR-0092 Step 2).
 *
 * A thin hono app over the global config store. The service is the single
 * writer for the global rule state; the proxy is a read-mostly consumer that
 * caches `resolve_config` and re-fetches on version bump.
 *
 * Endpoints:
 *   GET  /resolve_config?model=<id>  → { version, tcb, ruleClasses }
 *        The global rule layer. `model` is accepted now (and echoed) so the
 *        v2 model-tier merge can be added without a contract change; today
 *        the layer is model-independent and the per-model merge happens in
 *        the proxy's resolver.
 *   POST /set_rules                  → { version, tcb }
 *        Body: { tcb, ruleClasses? }. Validates, persists atomically, bumps
 *        the version. 400 on invalid shape.
 *   GET  /status                     → { version, uptimeMs, paths }
 *
 * Model plane (ADR-0093 Phase 1):
 *   GET  /models                     → { models: [{ id, name, family, modelFile, loaded }] }
 *        Always on, read-only. Catalog from the adapter tree + live loaded
 *        state probed from the upstream llama-server.
 *   POST /models/ensure              → { status: loaded|switched|disabled|unknown|failed, id }
 *        OFF by default (409 "disabled") — armed via `switchEnabled`
 *        (env `MBA_MODEL_SWITCH=on`). Idempotent: a loaded model is a no-op.
 *   POST /models/pull                → { id, family, sha256, resumed, modelDir, adapterPath, familyCreated }
 *        Body: { url, id, sha256, family? }. One-command model onboarding
 *        (ADR-0098): download (resume + sha256 verify) → parse GGUF header →
 *        scaffold the two-tier binding structure. 400 bad input, 409 folder
 *        exists, 422 sha256 mismatch, 500 download failure.
 *   GET  /models/config?id=<id>      → { modelId, files, fields: [{ field, file, current, restartRequired }] }
 *   POST /models/config              → { file, field, before, after, restartRequired, modelLoaded }
 *        Body: { id, file: 'server_setup'|'client', field, value }. The
 *        per-model dial write door (ADR-0096): validates and writes ONE
 *        field via the model-config capability block. 404 unknown model,
 *        400 invalid field/value. REPORTS `modelLoaded` (probed from the
 *        upstream) so the caller can offer a restart — the route never
 *        restarts anything itself.
 *
 * The app is exported separately from the listener so tests can drive it
 * with `app.request()` without binding a port.
 */

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import {
  defaultStorePaths,
  readGlobalConfig,
  setRules,
  type MbaStorePaths,
} from "./config-store.js";
import { isToolCircuitBreakerConfig } from "../bcb/is-config.js";
import { isRuleClassRegistry, type RuleClassRegistry } from "../bcb/rule-classes.js";
import type { ToolCircuitBreakerConfig } from "../bcb/types.js";
import { readModelCatalog, type CatalogEntry } from "./model-catalog.js";
import {
  ensureModel,
  isLoadedPath,
  probeLoadedModel,
  type SwitchExecutor,
} from "./model-switch.js";
import { readModelDials, setModelDial, type ModelDialFile } from "./model-config.js";
import {
  pullModel,
  PullConflictError,
  PullValidationError,
  PullVerifyError,
} from "../model/model-pull.js";
import {
  listUpstreams,
  readRegistry,
  removeById,
  resolveUpstream,
  upsertEntry,
  writeRegistry,
} from "./upstream-registry.js";
import { bootServer } from "./server-boot.js";
import { getServerTypeOps, type ServerType } from "./server-types.js";
import type { LifecycleSeams } from "../mba/index.js";

export interface MbaServiceAppOptions {
  readonly paths?: MbaStorePaths;
  /** Adapter tree root (default: OS-aware model store, see service/paths.ts). */
  readonly adapterDir?: string;
  /** Upstream llama-server base URL (e.g. `http://127.0.0.1:8080`). */
  readonly upstreamUrl?: string;
  /** Arm model switching (ADR-0093: OFF by default). */
  readonly switchEnabled?: boolean;
  /** Switch executor — injectable for tests; default shells to the boot script. */
  readonly switchExecutor?: SwitchExecutor;
  /** Injectable fetch for the upstream probe (tests). */
  readonly fetch?: typeof fetch;
  /**
   * Shared lifecycle seams (spawn/fetch/kill). The G1 owned-group registry
   * lives on this instance, so the daemon must pass ONE instance for its
   * lifetime and call `killAllOwnedGroups` on exit.
   */
  readonly lifecycleSeams?: LifecycleSeams;
}

export function createMbaServiceApp(opts: MbaServiceAppOptions = {}): Hono {
  const paths = opts.paths ?? defaultStorePaths();
  const startedAt = Date.now();

  const app = new Hono();

  app.get("/resolve_config", (c) => {
    const model = c.req.query("model");
    const cfg = readGlobalConfig(paths);
    return c.json({
      version: cfg.version,
      model: model ?? null,
      tcb: cfg.tcb,
      ruleClasses: cfg.ruleClasses,
    });
  });

  app.post("/set_rules", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const input = body as { tcb?: unknown; ruleClasses?: unknown };
    if (!input || typeof input !== "object" || !isToolCircuitBreakerConfig(input.tcb)) {
      return c.json({ error: "body.tcb must be a valid ToolCircuitBreakerConfig" }, 400);
    }
    if (input.ruleClasses !== undefined && !isRuleClassRegistry(input.ruleClasses)) {
      return c.json({ error: "body.ruleClasses must be a valid RuleClassRegistry" }, 400);
    }
    try {
      const result = setRules(paths, {
        tcb: input.tcb as ToolCircuitBreakerConfig,
        ruleClasses: input.ruleClasses as RuleClassRegistry | undefined,
      });
      return c.json(result);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "set_rules failed" }, 500);
    }
  });

  app.get("/status", (c) => {
    const cfg = readGlobalConfig(paths);
    return c.json({
      version: cfg.version,
      uptimeMs: Date.now() - startedAt,
      paths: {
        baseDir: paths.baseDir,
        tcbPath: paths.tcbPath,
        ruleClassesPath: paths.ruleClassesPath,
        versionPath: paths.versionPath,
      },
    });
  });

  // --- Model plane (ADR-0093 Phase 1) -------------------------------------

  app.get("/models", async (c) => {
    const catalog = readModelCatalog(opts.adapterDir ?? "");
    return c.json({
      models: await Promise.all(
        catalog.map(async (e) => ({
          id: e.id,
          name: e.name,
          family: e.family,
          modelFile: e.modelFile,
          loaded: isLoadedPath(
            await probeModelLoaded(e, paths, opts.upstreamUrl, opts.fetch),
            e.modelFile,
          ),
        })),
      ),
    });
  });

  app.post("/models/ensure", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const input = body as { id?: unknown };
    if (!input || typeof input.id !== "string" || input.id.length === 0) {
      return c.json({ error: "body.id must be a non-empty string" }, 400);
    }
    const result = await ensureModel({
      catalog: readModelCatalog(opts.adapterDir ?? ""),
      requestedId: input.id,
      upstreamUrl: opts.upstreamUrl ?? "",
      switchEnabled: opts.switchEnabled ?? false,
      executor: opts.switchExecutor ?? ((ctx) => defaultSwitchExecutor(ctx, opts)),
      fetch: opts.fetch,
    });
    if (result.status === "unknown") {
      return c.json(result, 404);
    }
    if (result.status === "disabled") {
      return c.json(
        { error: "model switching is disabled (set MBA_MODEL_SWITCH=on to arm)" },
        409,
      );
    }
    if (result.status === "failed") {
      return c.json(result, 500);
    }
    return c.json(result);
  });

  app.post("/models/pull", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const input = body as { url?: unknown; id?: unknown; sha256?: unknown; family?: unknown };
    if (
      !input ||
      typeof input.url !== "string" ||
      input.url.length === 0 ||
      typeof input.id !== "string" ||
      input.id.length === 0 ||
      typeof input.sha256 !== "string" ||
      input.sha256.length === 0 ||
      (input.family !== undefined && typeof input.family !== "string")
    ) {
      return c.json(
        { error: "body requires url, id, sha256 (strings); family is an optional string" },
        400,
      );
    }
    try {
      const result = await pullModel({
        url: input.url,
        id: input.id,
        sha256: input.sha256,
        family: input.family,
        storeRoot: opts.adapterDir,
        fetch: opts.fetch,
      });
      return c.json(result);
    } catch (err) {
      if (err instanceof PullValidationError) return c.json({ error: err.message }, 400);
      if (err instanceof PullConflictError) return c.json({ error: err.message }, 409);
      if (err instanceof PullVerifyError) return c.json({ error: err.message }, 422);
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.get("/models/config", (c) => {
    const id = c.req.query("id");
    if (!id || id.length === 0) {
      return c.json({ error: "query param id is required" }, 400);
    }
    const dials = readModelDials(opts.adapterDir ?? "", id);
    if (!dials) {
      return c.json({ error: `unknown model: ${id}` }, 404);
    }
    return c.json(dials);
  });

  app.post("/models/config", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const input = body as {
      id?: unknown;
      file?: unknown;
      field?: unknown;
      value?: unknown;
    };
    if (
      !input ||
      typeof input !== "object" ||
      typeof input.id !== "string" ||
      input.id.length === 0 ||
      (input.file !== "server_setup" && input.file !== "client") ||
      typeof input.field !== "string" ||
      input.field.length === 0 ||
      input.value === undefined
    ) {
      return c.json(
        { error: "body must be { id, file: 'server_setup'|'client', field, value }" },
        400,
      );
    }
    const result = setModelDial(
      opts.adapterDir ?? "",
      input.id,
      input.file as ModelDialFile,
      input.field,
      input.value,
    );
    if (!result.ok) {
      const status = /unknown model/.test(result.error) ? 404 : 400;
      return c.json({ error: result.error }, status);
    }
    const entry = readModelCatalog(opts.adapterDir ?? "").find((e) => e.id === input.id);
    const loaded = entry
      ? await probeModelLoaded(entry, paths, opts.upstreamUrl, opts.fetch)
      : null;
    return c.json({
      file: result.file,
      field: result.field,
      before: result.before,
      after: result.after,
      restartRequired: result.restartRequired,
      modelFile: result.modelFile,
      modelLoaded: isLoadedPath(loaded, result.modelFile),
    });
  });

  // --- Server plane (ADR-0097 Phase 2) ------------------------------------

  app.get("/servers", async (c) => {
    const registry = readRegistry(paths.upstreamsPath);
    const fetchImpl = opts.fetch ?? fetch;
    // Per-type health (Phase 3): each entry is probed by its own type's
    // capability block (llama.cpp → /health on its port, ollama → /api/tags
    // on the daemon). Unknown types fall back to the port /health probe.
    const health = new Map<string, boolean>();
    await Promise.all(
      registry.map(async (e) => {
        const ops = getServerTypeOps(e.serverType);
        health.set(
          e.id,
          ops ? await ops.health(e, fetchImpl) : await probeServerHealth(e.port, fetchImpl),
        );
      }),
    );
    const healthyIds = new Set(
      registry.filter((e) => health.get(e.id)).map((e) => e.id),
    );
    const servers = registry.map((e) => {
      const resolved = resolveUpstream(registry, e.modelFile, healthyIds)?.id === e.id;
      // Q2 (Phase 3): a same-model entry that lost resolution is a labeled
      // duplicate — the CLI can say "you have two <model> servers".
      const duplicate = !resolved && listUpstreams(registry, e.modelFile).length > 1;
      return {
        id: e.id,
        serverType: e.serverType,
        modelFile: e.modelFile,
        port: e.port,
        pid: e.pid,
        startedAt: e.startedAt,
        healthy: health.get(e.id) ?? false,
        resolved,
        duplicate,
      };
    });
    return c.json({ servers });
  });

  app.post("/servers/boot", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const input = body as {
      serverType?: unknown;
      modelFile?: unknown;
      modelRef?: unknown;
      port?: unknown;
      fork?: unknown;
    };
    const serverType: ServerType =
      input.serverType === "ollama" ? "ollama" : "llama.cpp";
    if (input.serverType !== undefined && input.serverType !== "llama.cpp" && input.serverType !== "ollama") {
      return c.json({ error: "body.serverType must be 'llama.cpp' or 'ollama'" }, 400);
    }
    if (
      typeof input.port !== "number" ||
      !Number.isInteger(input.port) ||
      input.port <= 0 ||
      input.port > 65535
    ) {
      return c.json({ error: "body.port must be an integer 1-65535" }, 400);
    }
    // llama.cpp needs modelFile; ollama needs modelRef.
    if (serverType === "ollama") {
      if (typeof input.modelRef !== "string" || input.modelRef.length === 0) {
        return c.json({ error: "body.modelRef (model tag) is required for ollama" }, 400);
      }
    } else if (typeof input.modelFile !== "string" || input.modelFile.length === 0) {
      return c.json({ error: "body.modelFile is required for llama.cpp" }, 400);
    }
    if (
      input.fork !== undefined &&
      input.fork !== "upstream" &&
      input.fork !== "cachyllama"
    ) {
      return c.json({ error: "body.fork must be 'upstream' or 'cachyllama'" }, 400);
    }
    const result = await bootServer({
      serverType,
      modelFile: input.modelFile as string | undefined,
      modelRef: input.modelRef as string | undefined,
      port: input.port,
      fork: input.fork === "cachyllama" ? "cachyllama" : "upstream",
      adapterDir: opts.adapterDir ?? "",
      registryPath: paths.upstreamsPath,
      seams: opts.lifecycleSeams,
    });
    if (!result.ok) {
      const status =
        result.code === "port-busy" || result.code === "duplicate-model"
          ? 409
          : result.code === "unknown-model"
            ? 404
            : 500;
      return c.json({ error: result.error }, status);
    }
    // Persist the entry (merge, never clobber).
    const registry = readRegistry(paths.upstreamsPath);
    writeRegistry(paths.upstreamsPath, upsertEntry(registry, result.entry));
    return c.json(result.entry, 201);
  });

  app.post("/servers/stop", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const input = body as { id?: unknown; pid?: unknown };
    const hasId = typeof input?.id === "string" && (input.id as string).length > 0;
    const hasPid =
      typeof input?.pid === "number" &&
      Number.isInteger(input.pid) &&
      (input.pid as number) > 0;
    if (!hasId && !hasPid) {
      return c.json(
        { error: "body must be { id: string } (or legacy { pid: positive integer })" },
        400,
      );
    }
    const registry = readRegistry(paths.upstreamsPath);
    // Resolve the target entry: by id (type-agnostic) or by pid (legacy
    // llama.cpp path — Ollama entries have no pid).
    const entry = hasId
      ? registry.find((e) => e.id === input.id)
      : registry.find((e) => e.pid === input.pid);
    if (!entry) {
      return c.json({ error: `no registered server ${hasId ? `with id ${input.id}` : `with pid ${input.pid}`}` }, 404);
    }
    const ops = getServerTypeOps(entry.serverType);
    if (!ops) {
      return c.json({ error: `unknown server type ${entry.serverType}` }, 500);
    }
    try {
      await ops.stop(entry, opts.lifecycleSeams);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "stop failed" }, 500);
    }
    writeRegistry(paths.upstreamsPath, removeById(registry, entry.id));
    return c.json({ stopped: entry.id });
  });

  return app;
}

/**
 * Probe a server's /health endpoint. Unreachable or non-2xx → false (the
 * probe is advisory; a dead server is "not healthy", never an error).
 */
async function probeServerHealth(port: number, fetchImpl: typeof fetch): Promise<boolean> {
  try {
    const res = await fetchImpl(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Default switch executor: boots the model IN-DAEMON via the server plane
 * (ADR-0097 Phase 2), replacing the retired `llama-server-up.sh` shell-out.
 *
 * Port policy (G2): the boot script defaulted to 8080, so we do the same —
 * `MBA_SWITCH_PORT` overrides it. A busy port is refused (the boot reports
 * `port-busy`, which `ensureModel` surfaces as `failed`); pick a free port
 * with `mba servers boot <model> <port>` for an explicit choice.
 *
 * The shared `lifecycleSeams` (G1) is passed through so the booted group is
 * tracked and killed on daemon exit. Kept at module level so tests can always
 * inject a fake and the production path stays inspectable in one place.
 */
async function defaultSwitchExecutor(
  ctx: { id: string; modelFile?: string; upstreamUrl: string },
  opts: MbaServiceAppOptions,
): Promise<void> {
  const modelFile = ctx.modelFile;
  if (!modelFile) {
    throw new Error(`no model file resolved for ${ctx.id} — cannot boot in-daemon`);
  }
  const port = Number(process.env.MBA_SWITCH_PORT ?? 8080);
  const result = await bootServer({
    modelFile,
    port,
    adapterDir: opts.adapterDir ?? "",
    registryPath: (opts.paths ?? defaultStorePaths()).upstreamsPath,
    seams: opts.lifecycleSeams,
  });
  if (!result.ok) {
    throw new Error(result.error);
  }
  const registry = readRegistry((opts.paths ?? defaultStorePaths()).upstreamsPath);
  writeRegistry(
    (opts.paths ?? defaultStorePaths()).upstreamsPath,
    upsertEntry(registry, result.entry),
  );
}

/**
 * Probe whether `entry`'s model is loaded, resolving the probe target per
 * model (ADR-0097 Phase 1): upstream registry → adapter `client.url` →
 * `MBA_UPSTREAM_URL` → "not loaded".
 *
 * Lazy validation (G2): the registry is read once per call; candidates are
 * probed in resolve order (most-recently-booted first) and a dead or stale
 * entry is dropped on read — the next candidate, then the next rung, is
 * tried. No sweeper, no timers.
 */
async function probeModelLoaded(
  entry: CatalogEntry,
  paths: MbaStorePaths,
  envUrl: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const registry = readRegistry(paths.upstreamsPath);
  // Registry rung: walk candidates in resolve order; a candidate that is
  // alive but running a DIFFERENT model is stale (rebooted since sign-in)
  // and is dropped too.
  for (const candidate of entry.modelFile ? listUpstreams(registry, entry.modelFile) : []) {
    const probed = await probeLoadedModel(`http://127.0.0.1:${candidate.port}`, fetchImpl);
    if (probed !== null && isLoadedPath(probed, entry.modelFile)) return probed;
  }
  // YAML rung: the adapter's own client.url (trailing /v1 stripped).
  if (entry.clientUrl) {
    const probed = await probeLoadedModel(entry.clientUrl.replace(/\/v1\/?$/, ""), fetchImpl);
    if (probed !== null && isLoadedPath(probed, entry.modelFile)) return probed;
  }
  // Env rung: the legacy single-upstream knob.
  if (envUrl) {
    const probed = await probeLoadedModel(envUrl, fetchImpl);
    if (probed !== null && isLoadedPath(probed, entry.modelFile)) return probed;
  }
  return null;
}

export interface MbaServiceHandle {
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
}

/**
 * Bind the service to 127.0.0.1 on an OS-assigned port (port 0). Resolves
 * with the actual port once the listener is up, so the caller (or a
 * supervisor) can discover it.
 */
export function startMbaService(opts: MbaServiceAppOptions = {}): Promise<MbaServiceHandle> {
  const app = createMbaServiceApp(opts);
  return new Promise<MbaServiceHandle>((resolve, reject) => {
    let settled = false;
    const server = serve(
      { fetch: app.fetch, hostname: "127.0.0.1", port: 0 },
      (info) => {
        settled = true;
        resolve({
          port: info.port,
          url: `http://127.0.0.1:${info.port}`,
          close: () =>
            new Promise<void>((res, rej) => {
              server.close((err) => (err ? rej(err) : res()));
            }),
        });
      },
    );
    // serve() surfaces bind errors via the server's 'error' event.
    server.on("error", (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
  });
}
