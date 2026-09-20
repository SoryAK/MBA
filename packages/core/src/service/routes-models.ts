/**
 * Model-plane doors (ADR-0093): catalog, ensure, pull, adopt, config, watches,
 * history, stage.
 */

import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { readModelCatalog } from "./model-catalog.js";
import { readMachineInfo } from "./machine-store.js";
import { ensureModel, isLoadedPath } from "./model-switch.js";
import { readModelDials, setModelDial, type ModelDialFile } from "./model-config.js";
import {
  defaultWatches,
  parseWatchId,
  parseWatchMode,
  readModelWatches,
  setModelWatch,
} from "./model-watches.js";
import { operatorEnvelopeBindings } from "./operator-clients.js";
import { readSessions, sessionsSharingSlot } from "./sessions.js";
import { restagePairedSlotsForModel, stageModelCard } from "./stage-model-card.js";
import { listCatalogModels, probeModelLoaded } from "./status-snapshot.js";
import { adoptLocalGguf, pullModel } from "../model/model-pull.js";
import {
  DEFAULT_HISTORY_LIMIT,
  queryModelHistory,
  toHistoryEvent,
} from "./model-history.js";
import { withHouseLock } from "./house-lock.js";
import { bootServer } from "./server-boot.js";
import { readGlobalConfig, defaultStorePaths } from "./config-store.js";
import { readRegistry, upsertEntry, writeRegistry } from "./upstream-registry.js";
import type { MbaServiceAppOptions, ServiceRouteContext } from "./route-context.js";

export function registerModelRoutes(app: Hono, ctx: ServiceRouteContext): void {
  const { paths, opts, historyDb } = ctx;

  app.get("/models", async (c) => {
    return c.json({
      models: await listCatalogModels({
        adapterDir: opts.adapterDir ?? "",
        paths,
        upstreamUrl: opts.upstreamUrl,
        fetch: opts.fetch,
      }),
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
    const sessionState = readSessions(paths.sessionsPath);
    if (sessionState.kind === "corrupt") {
      return c.json(
        {
          code: "sessions-corrupt",
          error: `sessions state is corrupt — ${sessionState.error}`,
        },
        503,
      );
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
    const stage = restagePairedSlotsForModel({
      adapterDir: opts.adapterDir ?? "",
      modelId: result.id,
      sessions: sessionState.sessions,
      envelopes: operatorEnvelopeBindings(paths.clientsPath),
    });
    return c.json(stage.length > 0 ? { ...result, stage } : result);
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

  app.post("/models/adopt", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const input = body as { path?: unknown; id?: unknown; family?: unknown; move?: unknown };
    if (
      !input ||
      typeof input.path !== "string" ||
      input.path.length === 0 ||
      typeof input.id !== "string" ||
      input.id.length === 0 ||
      (input.family !== undefined && typeof input.family !== "string") ||
      (input.move !== undefined && typeof input.move !== "boolean")
    ) {
      return c.json(
        { error: "body requires path, id (strings); family is an optional string; move is an optional boolean" },
        400,
      );
    }
    const sourcePath = input.path;
    const id = input.id;
    const family = input.family;
    const move = input.move;
    return streamSSE(c, async (stream) => {
      let lastEmit = 0;
      try {
        const result = await adoptLocalGguf({
          sourcePath,
          id,
          family,
          move,
          storeRoot: opts.adapterDir,
          onProgress: (written, total) => {
            const now = Date.now();
            if (now - lastEmit < 250 && written < total) return;
            lastEmit = now;
            void stream.writeSSE({
              data: JSON.stringify({ type: "progress", downloaded: written, total }),
            });
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

  app.get("/models/watches", (c) => {
    const id = c.req.query("id");
    if (!id || id.length === 0) {
      return c.json(defaultWatches());
    }
    const watches = readModelWatches(opts.adapterDir ?? "", id);
    if (!watches) {
      return c.json({ error: `unknown model: ${id}` }, 404);
    }
    return c.json(watches);
  });

  app.post("/models/watches", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const input = body as { id?: unknown; watch?: unknown; mode?: unknown };
    if (
      !input ||
      typeof input !== "object" ||
      typeof input.id !== "string" ||
      input.id.length === 0 ||
      typeof input.watch !== "string" ||
      typeof input.mode !== "string"
    ) {
      return c.json({ error: "body must be { id, watch, mode }" }, 400);
    }
    const watch = parseWatchId(input.watch);
    const mode = parseWatchMode(input.mode);
    if (!watch) {
      return c.json({ error: "watch must be clamp, eof, or loop" }, 400);
    }
    if (!mode) {
      return c.json({ error: "mode must be inherit, off, or on" }, 400);
    }
    const result = setModelWatch(opts.adapterDir ?? "", input.id, watch, mode);
    if ("error" in result) {
      return c.json({ error: result.error }, result.status);
    }
    return c.json(result);
  });

  app.get("/models/history", (c) => {
    const id = c.req.query("id");
    if (!id || id.length === 0) {
      return c.json({ error: "query param id is required" }, 400);
    }
    const catalog = readModelCatalog(opts.adapterDir ?? "");
    if (!catalog.some((e) => e.id === id)) {
      return c.json({ error: `unknown model: ${id}` }, 404);
    }
    const linesParam = c.req.query("lines");
    let limit = DEFAULT_HISTORY_LIMIT;
    if (linesParam !== undefined) {
      const parsed = Number(linesParam);
      if (!Number.isInteger(parsed) || parsed < 0) {
        return c.json({ error: "query param 'lines' must be a non-negative integer" }, 400);
      }
      limit = parsed;
    }
    const events = queryModelHistory(historyDb, id, { limit }).map(toHistoryEvent);
    return c.json({ modelId: id, events });
  });

  app.post("/models/stage", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const input = body as {
      id?: unknown;
      projectRoot?: unknown;
      harness?: unknown;
      ide?: unknown;
    };
    if (
      !input ||
      typeof input !== "object" ||
      typeof input.id !== "string" ||
      input.id.length === 0 ||
      typeof input.projectRoot !== "string" ||
      input.projectRoot.length === 0 ||
      typeof input.harness !== "string" ||
      input.harness.length === 0 ||
      (input.ide !== undefined && typeof input.ide !== "string")
    ) {
      return c.json(
        { error: "body must be { id, projectRoot, harness, ide? }" },
        400,
      );
    }
    const sessionState = readSessions(paths.sessionsPath);
    if (sessionState.kind === "corrupt") {
      return c.json(
        {
          code: "sessions-corrupt",
          error: `sessions state is corrupt — ${sessionState.error}`,
        },
        503,
      );
    }
    const envelopes = operatorEnvelopeBindings(paths.clientsPath);
    const slotPeers = sessionsSharingSlot(
      sessionState.sessions,
      input.harness,
      input.projectRoot,
    )
      .map((s) => s.modelId)
      .filter((id) => id !== input.id);
    const result = stageModelCard({
      adapterDir: opts.adapterDir ?? "",
      modelId: input.id,
      projectRoot: input.projectRoot,
      harness: input.harness,
      ide: typeof input.ide === "string" && input.ide.length > 0 ? input.ide : undefined,
      envelopes,
      slotPeers,
    });
    if (!result.ok) {
      const status =
        result.code === "unknown-model"
          ? 404
          : result.code === "conflict"
            ? 409
            : 400;
      return c.json({ error: result.error, code: result.code }, status);
    }
    return c.json({
      modelId: result.modelId,
      action: result.action,
      reason: result.reason,
      envelope: result.envelope,
      dest: result.dest,
      source: result.source,
    });
  });
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
  const registryPath = (opts.paths ?? defaultStorePaths()).upstreamsPath;
  await withHouseLock(registryPath, async () => {
    const result = await bootServer({
      modelFile,
      port,
      adapterDir: opts.adapterDir ?? "",
      registryPath,
      machineInfo: opts.machineInfo,
      machineOverlay: readGlobalConfig(opts.paths ?? defaultStorePaths()).machineOverlay,
      seams: opts.lifecycleSeams,
    });
    if (!result.ok) {
      throw new Error(result.error);
    }
    const registryState = readRegistry(registryPath);
    if (registryState.kind === "corrupt") {
      throw new Error(`upstream registry is corrupt — ${registryState.error}`);
    }
    writeRegistry(registryPath, upsertEntry(registryState.entries, result.entry));
  });
}
