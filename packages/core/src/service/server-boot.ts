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

import { homedir } from "node:os";
import { join } from "node:path";
import { daemonLog, resolveSeams, type LifecycleSeams } from "../mba/index.js";
import { resolveRecipe } from "./recipe-resolution.js";
import { listUpstreams, readRegistry, writeRegistry, type UpstreamEntry } from "./upstream-registry.js";
import { getServerTypeOps, type ServerType } from "./server-types.js";

/** The two llama.cpp fork variants (boot-script parity). */
export type Fork = "upstream" | "cachyllama";

/**
 * Map a fork to its llama-server binary (boot-script parity):
 *   upstream   → ~/llama.cpp/build/bin/llama-server
 *   cachyllama → ~/Dev_Projects/C-Yard/vendor/llama.cpp/build/bin/llama-server
 * An explicit `MBA_LLAMA_SERVER_BIN` overrides both.
 */
export function defaultBinaryPath(fork: Fork, env: NodeJS.ProcessEnv = process.env): string {
  const override = env.MBA_LLAMA_SERVER_BIN;
  if (override && override.length > 0) return override;
  if (fork === "cachyllama") {
    return join(homedir(), "Dev_Projects/C-Yard/vendor/llama.cpp/build/bin/llama-server");
  }
  return join(homedir(), "llama.cpp/build/bin/llama-server");
}

/** A resolved, ready-to-boot recipe for one weights file. */
export interface BootRecipe {
  /** Adapter `metadata.id` (the canonical model id). */
  readonly modelId: string;
  /** Absolute GGUF path the server will load. */
  readonly modelFile: string;
  /** Tuning CLI args (from `buildLlamaServerFlags`) — deployment facts excluded. */
  readonly cliArgs: string[];
  /** Post-boot warm-up generation length (tokens). */
  readonly warmupTokens: number;
}

/**
 * Resolve the effective llama.cpp recipe for `modelFile` from the adapter
 * tree. Thin wrapper over the shared `resolveRecipe` chain (R1) — the same
 * chain the `resolve-server-recipe` CLI runs, so the daemon and the C-Yard
 * boot script set identical flags.
 *
 * @throws {Error} when no adapter under `adapterDir` declares `modelFile`
 *   (the model is not in the MBA tree — the route maps this to 404).
 */
export function resolveBootRecipe(modelFile: string, adapterDir: string): BootRecipe {
  const recipe = resolveRecipe(modelFile, adapterDir, {
    harness: "copilot",
    ide: "vscode",
    serverRuntime: "llamacpp",
  });
  return {
    modelId: recipe.modelId,
    modelFile: recipe.modelFile,
    cliArgs: recipe.cliArgs,
    warmupTokens: recipe.flags.warmupTokens ?? 350,
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
 * one first. The boot resolves only after health + warmup (Perf #2); a
 * failed boot is reported as `boot-failed` and leaves no registry entry.
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
  if (serverType !== "ollama") {
    try {
      recipe = resolveBootRecipe(modelKey, input.adapterDir);
      daemonLog(
        `[boot] recipe resolved: modelId=${recipe.modelId} warmup=${recipe.warmupTokens} args=[${recipe.cliArgs.join(" ")}]`,
      );
    } catch (err) {
      daemonLog(`[boot] recipe resolution FAILED: ${err instanceof Error ? err.message : String(err)}`);
      return {
        ok: false,
        code: "unknown-model",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // Dispatch to the type's boot (health + warmup for llama.cpp; load for
  // ollama). A failure reports `boot-failed` and leaves no registry entry.
  try {
    const entry = await ops.boot(
      {
        modelFile: recipe?.modelFile ?? modelKey,
        modelRef: input.modelRef,
        port: input.port,
        host: input.host,
        fork,
        binaryPath: input.binaryPath ?? (serverType !== "ollama" ? defaultBinaryPath(fork) : undefined),
        cliArgs: recipe?.cliArgs,
        warmupTokens: recipe?.warmupTokens,
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
