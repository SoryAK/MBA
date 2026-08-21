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
import { readModelCatalog } from "./model-catalog.js";
import { ensureModel, probeLoadedModel, type SwitchExecutor } from "./model-switch.js";

export interface MbaServiceAppOptions {
  readonly paths?: MbaStorePaths;
  /** Per-project TCB path to migrate from on first boot (Option A). */
  readonly legacyTcbPath?: string;
  /** Adapter tree root (default `~/models/adapters`). */
  readonly adapterDir?: string;
  /** Upstream llama-server base URL (e.g. `http://127.0.0.1:8080`). */
  readonly upstreamUrl?: string;
  /** Arm model switching (ADR-0093: OFF by default). */
  readonly switchEnabled?: boolean;
  /** Switch executor — injectable for tests; default shells to the boot script. */
  readonly switchExecutor?: SwitchExecutor;
  /** Injectable fetch for the upstream probe (tests). */
  readonly fetch?: typeof fetch;
}

export function createMbaServiceApp(opts: MbaServiceAppOptions = {}): Hono {
  const paths = opts.paths ?? defaultStorePaths();
  const startedAt = Date.now();

  const app = new Hono();

  app.get("/resolve_config", (c) => {
    const model = c.req.query("model");
    const cfg = readGlobalConfig(paths, { legacyTcbPath: opts.legacyTcbPath });
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
    const cfg = readGlobalConfig(paths, { legacyTcbPath: opts.legacyTcbPath });
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
    const loaded = opts.upstreamUrl
      ? await probeLoadedModel(opts.upstreamUrl, opts.fetch)
      : null;
    return c.json({
      models: catalog.map((e) => ({
        id: e.id,
        name: e.name,
        family: e.family,
        modelFile: e.modelFile,
        loaded: loaded === e.id,
      })),
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
      executor: opts.switchExecutor ?? defaultSwitchExecutor,
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

  return app;
}

/**
 * Default switch executor: shells out to the boot script. Kept at module
 * level (not inlined) so tests can always inject a fake and the production
 * path stays inspectable in one place.
 */
async function defaultSwitchExecutor(ctx: {
  id: string;
  modelFile?: string;
  upstreamUrl: string;
}): Promise<void> {
  const { spawn } = await import("node:child_process");
  const { homedir } = await import("node:os");
  const { join } = await import("node:path");
  const script =
    process.env.MBA_BOOT_SCRIPT ?? join(homedir(), "Dev_Projects/C-Yard/scripts/llama-server-up.sh");
  await new Promise<void>((resolve, reject) => {
    const child = spawn("bash", [script, "-Model", ctx.id], {
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`boot script exited ${code}`)),
    );
  });
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
