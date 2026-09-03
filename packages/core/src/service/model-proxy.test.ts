import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createMbaServiceApp } from "./server.js";
import { defaultStorePaths } from "./config-store.js";
import { writeRegistry, type UpstreamEntry } from "./upstream-registry.js";

const UPSTREAM = "http://127.0.0.1:8081";

/** Write a minimal switchable adapter (leaf with a weights file). */
function writeAdapter(dir: string, rel: string, id: string, file: string): void {
  const yamlFile = join(dir, rel);
  mkdirSync(join(yamlFile, ".."), { recursive: true });
  const lines = [
    "apiVersion: mba.c-yard.dev/v1alpha1",
    "kind: ModelBehavioralAdapter",
    "metadata:",
    `  id: ${id}`,
    "identity:",
    "  model:",
    `    file: "${file}"`,
    "bindings: {}",
  ];
  writeFileSync(yamlFile, lines.join("\n"));
}

/**
 * A fetch mock for the registry-routed proxy. It distinguishes the two kinds
 * of outbound call the proxy makes:
 *   - health probes:  GET  http://127.0.0.1:<port>/health
 *   - chat forwards:  POST http://127.0.0.1:<port>/v1/chat/completions
 * `health` maps a port to its liveness; `chat` is the canned chat response.
 * `chatCalls` records the port each chat forward hit (in order).
 */
function registryFetch(opts: {
  health: Record<number, boolean>;
  chat?: (port: number) => Response;
}): {
  fetch: typeof fetch;
  healthCalls: number[];
  chatCalls: number[];
} {
  const healthCalls: number[] = [];
  const chatCalls: number[] = [];
  const portOf = (url: string): number => {
    const m = url.match(/127\.0\.0\.1:(\d+)/);
    return m ? Number(m[1]) : -1;
  };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const port = portOf(url);
    if (url.includes("/health")) {
      healthCalls.push(port);
      return new Response(opts.health[port] ? "ok" : "down", {
        status: opts.health[port] ? 200 : 503,
      });
    }
    if (url.includes("/v1/chat/completions")) {
      chatCalls.push(port);
      const body = opts.chat ? opts.chat(port) : undefined;
      return (
        body ??
        new Response(
          JSON.stringify({
            id: "chatcmpl-1",
            object: "chat.completion",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: `hi from ${port}` },
                finish_reason: "stop",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      );
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, healthCalls, chatCalls };
}

/** A registry entry for a llama.cpp server on `port` serving `modelFile`. */
function entry(id: string, modelFile: string, port: number, startedAt: string): UpstreamEntry {
  return { id, serverType: "llama.cpp", modelFile, port, pid: 1000 + port, startedAt };
}

/**
 * A fetch mock that records the last request it was asked to make and returns
 * a canned upstream response. `behavior` lets each test steer the canned
 * response (or throw, to simulate an unreachable upstream).
 */
function upstreamFetch(
  behavior: (url: string, init: RequestInit | undefined) => Response | Promise<Response>,
): { fetch: typeof fetch; calls: Array<{ url: string; init: RequestInit | undefined }> } {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return behavior(url, init);
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, calls };
}

const CHAT_BODY = {
  model: "llama-3.1-8b",
  messages: [{ role: "user", content: "hello" }],
  stream: false,
};

describe("model proxy (ADR-0101 Step 1)", () => {
  it("forwards a non-stream chat request verbatim and returns the upstream response", async () => {
    const paths = defaultStorePaths(mkdtempSync(join(tmpdir(), "mba-proxy-")));
    const upstream = {
      id: "chatcmpl-1",
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
    };
    const { fetch: fetchImpl, calls } = upstreamFetch(() =>
      new Response(JSON.stringify(upstream), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const app = createMbaServiceApp({ paths, upstreamUrl: UPSTREAM, fetch: fetchImpl });

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(CHAT_BODY),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual(upstream);

    // The request must have been forwarded to the upstream's chat endpoint,
    // with the original body intact.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${UPSTREAM}/v1/chat/completions`);
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.init?.body).toBe(JSON.stringify(CHAT_BODY));
  });

  it("passes an SSE stream through with the upstream content-type and exact bytes", async () => {
    const paths = defaultStorePaths(mkdtempSync(join(tmpdir(), "mba-proxy-")));
    const sseText =
      'data: {"id":"1","choices":[{"delta":{"content":"he"}}]}\n\n' +
      'data: {"id":"1","choices":[{"delta":{"content":"llo"}}]}\n\n' +
      "data: [DONE]\n\n";
    const { fetch: fetchImpl } = upstreamFetch(() =>
      new Response(sseText, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );
    const app = createMbaServiceApp({ paths, upstreamUrl: UPSTREAM, fetch: fetchImpl });

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...CHAT_BODY, stream: true }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(await res.text()).toBe(sseText);
  });

  it("returns 502 when the upstream is unreachable", async () => {
    const paths = defaultStorePaths(mkdtempSync(join(tmpdir(), "mba-proxy-")));
    const { fetch: fetchImpl } = upstreamFetch(() => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:8081");
    });
    const app = createMbaServiceApp({ paths, upstreamUrl: UPSTREAM, fetch: fetchImpl });

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(CHAT_BODY),
    });

    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/upstream unreachable/);
  });

  it("passes an upstream error status and body through unchanged", async () => {
    const paths = defaultStorePaths(mkdtempSync(join(tmpdir(), "mba-proxy-")));
    const errBody = { error: { message: "model not loaded", type: "invalid_request_error" } };
    const { fetch: fetchImpl } = upstreamFetch(() =>
      new Response(JSON.stringify(errBody), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    );
    const app = createMbaServiceApp({ paths, upstreamUrl: UPSTREAM, fetch: fetchImpl });

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(CHAT_BODY),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(errBody);
  });

  it("returns 503 when no upstream is configured", async () => {
    const paths = defaultStorePaths(mkdtempSync(join(tmpdir(), "mba-proxy-")));
    const app = createMbaServiceApp({ paths });

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(CHAT_BODY),
    });

    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    // Step 1b: an empty registry with no static upstream means nothing is
    // loaded — the message now points at the boot command.
    expect(body.error).toMatch(/no model loaded/);
  });

  it("forwards the Authorization header when present", async () => {
    const paths = defaultStorePaths(mkdtempSync(join(tmpdir(), "mba-proxy-")));
    const { fetch: fetchImpl, calls } = upstreamFetch(() =>
      new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    );
    const app = createMbaServiceApp({ paths, upstreamUrl: UPSTREAM, fetch: fetchImpl });

    await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer secret-key" },
      body: JSON.stringify(CHAT_BODY),
    });

    const fwdHeaders = new Headers(calls[0]?.init?.headers);
    expect(fwdHeaders.get("authorization")).toBe("Bearer secret-key");
  });
});

describe("model proxy — registry routing (ADR-0101 Step 1b)", () => {
  const MODEL_A = "/models/a/A.gguf";
  const MODEL_B = "/models/b/B.gguf";

  it("routes by the request's model field to the matching registry entry", async () => {
    const paths = defaultStorePaths(mkdtempSync(join(tmpdir(), "mba-proxy-")));
    writeRegistry(paths.upstreamsPath, [
      entry("llama-cpp-8080", MODEL_A, 8080, "2026-01-01T00:00:00.000Z"),
      entry("llama-cpp-8082", MODEL_B, 8082, "2026-01-02T00:00:00.000Z"),
    ]);
    const { fetch: fetchImpl, chatCalls } = registryFetch({ health: { 8080: true, 8082: true } });
    const app = createMbaServiceApp({ paths, fetch: fetchImpl });

    const resA = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...CHAT_BODY, model: MODEL_A }),
    });
    expect(resA.status).toBe(200);

    const resB = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...CHAT_BODY, model: MODEL_B }),
    });
    expect(resB.status).toBe(200);

    expect(chatCalls).toEqual([8080, 8082]);
  });

  it("resolves a catalog id to the registry entry serving its weights file", async () => {
    const paths = defaultStorePaths(mkdtempSync(join(tmpdir(), "mba-proxy-")));
    const adapterDir = mkdtempSync(join(tmpdir(), "mba-adapter-"));
    writeAdapter(adapterDir, "qwen/qwen3.8-27b/qwen3.8-27b.yaml", "qwen3.8-27b", MODEL_A);
    writeRegistry(paths.upstreamsPath, [
      entry("llama-cpp-8080", MODEL_A, 8080, "2026-01-01T00:00:00.000Z"),
    ]);
    const { fetch: fetchImpl, chatCalls } = registryFetch({ health: { 8080: true } });
    const app = createMbaServiceApp({ paths, adapterDir, fetch: fetchImpl });

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...CHAT_BODY, model: "qwen3.8-27b" }),
    });

    expect(res.status).toBe(200);
    expect(chatCalls).toEqual([8080]);
  });

  it("returns 503 'no model loaded' when the registry is empty and no upstream is set", async () => {
    const paths = defaultStorePaths(mkdtempSync(join(tmpdir(), "mba-proxy-")));
    const { fetch: fetchImpl } = registryFetch({ health: {} });
    const app = createMbaServiceApp({ paths, fetch: fetchImpl });

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(CHAT_BODY),
    });

    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/no model loaded/);
  });

  it("returns 503 'not running' when the matching entry is unhealthy", async () => {
    const paths = defaultStorePaths(mkdtempSync(join(tmpdir(), "mba-proxy-")));
    writeRegistry(paths.upstreamsPath, [
      entry("llama-cpp-8080", MODEL_A, 8080, "2026-01-01T00:00:00.000Z"),
    ]);
    const { fetch: fetchImpl, chatCalls } = registryFetch({ health: { 8080: false } });
    const app = createMbaServiceApp({ paths, fetch: fetchImpl });

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...CHAT_BODY, model: MODEL_A }),
    });

    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/not running/);
    expect(chatCalls).toEqual([]);
  });

  it("caches a health probe within the TTL (no second probe)", async () => {
    const paths = defaultStorePaths(mkdtempSync(join(tmpdir(), "mba-proxy-")));
    writeRegistry(paths.upstreamsPath, [
      entry("llama-cpp-8080", MODEL_A, 8080, "2026-01-01T00:00:00.000Z"),
    ]);
    const { fetch: fetchImpl, healthCalls } = registryFetch({ health: { 8080: true } });
    const app = createMbaServiceApp({ paths, fetch: fetchImpl });

    await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...CHAT_BODY, model: MODEL_A }),
    });
    await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...CHAT_BODY, model: MODEL_A }),
    });

    expect(healthCalls).toEqual([8080]);
  });

  it("re-probes after the TTL expires", async () => {
    const paths = defaultStorePaths(mkdtempSync(join(tmpdir(), "mba-proxy-")));
    writeRegistry(paths.upstreamsPath, [
      entry("llama-cpp-8080", MODEL_A, 8080, "2026-01-01T00:00:00.000Z"),
    ]);
    const { fetch: fetchImpl, healthCalls } = registryFetch({ health: { 8080: true } });
    // Short TTL so the expiry is observable without a fake clock.
    const app = createMbaServiceApp({ paths, fetch: fetchImpl, healthTtlMs: 50 });

    await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...CHAT_BODY, model: MODEL_A }),
    });
    await new Promise((r) => setTimeout(r, 60));
    await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...CHAT_BODY, model: MODEL_A }),
    });

    expect(healthCalls).toEqual([8080, 8080]);
  });

  it("falls back to the static upstream when the registry is empty", async () => {
    const paths = defaultStorePaths(mkdtempSync(join(tmpdir(), "mba-proxy-")));
    const { fetch: fetchImpl, chatCalls } = registryFetch({ health: { 8081: true } });
    const app = createMbaServiceApp({ paths, upstreamUrl: UPSTREAM, fetch: fetchImpl });

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(CHAT_BODY),
    });

    expect(res.status).toBe(200);
    expect(chatCalls).toEqual([8081]);
  });
});
