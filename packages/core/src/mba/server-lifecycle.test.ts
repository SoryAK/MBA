/**
 * Contract tests for server-lifecycle orchestration (Step 4).
 *
 * Tests focus on the pure fetch-based logic (health check, warmup).
 * Process spawning/management is tested via integration on boot.
 */

import { describe, expect, it, vi, afterEach } from "vitest";
import { waitForHealth, sendWarmupRequest } from "./server-lifecycle.js";

describe("waitForHealth", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("succeeds when /health returns 200 on first poll", async () => {
    const mockFetch = vi.fn(async () => ({ ok: true, status: 200 }));
    globalThis.fetch = mockFetch as any;

    await waitForHealth(8080, 10000);

    expect(mockFetch).toHaveBeenCalledWith(
      "http://127.0.0.1:8080/health",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("retries on fetch failure, then succeeds", async () => {
    let callCount = 0;
    const mockFetch = vi.fn(async () => {
      callCount++;
      if (callCount === 1) {
        throw new Error("connection refused");
      }
      return { ok: true, status: 200 };
    });
    globalThis.fetch = mockFetch as any;

    await waitForHealth(8080, 10000);

    expect(mockFetch.mock.calls.length).toBeGreaterThan(1);
  });

  it("fails immediately on ok:false response", async () => {
    const mockFetch = vi.fn(async () => ({ ok: false, status: 503 }));
    globalThis.fetch = mockFetch as any;

    // With a very long deadline, this should keep polling
    // but it won't pass the ok check
    const promise = waitForHealth(8080, 100);
    
    await expect(promise).rejects.toThrow(/timed out/);
  });
});

describe("sendWarmupRequest", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("POSTs to /completion with n_predict", async () => {
    const mockFetch = vi.fn(async (_url: string, init?: { body?: string }) => ({ ok: true, status: 200 }));
    globalThis.fetch = mockFetch as any;

    await sendWarmupRequest(8080, 350);

    expect(mockFetch).toHaveBeenCalledWith(
      "http://127.0.0.1:8080/completion",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }),
    );
    const callArgs = mockFetch.mock.calls[0]!;
    const body = JSON.parse(callArgs[1]!.body!);
    expect(body.n_predict).toBe(350);
  });

  it("throws on non-200 response", async () => {
    const mockFetch = vi.fn(async () => ({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
    }));
    globalThis.fetch = mockFetch as any;

    await expect(sendWarmupRequest(8080, 350)).rejects.toThrow(/failed.*500/);
  });

  it("includes the prompt in the request body", async () => {
    const mockFetch = vi.fn(async (_url: string, init?: { body?: string }) => ({ ok: true }));
    globalThis.fetch = mockFetch as any;

    await sendWarmupRequest(8080, 42);

    const callArgs = mockFetch.mock.calls[0]!;
    const body = JSON.parse(callArgs[1]!.body!);
    expect(body).toHaveProperty("prompt");
    expect(body).toHaveProperty("n_predict", 42);
  });
});
