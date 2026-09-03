/**
 * Model-request proxy (ADR-0101 Step 1 — the daemon IS the proxy).
 *
 * A thin man-in-the-middle for OpenAI-compatible model requests. The daemon
 * forwards the raw request body to the upstream model server and pipes the
 * response back verbatim — no stream/non-stream branching, no body mutation.
 * The same byte-pipe works for a JSON completion and an SSE stream, because
 * the upstream's `content-type` and body are passed through untouched.
 *
 * Upstream resolution (Step 1b — registry routing):
 *   The daemon already tracks every booted server in the upstream registry
 *   (`upstreams.json`). Instead of a single static `MBA_UPSTREAM_URL`, the
 *   proxy resolves the upstream PER REQUEST from the registry, keyed by the
 *   request's `model` field:
 *
 *     request.model
 *       → catalog id?   (adapter YAML: id → weights file)
 *       → GGUF path?    (exact or basename match vs registry modelFile)
 *       → ollama tag?   (exact match vs ollama entries' modelFile)
 *       → registry candidates (newest-first)
 *       → health-probe each (TTL-cached)
 *       → forward to the first healthy one
 *
 *   The static `MBA_UPSTREAM_URL` is a FALLBACK ONLY: it is used when the
 *   registry is empty (dumb-proxy mode). A non-empty registry with no match
 *   is a real error (503), not a silent fall-through.
 *
 * Health is TRUST-BUT-VERIFIED: the proxy does not assume a registry entry
 * is alive. It probes each candidate, caching the result for `healthTtlMs`
 * (default 5s) so a burst of requests costs one probe, not one per request.
 * No background sweeper, no timers — a dead server is blind for at most the
 * TTL, then re-probed.
 *
 * Capability-block shape (ADR-0051 idiom): explicit params in, a mountable
 * hono sub-app out. The route owns the "why/when" (status codes, error
 * classification); this block owns the "how" (resolve + forward + pipe).
 *
 * Error contract:
 *   - registry empty, no upstreamUrl   → 503 { error: "no model loaded …" }
 *   - registry non-empty, no match     → 503 { error: "unknown model …" }
 *   - match found, none healthy        → 503 { error: "… not running …" }
 *   - fetch throws (unreachable)       → 502 { error: "upstream unreachable: …" }
 *   - upstream non-2xx                 → status + body passed through unchanged
 */

import { Hono } from "hono";
import type { Context } from "hono";
import type { StatusCode } from "hono/utils/http-status";
import type { DatabaseSync } from "node:sqlite";
import { readRegistry, listUpstreams, type UpstreamEntry } from "./upstream-registry.js";
import { readModelCatalog } from "./model-catalog.js";
import { probeEntryHealth } from "./server-types.js";
import { intervene } from "./intervention.js";
import type { ToolCircuitBreakerConfig } from "../bcb/types.js";

export interface ModelProxyOptions {
  /**
   * Static upstream base URL (e.g. `http://127.0.0.1:8081`). FALLBACK ONLY —
   * used when the registry is empty (dumb-proxy mode). Ignored when the
   * registry has entries.
   */
  readonly upstreamUrl?: string;
  /** Path to the upstream registry (`upstreams.json`). */
  readonly registryPath?: string;
  /** Adapter tree root, for catalog-id → weights-file resolution. */
  readonly adapterDir?: string;
  /** Health-probe cache TTL in ms (default 5000). */
  readonly healthTtlMs?: number;
  /** Injectable fetch for the upstream call + health probes (tests). */
  readonly fetch?: typeof fetch;
  /**
   * TCB config getter (ADR-0101 Step 2). A getter — not a value — so the
   * proxy always sees the latest config after a `/set_rules` mutation. When
   * omitted, intervention is a no-op and the body forwards verbatim.
   */
  readonly tcbConfig?: () => ToolCircuitBreakerConfig;
  /**
   * Kill-state DB handle (ADR-0101 Step 2). `undefined` disables escalation
   * (trips still rewrite tool results, but no kill-state is persisted).
   */
  readonly bcbDb?: DatabaseSync;
}

/** Strip a trailing slash so `${base}/v1/…` never double-slashes. */
function normalizeBase(url: string): string {
  return url.replace(/\/+$/, "");
}

/** A cached health verdict for one registry entry. */
interface HealthVerdict {
  readonly healthy: boolean;
  readonly at: number;
}

/**
 * Resolve the request's `model` field to a weights-file key for registry
 * matching. A catalog id maps to its weights file; anything else (a GGUF
 * path or an ollama tag) is used as-is — `listUpstreams` matches GGUF paths
 * by exact/basename and ollama tags by exact `modelFile`.
 */
function resolveModelKey(model: string, adapterDir: string | undefined): string {
  if (adapterDir) {
    try {
      const catalog = readModelCatalog(adapterDir);
      const hit = catalog.find((e) => e.id === model);
      if (hit?.modelFile) return hit.modelFile;
    } catch {
      // A corrupt adapter must not break model serving — degrade to using
      // the model field as-is (GGUF path / ollama tag still resolve).
    }
  }
  return model;
}

/**
 * Build the model-request sub-app. Mount it at `/v1` on the service app so
 * the full path is `/v1/chat/completions`.
 */
export function createModelProxyRoutes(opts: ModelProxyOptions): Hono {
  const app = new Hono();
  const fetchImpl = opts.fetch ?? fetch;
  const ttlMs = opts.healthTtlMs ?? 5000;

  // Per-sub-app health cache (closure-level, not global) so each mounted
  // proxy — and each test — has its own verdicts. Keyed by entry id.
  const healthCache = new Map<string, HealthVerdict>();

  /** Probe an entry's health, honoring the TTL cache. */
  async function isHealthy(entry: UpstreamEntry): Promise<boolean> {
    const now = Date.now();
    const cached = healthCache.get(entry.id);
    if (cached && now - cached.at < ttlMs) return cached.healthy;
    const healthy = await probeEntryHealth(entry, fetchImpl);
    healthCache.set(entry.id, { healthy, at: now });
    return healthy;
  }

  /** Forward the raw body to `base` and pipe the response back verbatim. */
  async function forward(c: Context, base: string, body: string): Promise<Response> {
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
      upstreamRes = await fetchImpl(`${normalizeBase(base)}/v1/chat/completions`, {
        method: "POST",
        headers: fwdHeaders,
        body,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: `upstream unreachable: ${msg}` }, 502);
    }

    // Pipe the upstream response back verbatim — status, content-type, and
    // body (JSON or SSE stream) all pass through untouched.
    return c.newResponse(upstreamRes.body, upstreamRes.status as StatusCode, {
      "content-type": upstreamRes.headers.get("content-type") ?? "application/json",
    });
  }

  app.post("/chat/completions", async (c) => {
    // Read the raw body. The request is JSON, so the text round-trips exactly
    // through UTF-8; forwarding the string keeps the forwarded body
    // byte-identical to what the client sent (unless intervention mutates it).
    const body = await c.req.text();

    // --- TCB intervention (ADR-0101 Step 2) ------------------------------
    // Guard at the door: inspect every request that passes. When no TCB
    // config is wired in, this is a no-op and the body forwards verbatim.
    // A kill short-circuits here — the upstream is never touched.
    let forwardBody = body;
    if (opts.tcbConfig) {
      const result = intervene(
        body,
        c.req.header("user-agent") ?? "",
        opts.tcbConfig(),
        opts.bcbDb,
      );
      if (result.action === "kill") {
        return result.response;
      }
      forwardBody = result.body;
    }

    let model: string | undefined;
    try {
      const parsed = JSON.parse(forwardBody) as { model?: unknown };
      model = typeof parsed.model === "string" ? parsed.model : undefined;
    } catch {
      model = undefined;
    }

    // --- Registry routing (Step 1b) --------------------------------------
    const registry = opts.registryPath ? readRegistry(opts.registryPath) : [];

    if (registry.length === 0) {
      // Dumb-proxy mode: no booted servers tracked. Fall back to the static
      // upstream if one is configured; otherwise nothing is loaded.
      if (opts.upstreamUrl) {
        return forward(c, opts.upstreamUrl, forwardBody);
      }
      return c.json(
        { error: "no model loaded — boot one with `mba servers boot <model> <port>`" },
        503,
      );
    }

    // Registry is the source of truth. Resolve the model to a weights key.
    if (!model) {
      return c.json(
        { error: "unknown model — the request body has no `model` field" },
        503,
      );
    }
    const modelKey = resolveModelKey(model, opts.adapterDir);
    const candidates = listUpstreams(registry, modelKey);

    if (candidates.length === 0) {
      return c.json(
        {
          error: `unknown model: ${model} — no booted server matches (registry has ${registry.length} entr${registry.length === 1 ? "y" : "ies"})`,
        },
        503,
      );
    }

    // Walk candidates newest-first; forward to the first healthy one.
    for (const candidate of candidates) {
      if (await isHealthy(candidate)) {
        return forward(c, `http://127.0.0.1:${candidate.port}`, forwardBody);
      }
    }

    // Every candidate failed its probe.
    return c.json(
      {
        error: `model ${model} is not running — all ${candidates.length} matching server${candidates.length === 1 ? "" : "s"} failed their health probe`,
      },
      503,
    );
  });

  return app;
}
