/**
 * Server-plane doors (ADR-0097): list, binaries, logs, resolve, boot, stop, slots.
 */

import type { Hono } from "hono";
import { getLogBuffer } from "../mba/index.js";
import {
  SlotFilenameError,
  SlotOpError,
  SlotUnsupportedError,
  slotDirForEntry,
  type SlotAction,
} from "../mba/slot-control.js";
import { bootEnvJson, isBareBootEnv } from "./env-context.js";
import { withHouseLock } from "./house-lock.js";
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
import { registryCorruptJson, type ServiceRouteContext } from "./route-context.js";
import { bootServer, resolveBootRecipe } from "./server-boot.js";
import { getServerTypeOps, type ServerType } from "./server-types.js";
import { listRegistryServers } from "./status-snapshot.js";
import {
  readRegistry,
  removeById,
  upsertEntry,
  writeRegistry,
} from "./upstream-registry.js";

export function registerServerRoutes(app: Hono, ctx: ServiceRouteContext): void {
  const { paths, opts, machineOverlay } = ctx;

  app.get("/servers", async (c) => {
    const registryState = readRegistry(paths.upstreamsPath);
    const servers = await listRegistryServers(registryState, opts.fetch ?? fetch);
    if (registryState.kind === "corrupt") {
      return c.json({ servers, integrity: "corrupt", error: registryState.error });
    }
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
    const registryState = readRegistry(paths.upstreamsPath);
    if (registryState.kind === "corrupt") {
      return c.json(registryCorruptJson(registryState.error), 503);
    }
    const registry = registryState.entries;
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
        env: bootEnvJson(recipe.env),
        envAttached: !isBareBootEnv(recipe.env),
        binary: selection.selected,
        binaries: selection.catalog,
        recommended: selection.recommended,
        pinned: selection.pinned,
        warning: selection.warning,
        vendors: [...gpuVendors(opts.machineInfo)],
        gpus: (opts.machineInfo?.gpus ?? [])
          .map((g) => g.name)
          .filter((n): n is string => typeof n === "string" && n.length > 0),
        vramBytes: (opts.machineInfo?.gpus ?? [])
          .filter((g) => typeof g.name === "string" && g.name.length > 0)
          .map((g) => (typeof g.vramBytes === "number" && g.vramBytes > 0 ? g.vramBytes : null)),
        ramBytes: opts.machineInfo?.totalRamBytes,
        cpuThreads: opts.machineInfo?.cpuCores,
        machineOverlay: machineOverlay(),
        model: recipe.model,
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
    const port = input.port;
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
    if (typeof input.binaryPath === "string" && input.binaryPath.length > 0) {
      const binaryErr = llamaBootBinaryError(paths, input.binaryPath);
      if (binaryErr) return c.json({ error: binaryErr }, 400);
    }
    const selection = selectLlamaServer({
      lastPath: readLlamaServerChoice(paths)?.path,
      machineInfo: opts.machineInfo,
      paths,
    });
    const binaryPath =
      typeof input.binaryPath === "string" && input.binaryPath.length > 0
        ? input.binaryPath
        : selection.selected?.path;
    const outcome = await withHouseLock(paths.upstreamsPath, async () => {
      const result = await bootServer({
        serverType,
        modelFile: input.modelFile as string | undefined,
        modelRef: input.modelRef as string | undefined,
        port,
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
            ? (409 as const)
            : result.code === "unknown-model"
              ? (404 as const)
              : result.code === "registry-corrupt"
                ? (503 as const)
                : (500 as const);
        return {
          status,
          body:
            result.code === "registry-corrupt"
              ? { code: result.code, error: result.error }
              : { error: result.error },
        };
      }
      if (typeof binaryPath === "string" && binaryPath.length > 0) {
        writeLlamaServerChoice(paths, {
          path: binaryPath,
          backend: inspectLlamaBackend(binaryPath),
        });
      }
      const registryState = readRegistry(paths.upstreamsPath);
      if (registryState.kind === "corrupt") {
        return { status: 503 as const, body: registryCorruptJson(registryState.error) };
      }
      writeRegistry(paths.upstreamsPath, upsertEntry(registryState.entries, result.entry));
      return { status: 201 as const, body: result.entry };
    });
    return c.json(outcome.body, outcome.status);
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
    const outcome = await withHouseLock(paths.upstreamsPath, async () => {
      const registryState = readRegistry(paths.upstreamsPath);
      if (registryState.kind === "corrupt") {
        return { status: 503 as const, body: registryCorruptJson(registryState.error) };
      }
      const registry = registryState.entries;
      const entry = hasId
        ? registry.find((e) => e.id === input.id)
        : registry.find((e) => e.pid === input.pid);
      if (!entry) {
        return {
          status: 404 as const,
          body: {
            error: `no registered server ${hasId ? `with id ${input.id}` : `with pid ${input.pid}`}`,
          },
        };
      }
      const ops = getServerTypeOps(entry.serverType);
      if (!ops) {
        return { status: 500 as const, body: { error: `unknown server type ${entry.serverType}` } };
      }
      try {
        await ops.stop(entry, opts.lifecycleSeams);
      } catch (err) {
        return {
          status: 500 as const,
          body: { error: err instanceof Error ? err.message : "stop failed" },
        };
      }
      writeRegistry(paths.upstreamsPath, removeById(registry, entry.id));
      return { status: 200 as const, body: { stopped: entry.id } };
    });
    return c.json(outcome.body, outcome.status);
  });

  // Slot / KV control (ADR-0097 Phase 4). llama.cpp only. Filenames stay
  // inside the G3 dir this server was booted with.
  app.get("/servers/slots", async (c) => {
    const id = c.req.query("id");
    if (!id) {
      return c.json({ error: "query param 'id' is required" }, 400);
    }
    const registryState = readRegistry(paths.upstreamsPath);
    if (registryState.kind === "corrupt") {
      return c.json(registryCorruptJson(registryState.error), 503);
    }
    const registry = registryState.entries;
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
    const registryState = readRegistry(paths.upstreamsPath);
    if (registryState.kind === "corrupt") {
      return c.json(registryCorruptJson(registryState.error), 503);
    }
    const registry = registryState.entries;
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
}
