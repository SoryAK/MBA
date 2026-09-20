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
 *   GET  /status                     → one house snapshot
 *        Pairing, registry, machine overlay, models, servers, and watches.
 *        Corrupt pairing/registry stay blocked. GET /models and GET /servers
 *        remain focused doors over the same list helpers.
 *
 * Model plane (ADR-0093 Phase 1):
 *   GET  /models                     → { models: [{ id, name, family, modelFile, loaded, notes? }] }
 *        Always on, read-only. Catalog from the adapter tree + live loaded
 *        state probed from the upstream llama-server. `notes` is a picker
 *        glance (`empty`, `excerpt`); omit when there is no winning file.
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
 *   POST /models/adopt               → SSE stream (text/event-stream)
 *        Body: { path, id, family?, move? }. Copy (or hardlink) a local GGUF
 *        into the model store and finish the same house as pull. `move`
 *        unlinks the source after success (not when source is already dest).
 *        Same progress events as pull while a cross-device copy runs.
 *        Hardlink / clone skip progress. 400 bad body; missing source,
 *        folder exists, and copy failures arrive as SSE `error`.
 *   GET  /models/config?id=<id>      → { modelId, files, fields, notes?, instructions? }
 *   POST /models/config              → { file, field, before, after, restartRequired, modelLoaded }
 *        Body: { id, file: 'server_setup'|'client', field, value }. The
 *        per-model dial write door (ADR-0096): validates and writes ONE
 *        field via the model-config capability block. 404 unknown model,
 *        400 invalid field/value. REPORTS `modelLoaded` (probed from the
 *        upstream) so the caller can offer a restart — the route never
 *        restarts anything itself.
 *   GET  /models/watches?id=<id>     → { modelId, watches: [{ id, mode, effective, … }] }
 *        Known read_file watches (clamp / eof / loop). Omit id for the
 *        global seed (all inherit, all on). Empty tcb.jsonl is inherit.
 *   POST /models/watches             → { modelId, watch, before, after }
 *        Body: { id, watch, mode: inherit|off|on }. Writes model tcb.jsonl.
 *   GET  /models/history?id=<id>     → { modelId, events: [{ ts, kind, tool, … }] }
 *        Per-model tool + trip ledger. `lines` is last N (default 100).
 *        400 missing id / bad lines, 404 unknown model. Empty ledger is [].
 *   POST /models/stage               → { modelId, action, envelope, dest, source?, reason? }
 *        Body: { id, projectRoot, harness, ide? }. Copy the winning
 *        `instructions.md` into a harness-native file in the project.
 *        Empty cards are not staged. `notes.md` never leaves the store.
 *        404 unknown model, 409 dest exists and is not MBA-staged.
 *   POST /connect                    → { token, modelId, harness, projectRoot, stage }
 *        Body: { id, projectRoot, harness, ide? }. Stage the card (best
 *        effort) and mint a pairing token. Once any session exists, chat
 *        through the proxy requires `Authorization: Bearer <token>`.
 *   POST /connect/revoke             → { pairing: { active, count } }
 *        Body: { id?, harness?, projectRoot? }. Empty body clears all.
 *
 * The app is exported separately from the listener so tests can drive it
 * with `app.request()` without binding a port. This file is the composition
 * root. Handlers live in `routes-house.ts`, `routes-models.ts`,
 * `routes-connect.ts`, `routes-servers.ts`, and `model-proxy.ts`.
 */

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { join } from "node:path";
import { openBcbDb } from "../bcb/kill-state.js";
import { defaultStorePaths, readGlobalConfig } from "./config-store.js";
import { createModelProxyRoutes } from "./model-proxy.js";
import { openModelHistoryDb } from "./model-history.js";
import {
  type MbaServiceAppOptions,
  type ServiceRouteContext,
} from "./route-context.js";
import { registerConnectRoutes } from "./routes-connect.js";
import { registerHouseRoutes } from "./routes-house.js";
import { registerModelRoutes } from "./routes-models.js";
import { registerServerRoutes } from "./routes-servers.js";

export type { MbaServiceAppOptions } from "./route-context.js";

export function createMbaServiceApp(opts: MbaServiceAppOptions = {}): Hono {
  const paths = opts.paths ?? defaultStorePaths();
  const startedAt = Date.now();
  const app = new Hono();

  // The daemon IS the proxy: /v1/chat/completions resolves per request
  // from the upstream registry. TCB and kill-state are injectable.
  const tcbConfig = opts.tcbConfig ?? (() => readGlobalConfig(paths).tcb);
  const machineOverlay =
    opts.machineOverlay ?? (() => readGlobalConfig(paths).machineOverlay);
  const bcbDb = opts.bcbDb ?? openBcbDb(join(paths.baseDir, "bcb-kill-state.db"));
  const historyDb = opts.historyDb ?? openModelHistoryDb(paths.modelHistoryPath);

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
      historyDb,
      sessionsPath: paths.sessionsPath,
    }),
  );

  const ctx: ServiceRouteContext = {
    paths,
    opts,
    startedAt,
    machineOverlay,
    historyDb,
  };
  registerHouseRoutes(app, ctx);
  registerModelRoutes(app, ctx);
  registerConnectRoutes(app, ctx);
  registerServerRoutes(app, ctx);
  return app;
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
    server.on("error", (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
  });
}
