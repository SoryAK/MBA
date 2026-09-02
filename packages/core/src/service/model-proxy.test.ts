import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createMbaServiceApp } from "./server.js";
import { defaultStorePaths } from "./config-store.js";

const UPSTREAM = "http://127.0.0.1:8081";

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
    expect(body.error).toMatch(/no upstream configured/);
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
