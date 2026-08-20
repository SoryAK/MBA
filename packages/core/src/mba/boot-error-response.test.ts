/**
 * Contract tests for boot error responses (Step 7).
 */

import { describe, expect, it } from "vitest";
import { ServerBootError } from "./bouncer.js";
import { handleServerBootError, type ServerBootErrorResponse } from "./boot-error-response.js";

// Mock Hono Context
class MockContext {
  private responseBody: any;
  private responseStatus: number = 200;
  private responseHeaders: Map<string, string> = new Map();

  json(body: any, status?: number) {
    this.responseBody = body;
    if (status !== undefined) {
      this.responseStatus = status;
    }
    return new Response(JSON.stringify(body), {
      status: this.responseStatus,
      headers: {
        "Content-Type": "application/json",
      },
    });
  }

  getResponseBody() {
    return this.responseBody;
  }

  getResponseStatus() {
    return this.responseStatus;
  }
}

describe("handleServerBootError", () => {
  it("returns 503 for boot-failed error", () => {
    const err = new ServerBootError("qwen3-coder", "boot-failed", "llama-server crashed");
    const ctx = new MockContext();

    const response = handleServerBootError(ctx as any, err);

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("10");
  });

  it("returns 503 for reboot-in-progress error", () => {
    const err = new ServerBootError("qwen3-coder", "reboot-in-progress", "rebooting server");
    const ctx = new MockContext();

    const response = handleServerBootError(ctx as any, err);

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("10");
  });

  it("returns 500 for missing-env error", () => {
    const err = new ServerBootError("qwen3-coder", "missing-env", "LLAMA_SERVER_BIN not set");
    const ctx = new MockContext();

    const response = handleServerBootError(ctx as any, err);

    expect(response.status).toBe(500);
    // Config errors should NOT have Retry-After (not transient)
    expect(response.headers.get("Retry-After")).toBeNull();
  });

  it("includes error details in response body", async () => {
    const err = new ServerBootError("qwen3-coder", "boot-failed", "test error message");
    const ctx = new MockContext();

    const response = handleServerBootError(ctx as any, err);
    const body = (await response.json()) as ServerBootErrorResponse;

    expect(body.error.message).toBe("test error message");
    expect(body.error.type).toBe("server_boot_error");
    expect(body.error.model).toBe("qwen3-coder");
  });

  it("includes correct error codes", async () => {
    const testCases: Array<[ServerBootError["reason"], string]> = [
      ["missing-env", "configuration_error"],
      ["reboot-in-progress", "server_booting"],
      ["boot-failed", "boot_failed"],
    ];

    for (const [reason, expectedCode] of testCases) {
      const err = new ServerBootError("test", reason, "msg");
      const ctx = new MockContext();

      const response = handleServerBootError(ctx as any, err);
      const body = (await response.json()) as ServerBootErrorResponse;

      expect(body.error.code).toBe(expectedCode);
    }
  });

  it("includes retry_after in body for transient errors", async () => {
    const err = new ServerBootError("test", "boot-failed", "msg");
    const ctx = new MockContext();

    const response = handleServerBootError(ctx as any, err);
    const body = (await response.json()) as ServerBootErrorResponse;

    expect(body.retry_after).toBe(10);
  });

  it("excludes retry_after for config errors", async () => {
    const err = new ServerBootError("test", "missing-env", "msg");
    const ctx = new MockContext();

    const response = handleServerBootError(ctx as any, err);
    const body = (await response.json()) as ServerBootErrorResponse;

    expect(body.retry_after).toBeUndefined();
  });
});
