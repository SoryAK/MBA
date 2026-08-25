/**
 * Server-type table (ADR-0097 Phase 3): the `serverType → { boot, stop,
 * health }` switchboard that proves the lifecycle abstraction is not
 * llama.cpp-shaped.
 *
 * Ollama is the proof engine. Unlike llama.cpp (one process per model, owned
 * PID, G1 group-kill), Ollama is a single long-running daemon that loads and
 * unloads models in-place via its HTTP API. Ollama has no dedicated
 * load/unload endpoint (verified on 0.32.x): a model loads on any inference
 * request and `keep_alive` controls retention. So the Ollama ops:
 *   - boot  → GET /api/tags (daemon up + model present) → POST /api/generate (keep_alive long)
 *   - stop  → POST /api/generate (keep_alive 0)
 *   - health → GET /api/tags
 * and the resulting registry entry has NO `pid` (there is no per-model
 * process to own).
 *
 * All network goes through the injected `fetchImpl`, so no real Ollama daemon
 * is needed for these tests.
 */

import { describe, it, expect } from "vitest";
import {
  serverTypeOps,
  getServerTypeOps,
  OLLAMA_DEFAULT_HOST,
  type ServerType,
} from "./server-types.js";
import type { UpstreamEntry } from "./upstream-registry.js";

/** A fake Ollama daemon: /api/tags lists `models`, /api/generate 200. */
function ollamaFetch(opts: { daemonUp?: boolean; models?: string[] } = {}): {
  fetchImpl: typeof fetch;
  calls: Array<{ method: string; url: string }>;
} {
  const calls: Array<{ method: string; url: string }> = [];
  const daemonUp = opts.daemonUp ?? true;
  const models = opts.models ?? ["qwen3.8:27b"];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ method, url });
    if (!daemonUp) throw new Error(`ECONNREFUSED ${url}`);
    if (url.includes("/api/tags")) {
      return new Response(
        JSON.stringify({ models: models.map((name) => ({ name })) }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("/api/generate")) {
      return new Response(JSON.stringify({ status: "success" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected url ${url}`);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("server-type table (ADR-0097 Phase 3)", () => {
  it("exposes exactly the llama.cpp and ollama types", () => {
    expect(Object.keys(serverTypeOps).sort()).toEqual(["llama.cpp", "ollama"]);
  });

  it("getServerTypeOps returns the ops for a known type and null for unknown", () => {
    expect(getServerTypeOps("llama.cpp")).toBe(serverTypeOps["llama.cpp"]);
    expect(getServerTypeOps("ollama")).toBe(serverTypeOps["ollama"]);
    expect(getServerTypeOps("vllm" as ServerType)).toBeNull();
  });

  it("defaults the Ollama host to 127.0.0.1:11434", () => {
    expect(OLLAMA_DEFAULT_HOST).toBe("http://127.0.0.1:11434");
  });
});

describe("ollama ops", () => {
  const tag = "qwen3.8:27b";

  it("boot loads the model and returns a pid-less registry entry", async () => {
    const { fetchImpl, calls } = ollamaFetch({ models: [tag] });
    const entry = await serverTypeOps["ollama"].boot(
      { modelRef: tag, port: 11434, host: OLLAMA_DEFAULT_HOST },
      { fetchImpl },
    );
    expect(entry).toMatchObject({
      id: "ollama-11434",
      serverType: "ollama",
      modelFile: tag,
      port: 11434,
    });
    // No per-model process to own — the entry carries no pid.
    expect(entry.pid).toBeUndefined();
    // It verified the model was present, then loaded it (generate + keep_alive).
    expect(calls.some((c) => c.url.includes("/api/tags"))).toBe(true);
    expect(calls.some((c) => c.method === "POST" && c.url.includes("/api/generate"))).toBe(
      true,
    );
  });

  it("boot throws when the daemon is down", async () => {
    const { fetchImpl } = ollamaFetch({ daemonUp: false });
    await expect(
      serverTypeOps["ollama"].boot(
        { modelRef: tag, port: 11434, host: OLLAMA_DEFAULT_HOST },
        { fetchImpl },
      ),
    ).rejects.toThrow(/daemon|refused|unreachable/i);
  });

  it("boot throws when the model is not in the daemon", async () => {
    const { fetchImpl } = ollamaFetch({ models: ["other:1b"] });
    await expect(
      serverTypeOps["ollama"].boot(
        { modelRef: tag, port: 11434, host: OLLAMA_DEFAULT_HOST },
        { fetchImpl },
      ),
    ).rejects.toThrow(/not.*found|unknown model|pull/i);
  });

  it("stop unloads the model", async () => {
    const { fetchImpl, calls } = ollamaFetch({ models: [tag] });
    const entry: UpstreamEntry = {
      id: "ollama-11434",
      serverType: "ollama",
      modelFile: tag,
      port: 11434,
      startedAt: "2026-08-25T02:00:00.000Z",
    };
    await serverTypeOps["ollama"].stop(entry, { fetchImpl });
    expect(calls.some((c) => c.method === "POST" && c.url.includes("/api/generate"))).toBe(
      true,
    );
  });

  it("health is true when the daemon answers /api/tags, false when down", async () => {
    const up = ollamaFetch({ models: [tag] });
    const down = ollamaFetch({ daemonUp: false });
    const entry: UpstreamEntry = {
      id: "ollama-11434",
      serverType: "ollama",
      modelFile: tag,
      port: 11434,
      startedAt: "2026-08-25T02:00:00.000Z",
    };
    await expect(serverTypeOps["ollama"].health(entry, up.fetchImpl)).resolves.toBe(true);
    await expect(serverTypeOps["ollama"].health(entry, down.fetchImpl)).resolves.toBe(false);
  });
});
