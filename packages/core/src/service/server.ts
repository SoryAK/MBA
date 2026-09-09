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
 *   POST /models/pull                → SSE stream (text/event-stream)
 *        Body: { url, id, sha256?, family? }. One-command model onboarding
 *        (ADR-0098): download (resume + sha256 verify) → parse GGUF header →
 *        scaffold the two-tier binding structure. `url` may be a HuggingFace
 *        repo shorthand (owner/repo[:file-or-quant]) or resolve URL; when
 *        `sha256` is omitted it is resolved from the repo's published LFS
 *        metadata (ADR-0099) — other hosts require an explicit digest.
 *        The download runs in the daemon, so progress is streamed back to the
 *        caller as SSE events: `progress` ({ downloaded, total }) per chunk,
 *        then a terminal `done` ({ result: PullModelResult }) or `error`
 *        ({ message }) event. Every failure mode (bad input, folder exists,
 *        sha256 mismatch, download failure) arrives as an `error` event —
 *        the HTTP status is 200 for the whole stream; the CLI renders the
 *        message and exits non-zero.
 *   GET  /models/config?id=<id>      → { modelId, files, fields: [{ field, file, current, restartRequired, hint?, machineHint? }] }
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
import { streamSSE } from "hono/streaming";
import { serve } from "@hono/node-server";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  defaultStorePaths,
  isMachineOverlayMode,
  MACHINE_OVERLAY_MODES,
  readGlobalConfig,
  setMachineOverlay,
  setRules,
  type MachineOverlayMode,
  type MbaStorePaths,
} from "./config-store.js";
import { openBcbDb } from "../bcb/kill-state.js";
import { isToolCircuitBreakerConfig } from "../bcb/is-config.js";
import { isRuleClassRegistry, type RuleClassRegistry } from "../bcb/rule-classes.js";
import type { ToolCircuitBreakerConfig } from "../bcb/types.js";
import { readModelCatalog, type CatalogEntry } from "./model-catalog.js";
import { readMachineInfo } from "./machine-store.js";
import {
  ensureModel,
  isLoadedPath,
  probeLoadedModel,
  type SwitchExecutor,
} from "./model-switch.js";
import { readModelDials, setModelDial, type ModelDialFile } from "./model-config.js";
import { createModelProxyRoutes } from "./model-proxy.js";
import { reasoningGateForModel } from "./reasoning-gate.js";
import { pullModel } from "../model/model-pull.js";
import {
  listUpstreams,
  readRegistry,
  removeById,
  resolveUpstream,
  upsertEntry,
  writeRegistry,
} from "./upstream-registry.js";
import { bootServer, resolveBootRecipe } from "./server-boot.js";
import {
  gpuVendors,
  ignoreLlamaServer,
  inspectLlamaBackend,
  llamaBootBinaryError,
  llamaServerCatalogView,
  nicknameLlamaServer,
  readLlamaServerChoice,
  refreshLlamaServerCatalog,
  restoreLlamaServer,
  selectLlamaServer,
  useLlamaServer,
  writeLlamaServerChoice,
} from "./llama-binaries.js";
import { getServerTypeOps, type ServerType } from "./server-types.js";
import type { MachineInfo } from "./machine-info.js";
import { getLogBuffer, type LifecycleSeams } from "../mba/index.js";
import {
  SlotFilenameError,
  SlotOpError,
  SlotUnsupportedError,
  slotDirForEntry,
  type SlotAction,
} from "../mba/slot-control.js";

export interface MbaServiceAppOptions {
  readonly paths?: MbaStorePaths;
  /** Adapter tree root (default: OS-aware model store, see service/paths.ts). */
  readonly adapterDir?: string;
  /** Upstream llama-server base URL (e.g. `http://127.0.0.1:8080`). */
  readonly upstreamUrl?: string;
  /** Proxy health-probe cache TTL in ms (default 5000). */
  readonly healthTtlMs?: number;
  /** Arm model switching (ADR-0093: OFF by default). */
  readonly switchEnabled?: boolean;
  /** Switch executor — injectable for tests; default boots in-daemon via the server plane. */
  readonly switchExecutor?: SwitchExecutor;
  /** Injectable fetch for the upstream probe (tests). */
  readonly fetch?: typeof fetch;
  /**
   * Shared lifecycle seams (spawn/fetch/kill). The G1 owned-group registry
   * lives on this instance, so the daemon must pass ONE instance for its
   * lifetime and call `killAllOwnedGroups` on exit.
   */
  readonly lifecycleSeams?: LifecycleSeams;
  /**
   * TCB config getter (ADR-0101 Step 2). Injectable for tests. When omitted,
   * the daemon reads the global TCB config on every request (so a
   * `/set_rules` mutation is picked up without a restart).
   */
  readonly tcbConfig?: () => ToolCircuitBreakerConfig;
  /**
   * Kill-state DB handle (ADR-0101 Step 2). Injectable for tests. When
   * omitted, the daemon opens `bcb-kill-state.db` under its baseDir.
   */
  readonly bcbDb?: DatabaseSync;
  /** Detected/persisted machine profile for recipe clamping (ADR-0103). */
  readonly machineInfo?: MachineInfo;
  /**
   * Machine-overlay enforcement mode getter. When omitted, the daemon reads
   * the global config on every boot so a `/config/machine-overlay` mutation
   * is picked up without a restart.
   */
  readonly machineOverlay?: () => MachineOverlayMode;
}

export function createMbaServiceApp(opts: MbaServiceAppOptions = {}): Hono {
  const paths = opts.paths ?? defaultStorePaths();
  const startedAt = Date.now();

  const app = new Hono();

  // --- Model-request proxy (ADR-0101 Step 1b — registry routing) ----------
  // The daemon IS the proxy: model requests arrive at /v1/chat/completions
  // and are resolved PER REQUEST from the upstream registry by the request's
  // `model` field (TTL-cached health probes), then piped verbatim to the
  // matching server. `MBA_UPSTREAM_URL` is a fallback for the empty-registry
  // (dumb-proxy) case only.
  // TCB intervention (ADR-0101 Step 2): the daemon owns the escalation
  // kill-state. Both seams are injectable for tests; the daemon defaults are
  // a per-request global-config read (so a /set_rules mutation is picked up
  // without a restart) and a kill-state DB under the baseDir.
  const tcbConfig = opts.tcbConfig ?? (() => readGlobalConfig(paths).tcb);
  const machineOverlay =
    opts.machineOverlay ?? (() => readGlobalConfig(paths).machineOverlay);
  const bcbDb = opts.bcbDb ?? openBcbDb(join(paths.baseDir, "bcb-kill-state.db"));

  app.route(
    "/v1",
    createModelProxyRoutes({
      upstreamUrl: opts.upstreamUrl,
      registryPath: paths.upstreamsPath,
      adapterDir: opts.adapterDir,
      healthTtlMs: opts.healthTtlMs,
      fetch: opts.fetch,
      tcbConfig,
      bcbDb,
      reasoningGate: (model) => reasoningGateForModel(model, opts.adapterDir),
    }),
  );

  app.get("/resolve_config", (c) => {
    const model = c.req.query("model");
    const cfg = readGlobalConfig(paths);
    return c.json({
      version: cfg.version,
      model: model ?? null,
      tcb: cfg.tcb,
      ruleClasses: cfg.ruleClasses,
      machineOverlay: cfg.machineOverlay,
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

  app.get("/config/machine-overlay", (c) => {
    const cfg = readGlobalConfig(paths);
    return c.json({ mode: cfg.machineOverlay });
  });

  app.post("/config/machine-overlay", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const input = body as { mode?: unknown };
    if (!input || typeof input !== "object" || !isMachineOverlayMode(input.mode)) {
      return c.json(
        { error: `body.mode must be one of ${MACHINE_OVERLAY_MODES.join(", ")}` },
        400,
      );
    }
    try {
      const result = setMachineOverlay(paths, input.mode);
      return c.json({ mode: result.machineOverlay, version: result.version });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "set_machine_overlay failed" },
        500,
      );
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
        machineOverlayPath: paths.machineOverlayPath,
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
      (input.sha256 !== undefined && typeof input.sha256 !== "string") ||
      (input.family !== undefined && typeof input.family !== "string")
    ) {
      return c.json(
        { error: "body requires url, id (strings); sha256 and family are optional strings" },
        400,
      );
    }
    // Narrow to the validated shapes so the SSE closure sees concrete types.
    const url = input.url;
    const id = input.id;
    const sha256 = input.sha256;
    const family = input.family;
    // The download runs in the daemon, so progress is streamed back to the
    // caller as SSE: `progress` events while bytes arrive, then a terminal
    // `done` (result) or `error` event. Validation errors that are known
    // before the download starts are returned as plain JSON with their status
    // code (the CLI checks content-type to tell the two apart).
    return streamSSE(c, async (stream) => {
      // Throttle progress events to ~4/s so a fast local download does not
      // flood the stream; the terminal event is always sent.
      let lastEmit = 0;
      try {
        const result = await pullModel({
          url,
          id,
          sha256,
          family,
          storeRoot: opts.adapterDir,
          fetch: opts.fetch,
          onProgress: (downloaded, total) => {
            const now = Date.now();
            if (now - lastEmit < 250 && total !== null && downloaded < total) return;
            lastEmit = now;
            void stream.writeSSE({ data: JSON.stringify({ type: "progress", downloaded, total }) });
          },
        });
        await stream.writeSSE({ data: JSON.stringify({ type: "done", result }) });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await stream.writeSSE({ data: JSON.stringify({ type: "error", message }) });
      }
    });
  });

  app.get("/models/config", (c) => {
    const id = c.req.query("id");
    if (!id || id.length === 0) {
      return c.json({ error: "query param id is required" }, 400);
    }
    const machineInfo = readMachineInfo(paths);
    const dials = readModelDials(opts.adapterDir ?? "", id, machineInfo ?? undefined);
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
        fork: e.fork,
        pid: e.pid,
        startedAt: e.startedAt,
        healthy: health.get(e.id) ?? false,
        resolved,
        duplicate,
      };
    });
    return c.json({ servers });
  });

  app.get("/servers/binaries", (c) => {
    return c.json(llamaServerCatalogView(paths));
  });

  app.post("/servers/binaries", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const input = body as { action?: unknown; path?: unknown; nickname?: unknown };
    const path = typeof input.path === "string" ? input.path : "";
    try {
      if (input.action === "rescan") {
        refreshLlamaServerCatalog(paths);
      } else if (input.action === "nickname") {
        if (path.length === 0) return c.json({ error: "body.path is required" }, 400);
        if (typeof input.nickname !== "string") return c.json({ error: "body.nickname is required" }, 400);
        nicknameLlamaServer(paths, path, input.nickname);
      } else if (input.action === "remove") {
        if (path.length === 0) return c.json({ error: "body.path is required" }, 400);
        ignoreLlamaServer(paths, path);
      } else if (input.action === "restore") {
        if (path.length === 0) return c.json({ error: "body.path is required" }, 400);
        restoreLlamaServer(paths, path);
      } else if (input.action === "use") {
        if (path.length === 0) return c.json({ error: "body.path is required" }, 400);
        useLlamaServer(paths, path);
      } else {
        return c.json({ error: "body.action must be nickname, remove, restore, use, or rescan" }, 400);
      }
      return c.json(llamaServerCatalogView(paths));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = message.includes("not in catalog") || message.includes("not removed") ? 404 : 400;
      return c.json({ error: message }, status);
    }
  });

  // GET /servers/logs?id=<id>&lines=<n> — the captured ring buffer for one
  // booted server (Feature 2). The daemon pipes each owned llama-server's
  // stdout/stderr into a per-port ring buffer; this route reads it. `lines`
  // returns the last N lines (all when omitted). 404 for an unknown id.
  // API-managed servers (ollama) have no owned process → no buffer → empty.
  app.get("/servers/logs", (c) => {
    const id = c.req.query("id");
    if (!id) {
      return c.json({ error: "query param 'id' is required" }, 400);
    }
    const registry = readRegistry(paths.upstreamsPath);
    const entry = registry.find((e) => e.id === id);
    if (!entry) {
      return c.json({ error: `no registered server with id ${id}` }, 404);
    }
    const linesParam = c.req.query("lines");
    let n: number | undefined;
    if (linesParam !== undefined) {
      const parsed = Number(linesParam);
      if (!Number.isInteger(parsed) || parsed < 0) {
        return c.json({ error: "query param 'lines' must be a non-negative integer" }, 400);
      }
      n = parsed;
    }
    const buffer = getLogBuffer(entry.port, opts.lifecycleSeams ?? {});
    const lines = buffer ? buffer.lines(n) : [];
    return c.json({ id, lines });
  });

  // Pre-boot recipe preview (ADR-0100 companion): resolve the effective
  // llama.cpp flags for a weights file WITHOUT booting. Runs the exact
  // resolveBootRecipe chain the boot path uses, so the flags the CLI prints
  // are provably the bytes that get spawned. Lets the user verify their
  // server_setup.json dials (incl. extraArgs) before the slow boot starts.
  app.post("/servers/resolve", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const input = body as { modelFile?: unknown };
    if (typeof input.modelFile !== "string" || input.modelFile.length === 0) {
      return c.json({ error: "body.modelFile is required" }, 400);
    }
    try {
      const recipe = resolveBootRecipe(
        input.modelFile,
        opts.adapterDir ?? "",
        opts.machineInfo,
        machineOverlay(),
      );
      const selection = selectLlamaServer({
        lastPath: readLlamaServerChoice(paths)?.path,
        machineInfo: opts.machineInfo,
        paths,
      });
      return c.json({
        modelId: recipe.modelId,
        modelFile: recipe.modelFile,
        cliArgs: recipe.cliArgs,
        warmupTokens: recipe.warmupTokens,
        binary: selection.selected,
        binaries: selection.catalog,
        recommended: selection.recommended,
        pinned: selection.pinned,
        warning: selection.warning,
        vendors: [...gpuVendors(opts.machineInfo)],
        gpus: (opts.machineInfo?.gpus ?? [])
          .map((g) => g.name)
          .filter((n): n is string => typeof n === "string" && n.length > 0),
      });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "recipe resolution failed" },
        404,
      );
    }
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
      binaryPath?: unknown;
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
      input.fork !== "llama.cpp"
    ) {
      return c.json({ error: "body.fork must be 'upstream' or 'llama.cpp'" }, 400);
    }
    const selection = selectLlamaServer({
      lastPath: readLlamaServerChoice(paths)?.path,
      machineInfo: opts.machineInfo,
      paths,
    });
    if (typeof input.binaryPath === "string" && input.binaryPath.length > 0) {
      const binaryErr = llamaBootBinaryError(paths, input.binaryPath);
      if (binaryErr) return c.json({ error: binaryErr }, 400);
    }
    const binaryPath =
      typeof input.binaryPath === "string" && input.binaryPath.length > 0
        ? input.binaryPath
        : selection.selected?.path;
    const result = await bootServer({
      serverType,
      modelFile: input.modelFile as string | undefined,
      modelRef: input.modelRef as string | undefined,
      port: input.port,
      fork: input.fork === "llama.cpp" ? "llama.cpp" : "upstream",
      adapterDir: opts.adapterDir ?? "",
      registryPath: paths.upstreamsPath,
      binaryPath,
      machineInfo: opts.machineInfo,
      machineOverlay: machineOverlay(),
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
    if (typeof binaryPath === "string" && binaryPath.length > 0) {
      writeLlamaServerChoice(paths, {
        path: binaryPath,
        backend: inspectLlamaBackend(binaryPath),
      });
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

  // Slot / KV control (ADR-0097 Phase 4). llama.cpp only. Filenames stay
  // inside the G3 dir this server was booted with.
  app.get("/servers/slots", async (c) => {
    const id = c.req.query("id");
    if (!id) {
      return c.json({ error: "query param 'id' is required" }, 400);
    }
    const registry = readRegistry(paths.upstreamsPath);
    const entry = registry.find((e) => e.id === id);
    if (!entry) {
      return c.json({ error: `no registered server with id ${id}` }, 404);
    }
    const ops = getServerTypeOps(entry.serverType);
    if (!ops) {
      return c.json({ error: `unknown server type ${entry.serverType}` }, 500);
    }
    const fetchImpl = opts.lifecycleSeams?.fetchImpl ?? opts.fetch ?? fetch;
    try {
      const slots = await ops.listSlots(entry, fetchImpl);
      return c.json({ id: entry.id, dir: slotDirForEntry(entry), slots });
    } catch (err) {
      if (err instanceof SlotUnsupportedError) {
        return c.json({ error: err.message }, 400);
      }
      return c.json({ error: err instanceof Error ? err.message : "list slots failed" }, 502);
    }
  });

  app.post("/servers/slots", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const input = body as {
      id?: unknown;
      action?: unknown;
      slotId?: unknown;
      filename?: unknown;
    };
    if (typeof input.id !== "string" || input.id.length === 0) {
      return c.json({ error: "body.id is required" }, 400);
    }
    if (input.action !== "save" && input.action !== "restore" && input.action !== "erase") {
      return c.json({ error: "body.action must be 'save', 'restore', or 'erase'" }, 400);
    }
    const action: SlotAction = input.action;
    if (
      input.slotId !== undefined &&
      (typeof input.slotId !== "number" || !Number.isInteger(input.slotId) || input.slotId < 0)
    ) {
      return c.json({ error: "body.slotId must be a non-negative integer" }, 400);
    }
    if (
      input.filename !== undefined &&
      (typeof input.filename !== "string" || input.filename.length === 0)
    ) {
      return c.json({ error: "body.filename must be a non-empty string" }, 400);
    }
    const registry = readRegistry(paths.upstreamsPath);
    const entry = registry.find((e) => e.id === input.id);
    if (!entry) {
      return c.json({ error: `no registered server with id ${input.id}` }, 404);
    }
    const ops = getServerTypeOps(entry.serverType);
    if (!ops) {
      return c.json({ error: `unknown server type ${entry.serverType}` }, 500);
    }
    const fetchImpl = opts.lifecycleSeams?.fetchImpl ?? opts.fetch ?? fetch;
    try {
      const result = await ops.slots(
        entry,
        {
          action,
          slotId: typeof input.slotId === "number" ? input.slotId : undefined,
          filename: typeof input.filename === "string" ? input.filename : undefined,
        },
        { ...opts.lifecycleSeams, fetchImpl },
      );
      return c.json(result);
    } catch (err) {
      if (err instanceof SlotUnsupportedError || err instanceof SlotFilenameError) {
        return c.json({ error: err.message }, 400);
      }
      if (err instanceof SlotOpError) {
        return c.json({ error: err.message }, 502);
      }
      return c.json({ error: err instanceof Error ? err.message : "slot op failed" }, 500);
    }
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
    machineInfo: opts.machineInfo,
    machineOverlay: readGlobalConfig(opts.paths ?? defaultStorePaths()).machineOverlay,
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
  /** The hono app, exposed so the daemon can also serve it over a UDS. */
  readonly app: Hono;
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
          app,
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
