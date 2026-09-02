/**
 * Model-request proxy (ADR-0101 Step 1 — the daemon IS the proxy).
 *
 * A thin man-in-the-middle for OpenAI-compatible model requests. The daemon
 * forwards the raw request body to the upstream llama-server and pipes the
 * response back verbatim — no stream/non-stream branching, no body parsing.
 * The same byte-pipe works for a JSON completion and an SSE stream, because
 * the upstream's `content-type` and body are passed through untouched.
 *
 * Capability-block shape (ADR-0051 idiom): explicit params in, a mountable
 * hono sub-app out. The route owns the "why/when" (status codes, error
 * classification); this block owns the "how" (the forward + pipe).
 *
 * Error contract:
 *   - no upstream configured        → 503 { error: "no upstream configured …" }
 *   - fetch throws (unreachable)    → 502 { error: "upstream unreachable: …" }
 *   - upstream non-2xx              → status + body passed through unchanged
 */

import { Hono } from "hono";
import type { StatusCode } from "hono/utils/http-status";

export interface ModelProxyOptions {
  /** Upstream llama-server base URL (e.g. `http://127.0.0.1:8081`). */
  readonly upstreamUrl?: string;
  /** Injectable fetch for the upstream call (tests). */
  readonly fetch?: typeof fetch;
}

/** Strip a trailing slash so `${base}/v1/…` never double-slashes. */
function normalizeBase(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * Build the model-request sub-app. Mount it at `/v1` on the service app so
 * the full path is `/v1/chat/completions`.
 */
export function createModelProxyRoutes(opts: ModelProxyOptions): Hono {
  const app = new Hono();
  const fetchImpl = opts.fetch ?? fetch;

  app.post("/chat/completions", async (c) => {
    const upstreamUrl = opts.upstreamUrl;
    if (!upstreamUrl) {
      return c.json({ error: "no upstream configured (set MBA_UPSTREAM_URL)" }, 503);
    }

    // Read the raw body and forward it verbatim. The request is JSON, so the
    // text round-trips exactly through UTF-8; forwarding the string keeps the
    // forwarded body byte-identical to what the client sent.
    const body = await c.req.text();

    // Forward the request headers, but only the ones a proxy should pass on.
    // Authorization is the one that matters for a keyed upstream; the rest
    // (host, content-length, connection) are hop-by-hop and must not leak.
    const fwdHeaders = new Headers();
    const auth = c.req.header("authorization");
    if (auth) fwdHeaders.set("authorization", auth);
    const contentType = c.req.header("content-type");
    if (contentType) fwdHeaders.set("content-type", contentType);

    let upstreamRes: Response;
    try {
      upstreamRes = await fetchImpl(`${normalizeBase(upstreamUrl)}/v1/chat/completions`, {
        method: "POST",
        headers: fwdHeaders,
        body,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: `upstream unreachable: ${msg}` }, 502);
    }

    // Pipe the upstream response back verbatim — status, content-type, and
    // body (JSON or SSE stream) all pass through untouched. The status is a
    // valid HTTP code from the upstream, so the StatusCode cast is safe.
    return c.newResponse(upstreamRes.body, upstreamRes.status as StatusCode, {
      "content-type": upstreamRes.headers.get("content-type") ?? "application/json",
    });
  });

  return app;
}
