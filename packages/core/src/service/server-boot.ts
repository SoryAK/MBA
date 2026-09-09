/**
 * Server-plane boot capability block (ADR-0097 Phase 2).
 *
 * The "how" of booting a model server in-daemon, replacing the retired
 * `llama-server-up.sh` shell-out:
 *   - `resolveBootRecipe` — resolve the per-model tuning recipe (the same
 *     4-rung merge the proxy uses: `resolveMbaConfig` →
 *     `sanitizeLlamaCppServerFlags` → `buildLlamaServerFlags`), so the flags
 *     the daemon sets are provably the same bytes the proxy applies.
 *   - `defaultBinaryPath` — map a fork to its llama-server binary (boot-script
 *     parity), overridable via `MBA_LLAMA_SERVER_BIN`.
 *   - `bootServer` — enforce the G2 port rule (refuse a busy port, allow a new
 *     one), drive `bootLlamaServer`, and return the registry entry to persist.
 *
 * The route owns the "why/when" (validation, status codes, registry writes);
 * this module owns the operation itself. Pure-ish: fs I/O is confined to the
 * recipe read; process spawning goes through the injected `LifecycleSeams`.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { daemonLog, resolveSeams, type LifecycleSeams } from "../mba/index.js";
import type { MachineInfo } from "./machine-info.js";
import type { MachineOverlayMode } from "./config-store.js";
import { resolveRecipe, type RecipeResolutionContext } from "./recipe-resolution.js";
import { listUpstreams, readRegistry, writeRegistry, type UpstreamEntry } from "./upstream-registry.js";
import { getServerTypeOps, type ServerType } from "./server-types.js";
import { resolveEnvContext, DEFAULT_RESOLVE_ENV } from "./env-context.js";
import { readModelCatalog } from "./model-catalog.js";
import { readSessions } from "./sessions.js";
import { readOperatorClients } from "./operator-clients.js";

/** The two llama.cpp fork variants (boot-script parity). */
export type Fork = "upstream" | "llama.cpp";

const LLAMA_SERVER_NAMES = ["llama-server", "llama-server.exe"] as const;

function findOnPath(
  name: string,
  pathEnv: string | undefined,
): string | undefined {
  if (!pathEnv || pathEnv.length === 0) return undefined;
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir || dir.length === 0) continue;
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function findFirstExisting(candidates: readonly string[]): string | undefined {
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Resolve the llama-server binary for a fork.
 *
 * Search order:
 *   1. `MBA_LLAMA_SERVER_BIN` environment override.
 *   2. `llama-server` (or `llama-server.exe`) on `PATH`.
 *   3. Common absolute locations: `~/.local/bin/llama-server`,
 *      `~/llama.cpp/build/bin/llama-server`, `/usr/local/bin/llama-server`,
 *      `/usr/bin/llama-server`.
 *
 * Returns `undefined` when no candidate is found. The caller must handle the
 * missing-binary case before spawning.
 */
export function defaultBinaryPath(
  _fork: Fork,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const override = env.MBA_LLAMA_SERVER_BIN;
  if (override && override.length > 0) return override;

  const pathEnv = env.PATH ?? env.Path;
  for (const name of LLAMA_SERVER_NAMES) {
    const onPath = findOnPath(name, pathEnv);
    if (onPath) return onPath;
  }

  const common = [
    join(homedir(), ".local", "bin", "llama-server"),
    join(homedir(), "llama.cpp", "build", "bin", "llama-server"),
    "/usr/local/bin/llama-server",
    "/usr/bin/llama-server",
  ];
  return findFirstExisting(common);
}

/** Error message when a llama-server binary cannot be found. */
function binaryNotFoundError(path: string | undefined): string {
  const base =
    "llama-server binary not found. Install llama.cpp, ensure llama-server is on your PATH, or set MBA_LLAMA_SERVER_BIN to the absolute path.";
  if (!path) return base;
  return `llama-server binary not found at ${path}. ${base}`;
}

/** A resolved, ready-to-boot recipe for one weights file. */
export interface BootRecipe {
  /** Adapter `metadata.id` (the canonical model id). */
  readonly modelId: string;
  /** Absolute GGUF path the server will load. */
  readonly modelFile: string;
  /** Tuning CLI args (from `buildLlamaServerFlags`) — deployment facts excluded. */
  readonly cliArgs: string[];
  /** llama.cpp `--warmup` on/off (`0` → `--no-warmup`; count is not sent). */
  readonly warmupTokens: number;
  /** Machine-overlay clamping notes (empty if no machine info was supplied). */
  readonly annotations: readonly string[];
  /** Whether the recipe fits the supplied machine (true if no machine info). */
  readonly fitsMachine: boolean;
  /** Harness + ide + runtime used for environment-folder selection. */
  readonly env: RecipeResolutionContext;
}

/**
 * Resolve the effective llama.cpp recipe for `modelFile` from the adapter
 * tree. Thin wrapper over the shared `resolveRecipe` chain (R1) — the same
 * chain the `resolve-server-recipe` CLI runs, so the daemon and the legacy
 * external boot script set identical flags.
 *
 * @throws {Error} when no adapter under `adapterDir` declares `modelFile`
 *   (the model is not in the MBA tree — the route maps this to 404).
 */
export function resolveBootRecipe(
  modelFile: string,
  adapterDir: string,
  machineInfo?: MachineInfo,
  machineOverlay: MachineOverlayMode = "enforce",
  pairing?: { readonly sessionsPath?: string; readonly clientsPath?: string },
): BootRecipe {
  const catalog = readModelCatalog(adapterDir);
  const entry = catalog.find((c) => c.modelFile === modelFile);
  const env = entry
    ? resolveEnvContext({
        modelId: entry.id,
        sessions: pairing?.sessionsPath ? readSessions(pairing.sessionsPath) : [],
        operatorClients: pairing?.clientsPath
          ? readOperatorClients(pairing.clientsPath)
          : [],
      })
    : DEFAULT_RESOLVE_ENV;
  const recipe = resolveRecipe(
    modelFile,
    adapterDir,
    env,
    { machineInfo, machineOverlay },
  );
  return {
    modelId: recipe.modelId,
    modelFile: recipe.modelFile,
    cliArgs: recipe.cliArgs,
    warmupTokens: recipe.flags.warmupTokens ?? 350,
    annotations: recipe.annotations,
    fitsMachine: recipe.fitsMachine,
    env,
  };
}

/** Input to `bootServer`. */
export interface BootServerInput {
  /** Server type to boot (default `llama.cpp`). Selects the type-table row. */
  readonly serverType?: ServerType;
  /** llama.cpp: absolute GGUF path to boot. */
  readonly modelFile?: string;
  /** ollama: model tag (e.g. `qwen3.8:27b`). */
  readonly modelRef?: string;
  /** TCP port to bind (127.0.0.1). The G2 decision input. */
  readonly port: number;
  /** Fork variant (default `upstream`). */
  readonly fork?: Fork;
  /** Adapter tree root (for recipe resolution). */
  readonly adapterDir: string;
  /** Registry file path (for the G2 port check). */
  readonly registryPath: string;
  /** Explicit binary override (default: `defaultBinaryPath(fork)`). */
  readonly binaryPath?: string;
  /** ollama: daemon base URL (default `OLLAMA_DEFAULT_HOST`). */
  readonly host?: string;
  /** Detected/persisted machine profile for recipe clamping. */
  readonly machineInfo?: MachineInfo;
  /** How to apply the machine overlay (default `enforce`). */
  readonly machineOverlay?: MachineOverlayMode;
  /** Paired sessions — boot uses this model's newest pairing as resolve env. */
  readonly sessionsPath?: string;
  /** Operator-defined clients (ide fallback for a paired harness). */
  readonly clientsPath?: string;
  /** Lifecycle seams (spawn/fetch/kill) — injectable for tests. */
  readonly seams?: LifecycleSeams;
}

/** Structured boot outcome — the route maps `code` to an HTTP status. */
export type BootServerResult =
  | { readonly ok: true; readonly entry: UpstreamEntry }
  | {
      readonly ok: false;
      readonly code: "port-busy" | "duplicate-model" | "unknown-model" | "boot-failed";
      readonly error: string;
    };

/**
 * Boot a model server in-daemon and return the registry entry to persist.
 *
 * G2 port rule (self-healing): the actual OS port is checked first via
 * `portCheckImpl`. If the port is occupied, the boot is refused
 * (`port-busy`) — the error names the registry entry if one exists,
 * otherwise reports an external process. If the port is free, any stale
 * registry entry for it is cleaned up before booting. Q1 duplicate-model
 * rule (Phase 3): a model file already served by a registered entry is
 * refused (`duplicate-model`) — one server per model; stop the existing
 * one first. The boot resolves when /health is ok (llama.cpp warmup, if
 * passed, is llama.cpp's load flag, not an MBA POST). A failed boot is
 * reported as `boot-failed` and leaves no registry entry.
 */
export async function bootServer(input: BootServerInput): Promise<BootServerResult> {
  const serverType = input.serverType ?? "llama.cpp";
  const ops = getServerTypeOps(serverType);
  if (!ops) {
    return {
      ok: false,
      code: "unknown-model",
      error: `unknown server type ${serverType}`,
    };
  }
  const fork = input.fork ?? "upstream";

  // The model key for the Q1 duplicate check: GGUF path (llama.cpp) or
  // model tag (ollama).
  const modelKey = serverType === "ollama" ? input.modelRef : input.modelFile;
  if (!modelKey) {
    return {
      ok: false,
      code: "unknown-model",
      error: `${serverType} boot requires ${serverType === "ollama" ? "modelRef" : "modelFile"}`,
    };
  }

  daemonLog(
    `[boot] request: ${serverType} model=${modelKey} port=${input.port} fork=${fork}`,
  );

  const registry = readRegistry(input.registryPath);

  // G2: refuse a port already bound by a process-per-model server. Ollama
  // entries all share the daemon port, so the port check applies only to
  // types that bind their own port (llama.cpp) — for Ollama the Q1
  // duplicate check (one entry per tag) is the guard.
  //
  // Self-healing: check the actual OS port first (not just the registry).
  // If the port is free, clean up any stale registry entry for it. If the
  // port is occupied, report a friendly error using the registry entry if
  // one exists, otherwise a generic "external process" message.
  if (serverType !== "ollama") {
    const { portCheckImpl } = resolveSeams(input.seams);
    const portFree = await portCheckImpl(input.port);
    daemonLog(`[boot] G2 port check: port ${input.port} ${portFree ? "free" : "BUSY"}`);
    if (!portFree) {
      const busy = registry.find((e) => e.port === input.port);
      return {
        ok: false,
        code: "port-busy",
        error: busy
          ? `port ${input.port} is already in use by ${busy.id}`
          : `port ${input.port} is already in use by an external process`,
      };
    }
    // Port is free — clean up any stale registry entry for this port.
    const stale = registry.find((e) => e.port === input.port);
    if (stale) {
      const cleaned = registry.filter((e) => e.port !== input.port);
      writeRegistry(input.registryPath, cleaned);
      daemonLog(`[boot] G2: removed stale registry entry for port ${input.port}`);
    }
  }

  // Q1: refuse a second server for the same model. `listUpstreams` carries
  // the same path/basename tolerance as the resolve rule and sorts
  // newest-first, so the named entry is the most recently booted one.
  const duplicates = listUpstreams(registry, modelKey);
  if (duplicates.length > 0) {
    const existing = duplicates[0];
    daemonLog(
      `[boot] Q1 duplicate-model: ${modelKey} already served by ${existing?.id ?? "?"} on port ${existing?.port ?? "?"}`,
    );
    return {
      ok: false,
      code: "duplicate-model",
      error:
        `model ${modelKey} is already served by ${existing?.id ?? "an existing entry"} ` +
        `on port ${existing?.port ?? "?"} — stop it first (mba servers stop ${existing?.id ?? "?"})`,
    };
  }

  // Resolve the llama.cpp recipe (404 when the model is not in the adapter
  // tree). Ollama has no recipe — the tag is the whole identity.
  let recipe: BootRecipe | undefined;
  const machineOverlay = input.machineOverlay ?? "enforce";

  if (serverType !== "ollama") {
    try {
      recipe = resolveBootRecipe(
        modelKey,
        input.adapterDir,
        input.machineInfo,
        machineOverlay,
        { sessionsPath: input.sessionsPath, clientsPath: input.clientsPath },
      );
      daemonLog(
        `[boot] recipe resolved: modelId=${recipe.modelId} env=${recipe.env.harness}+${recipe.env.ide}+${recipe.env.serverRuntime} warmup=${recipe.warmupTokens} args=[${recipe.cliArgs.join(" ")}]`,
      );
      if (recipe.annotations.length > 0) {
        for (const annotation of recipe.annotations) {
          const prefix = machineOverlay === "warn" ? "[boot] overlay (warn)" : "[boot] overlay";
          daemonLog(`${prefix}: ${annotation}`);
        }
      }
      if (!recipe.fitsMachine) {
        if (machineOverlay === "enforce") {
          return {
            ok: false,
            code: "boot-failed",
            error: "recipe does not fit the detected machine (set machine-overlay to warn or off to override)",
          };
        }
        daemonLog(`[boot] WARNING: recipe does not fit detected machine; boot may fail`);
      }
    } catch (err) {
      daemonLog(`[boot] recipe resolution FAILED: ${err instanceof Error ? err.message : String(err)}`);
      return {
        ok: false,
        code: "unknown-model",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // Resolve the binary path for llama.cpp and fail fast if it is missing.
  // ollama has no binary to spawn; the daemon talks to the ollama host over HTTP.
  //
  // When the caller injects `spawnImpl` they own process creation (tests /
  // CI). Skip the on-disk check so Jenkins does not need llama.cpp installed
  // just to exercise the boot route.
  const usingInjectedSpawn = input.seams?.spawnImpl !== undefined;
  const binaryPath =
    serverType !== "ollama"
      ? (input.binaryPath ?? defaultBinaryPath(fork) ?? (usingInjectedSpawn ? "llama-server" : undefined))
      : undefined;
  if (
    serverType !== "ollama" &&
    !usingInjectedSpawn &&
    (binaryPath === undefined || !existsSync(binaryPath))
  ) {
    const message = binaryNotFoundError(binaryPath);
    daemonLog(`[boot] FAILED: ${message}`);
    return {
      ok: false,
      code: "boot-failed",
      error: message,
    };
  }

  // Dispatch to the type's boot (health for llama.cpp; load for ollama).
  // A failure reports `boot-failed` and leaves no registry entry.
  try {
    const entry = await ops.boot(
      {
        modelFile: recipe?.modelFile ?? modelKey,
        modelRef: input.modelRef,
        port: input.port,
        host: input.host,
        fork,
        binaryPath,
        cliArgs: recipe?.cliArgs,
      },
      input.seams,
    );
    daemonLog(
      `[boot] SUCCESS: ${entry.id} on port ${entry.port}${entry.pid !== undefined ? ` (pid ${entry.pid})` : ""}`,
    );
    return { ok: true, entry };
  } catch (err) {
    daemonLog(
      `[boot] FAILED: ${err instanceof Error ? err.message : String(err)}`,
    );
    return {
      ok: false,
      code: "boot-failed",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
