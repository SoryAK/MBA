/**
 * Server-type table (ADR-0097 Phase 3): the `serverType → { boot, stop,
 * health }` switchboard.
 *
 * Phase 2 hardwired the lifecycle to one engine (llama.cpp: spawn a detached
 * process, group-kill it, poll /health). Phase 3 makes the daemon dispatch on
 * the entry's `serverType` so a second engine can be added as a table row,
 * not a rewrite. Ollama is the proof engine: it is a single long-running
 * daemon that loads/unloads models in-place over HTTP, so its lifecycle shape
 * is genuinely different — no per-model process, no owned PID, no G1
 * group-kill, no warmup.
 *
 *   llama.cpp  boot: spawn detached + health + warmup   stop: group-kill
 *               health: GET /health on the model port   pid: owned
 *   ollama     boot: GET /api/tags → POST /api/generate (keep_alive long)
 *               stop: POST /api/generate (keep_alive 0)
 *               health: GET /api/tags on the daemon     pid: none
 *
 * Ollama has no dedicated load/unload endpoint (verified on 0.32.x): a model
 * is loaded by any inference request and `keep_alive` controls how long it
 * stays resident. So "boot" issues a tiny generate with a long keep_alive to
 * force the load and pin it, and "stop" issues a generate with keep_alive 0
 * to release it. Health is the daemon being reachable (the model auto-loads
 * on demand, so daemon-up is the usable signal).
 *
 * The table is a thin dispatch layer: the llama.cpp row wraps the existing
 * `mba/server-lifecycle.ts` mechanics unchanged; the ollama row is new.
 */

import {
  bootLlamaServer,
  stopLlamaServer,
  type LifecycleSeams,
} from "../mba/index.js";
import type { UpstreamEntry } from "./upstream-registry.js";

/** The server types the daemon knows how to manage. */
export type ServerType = "llama.cpp" | "ollama";

/** Default Ollama daemon host (override with `OLLAMA_HOST`). */
export const OLLAMA_DEFAULT_HOST = "http://127.0.0.1:11434";

/**
 * How long a booted Ollama model stays resident. Long enough to outlive a
 * working session; the daemon still reclaims it on memory pressure.
 */
export const OLLAMA_BOOT_KEEP_ALIVE = "1h";

/** Budget for the load-generate (first load of a large model can be slow). */
export const OLLAMA_BOOT_TIMEOUT_MS = 300_000;

/**
 * Input to a type's `boot`. `modelFile` is the llama.cpp GGUF path;
 * `modelRef` is the Ollama model tag. `port` is the model port for
 * llama.cpp and the daemon port for Ollama. `host` is the Ollama daemon
 * base URL (llama.cpp ignores it).
 */
export interface TypeBootInput {
  /** llama.cpp: absolute GGUF path. */
  readonly modelFile?: string;
  /** ollama: model tag (e.g. `qwen3.8:27b`). */
  readonly modelRef?: string;
  /** TCP port (model port for llama.cpp, daemon port for ollama). */
  readonly port: number;
  /** ollama: daemon base URL (default `OLLAMA_DEFAULT_HOST`). */
  readonly host?: string;
  /** llama.cpp: fork variant (default `upstream`). */
  readonly fork?: "upstream" | "cachyllama";
  /** llama.cpp: explicit binary override. */
  readonly binaryPath?: string;
  /** llama.cpp: tuning CLI args (from the boot recipe). */
  readonly cliArgs?: string[];
  /** llama.cpp: warmup generation length (tokens). */
  readonly warmupTokens?: number;
}

/** The lifecycle capability block for one server type. */
export interface ServerTypeOps {
  /** Boot the model; returns the registry entry to persist. */
  boot(input: TypeBootInput, seams?: LifecycleSeams): Promise<UpstreamEntry>;
  /** Stop/unload the model identified by the entry. */
  stop(entry: UpstreamEntry, seams?: LifecycleSeams): Promise<void>;
  /** Health probe for one entry (advisory — never throws). */
  health(entry: UpstreamEntry, fetchImpl: typeof fetch): Promise<boolean>;
}

/**
 * The llama.cpp row: wraps the Phase 2 mechanics. `boot` requires the recipe
 * fields (`modelFile`, `cliArgs`) to be present — the caller (bootServer)
 * resolves them before dispatch.
 */
const llamaCppOps: ServerTypeOps = {
  async boot(input, seams) {
    if (!input.modelFile) throw new Error("llama.cpp boot requires modelFile");
    const state = await bootLlamaServer(
      {
        binaryPath: input.binaryPath ?? "",
        modelPath: input.modelFile,
        port: input.port,
        flags: input.cliArgs ?? [],
        fork: input.fork ?? "upstream",
        warmupTokens: input.warmupTokens ?? 350,
      },
      seams,
    );
    return {
      id: `llama-cpp-${input.port}`,
      serverType: "llama.cpp",
      modelFile: input.modelFile,
      port: input.port,
      pid: state.pid,
      startedAt: new Date().toISOString(),
    };
  },
  async stop(entry, seams) {
    if (entry.pid === undefined) throw new Error(`llama.cpp entry ${entry.id} has no pid`);
    await stopLlamaServer(entry.pid, seams);
  },
  async health(entry, fetchImpl) {
    try {
      const res = await fetchImpl(`http://127.0.0.1:${entry.port}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      return res.ok;
    } catch {
      return false;
    }
  },
};

/** Resolve the Ollama daemon host from the entry's port + env override. */
function ollamaHost(entry: Pick<UpstreamEntry, "port">, env: NodeJS.ProcessEnv = process.env): string {
  const override = env.OLLAMA_HOST;
  if (override && override.length > 0) return override.replace(/\/$/, "");
  return `http://127.0.0.1:${entry.port}`;
}

/** The Ollama row: API-managed, no owned process. */
const ollamaOps: ServerTypeOps = {
  async boot(input, seams) {
    const tag = input.modelRef;
    if (!tag) throw new Error("ollama boot requires modelRef");
    const host = (input.host ?? OLLAMA_DEFAULT_HOST).replace(/\/$/, "");
    const fetchImpl = seams?.fetchImpl ?? fetch;

    // 1. Daemon up + model present (else the load would fail opaquely).
    let tags: { models?: Array<{ name?: string }> };
    try {
      const res = await fetchImpl(`${host}/api/tags`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      tags = (await res.json()) as { models?: Array<{ name?: string }> };
    } catch (err) {
      throw new Error(
        `ollama daemon unreachable at ${host} — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const names = (tags.models ?? []).map((m) => m.name ?? "");
    if (!names.includes(tag)) {
      throw new Error(`model ${tag} not found in ollama — pull it first (ollama pull ${tag})`);
    }

    // 2. Load the model into the daemon. Ollama has no /api/load; a model is
    //    loaded by any inference request. A tiny generate with a long
    //    keep_alive forces the load and pins it resident (the "warmup").
    const loadRes = await fetchImpl(`${host}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: tag,
        prompt: "hi",
        stream: false,
        keep_alive: OLLAMA_BOOT_KEEP_ALIVE,
      }),
      signal: AbortSignal.timeout(OLLAMA_BOOT_TIMEOUT_MS),
    });
    if (!loadRes.ok) {
      throw new Error(`ollama load failed: status ${loadRes.status}`);
    }

    return {
      id: `ollama-${input.port}`,
      serverType: "ollama",
      modelFile: tag,
      port: input.port,
      startedAt: new Date().toISOString(),
    };
  },
  async stop(entry, seams) {
    const host = ollamaHost(entry);
    const fetchImpl = seams?.fetchImpl ?? fetch;
    // Ollama has no /api/unload; keep_alive 0 on a generate releases the model
    // from memory immediately.
    const res = await fetchImpl(`${host}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: entry.modelFile,
        prompt: "hi",
        stream: false,
        keep_alive: 0,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      throw new Error(`ollama unload failed: status ${res.status}`);
    }
  },
  async health(entry, fetchImpl) {
    const host = ollamaHost(entry);
    try {
      const res = await fetchImpl(`${host}/api/tags`, {
        signal: AbortSignal.timeout(2000),
      });
      return res.ok;
    } catch {
      return false;
    }
  },
};

/** The type table: `serverType → lifecycle capability block`. */
export const serverTypeOps: Record<ServerType, ServerTypeOps> = {
  "llama.cpp": llamaCppOps,
  ollama: ollamaOps,
};

/** Look up a type's ops, or null when the type is unknown. */
export function getServerTypeOps(type: string): ServerTypeOps | null {
  return (serverTypeOps as Record<string, ServerTypeOps>)[type] ?? null;
}
