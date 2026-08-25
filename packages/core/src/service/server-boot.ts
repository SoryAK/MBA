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

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import YAML from "yaml";
import {
  buildLlamaServerFlags,
  bootLlamaServer,
  resolveMbaConfig,
  sanitizeLlamaCppServerFlags,
  type LifecycleSeams,
  type LlamaCppServerFlags,
} from "../mba/index.js";
import { readModelCatalog, type CatalogEntry } from "./model-catalog.js";
import { readRegistry, type UpstreamEntry } from "./upstream-registry.js";

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
 * tree. Mirrors `resolve-server-recipe.ts` so the daemon and the (retired)
 * script set identical flags.
 *
 * @throws {Error} when no adapter under `adapterDir` declares `modelFile`
 *   (the model is not in the MBA tree — the route maps this to 404).
 */
export function resolveBootRecipe(modelFile: string, adapterDir: string): BootRecipe {
  const catalog = readModelCatalog(adapterDir);
  const entry = catalog.find((c) => c.modelFile === modelFile);
  if (!entry) {
    throw new Error(`no adapter under ${adapterDir} declares model file ${modelFile}`);
  }

  // The resolver matches on identity.model.name (exact equality), so feed it
  // the declared name, not the .gguf basename (which may carry a quant suffix).
  let declaredName: string | undefined;
  let declaredFamily: string | undefined;
  try {
    const raw = YAML.parse(readFileSync(entry.yamlPath, "utf8")) as {
      identity?: { model?: { name?: string; family?: string } };
    };
    declaredName = raw.identity?.model?.name;
    declaredFamily = raw.identity?.model?.family;
  } catch {
    // Fall through to the catalog name below.
  }

  // resolveMbaConfig wants the MBA *base* dir (parent of `adapters/`); the
  // catalog wants the adapters dir itself. Keep the two distinct.
  const mbaBaseDir = dirname(adapterDir);
  const resolved = resolveMbaConfig(mbaBaseDir, {
    modelName: declaredName ?? entry.name,
    modelFamily: declaredFamily,
    harness: "copilot",
    ide: "vscode",
    serverRuntime: "llamacpp",
  });

  const { flags } = sanitizeLlamaCppServerFlags(resolved.server["llama.cpp"]);
  const cliArgs = buildLlamaServerFlags(flags);

  return {
    modelId: entry.id,
    modelFile,
    cliArgs,
    warmupTokens: flags.warmupTokens ?? 350,
  };
}

/** Input to `bootServer`. */
export interface BootServerInput {
  /** Absolute GGUF path to boot. */
  readonly modelFile: string;
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
  /** Lifecycle seams (spawn/fetch/kill) — injectable for tests. */
  readonly seams?: LifecycleSeams;
}

/** Structured boot outcome — the route maps `code` to an HTTP status. */
export type BootServerResult =
  | { readonly ok: true; readonly entry: UpstreamEntry }
  | {
      readonly ok: false;
      readonly code: "port-busy" | "unknown-model" | "boot-failed";
      readonly error: string;
    };

/**
 * Boot a model server in-daemon and return the registry entry to persist.
 *
 * G2 port rule: a port already present in the registry is refused
 * (`port-busy`); a new port for the same model is allowed (merge, never
 * clobber). The boot resolves only after health + warmup (Perf #2); a failed
 * boot is reported as `boot-failed` and leaves no registry entry.
 */
export async function bootServer(input: BootServerInput): Promise<BootServerResult> {
  const fork = input.fork ?? "upstream";

  // G2: refuse a port that is already in use. A new port is always allowed.
  const registry = readRegistry(input.registryPath);
  const busy = registry.find((e) => e.port === input.port);
  if (busy) {
    return {
      ok: false,
      code: "port-busy",
      error: `port ${input.port} is already in use by ${busy.id}`,
    };
  }

  // Resolve the recipe (404 when the model is not in the adapter tree).
  let recipe: BootRecipe;
  try {
    recipe = resolveBootRecipe(input.modelFile, input.adapterDir);
  } catch (err) {
    return {
      ok: false,
      code: "unknown-model",
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // Boot (health + warmup). A failure kills the child group and reports.
  try {
    const state = await bootLlamaServer(
      {
        binaryPath: input.binaryPath ?? defaultBinaryPath(fork),
        modelPath: recipe.modelFile,
        port: input.port,
        flags: recipe.cliArgs,
        fork,
        warmupTokens: recipe.warmupTokens,
      },
      input.seams,
    );
    const entry: UpstreamEntry = {
      id: `llama-cpp-${input.port}`,
      serverType: "llama.cpp",
      modelFile: recipe.modelFile,
      port: input.port,
      pid: state.pid,
      startedAt: new Date().toISOString(),
    };
    return { ok: true, entry };
  } catch (err) {
    return {
      ok: false,
      code: "boot-failed",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
