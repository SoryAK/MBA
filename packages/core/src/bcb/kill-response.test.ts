/**
 * Tests for buildBcbKillResponse (ADR-0101 Step 2).
 *
 * Copied from C-Yard `packages/proxy/src/server.ts`. Builds the proxy
 * response for a kill action, or returns undefined to continue with a
 * (possibly mutated) body. The `wantStream` param from C-Yard was dropped —
 * the kill action alone determines the response shape.
 */

import { describe, expect, it } from "vitest";
import { buildBcbKillResponse } from "./kill-response.js";
import type { ToolCircuitBreakerKill } from "./types.js";

const kill = (action: ToolCircuitBreakerKill["action"]): ToolCircuitBreakerKill => ({
  tool: "read_file",
  rule: "eofOverflow",
  action,
  ignoredTrips: 2,
  targetKey: "file.txt:1-100",
  reason: "ignored 2 trip(s) for eofOverflow on read_file",
});

const bodyWithTools = (): Record<string, unknown> => ({
  model: "m",
  tools: [
    { type: "function", function: { name: "read_file", description: "d" } },
    { type: "function", function: { name: "write_file", description: "d" } },
  ],
});

describe("buildBcbKillResponse", () => {
  it("drop-tools: deletes tools and returns undefined (continue)", () => {
    const parsed = bodyWithTools();
    const res = buildBcbKillResponse(kill("drop-tools"), parsed);
    expect(res).toBeUndefined();
    expect(parsed.tools).toBeUndefined();
  });

  it("block-tool: filters out the killed tool and returns undefined (continue)", () => {
    const parsed = bodyWithTools();
    const res = buildBcbKillResponse(kill("block-tool"), parsed);
    expect(res).toBeUndefined();
    const tools = parsed.tools as Array<{ function?: { name?: string } }>;
    expect(tools.map((t) => t.function?.name)).toEqual(["write_file"]);
  });

  it("block-tool: leaves the body untouched when there is no tools array", () => {
    const parsed: Record<string, unknown> = { model: "m" };
    const res = buildBcbKillResponse(kill("block-tool"), parsed);
    expect(res).toBeUndefined();
    expect(parsed.tools).toBeUndefined();
  });

  it("return-error: 400 JSON with the bcb_kill error shape", async () => {
    const res = buildBcbKillResponse(kill("return-error"), bodyWithTools());
    expect(res).toBeDefined();
    expect(res!.status).toBe(400);
    expect(res!.headers.get("content-type")).toBe("application/json");
    const body = JSON.parse(await res!.text());
    expect(body.error).toMatchObject({
      type: "bcb_kill",
      param: "read_file",
      code: "eofOverflow",
    });
    expect(body.error.message).toContain("BCB kill");
  });

  it("close-stream: 200 SSE with a finish_reason stop and [DONE]", async () => {
    const res = buildBcbKillResponse(kill("close-stream"), bodyWithTools());
    expect(res).toBeDefined();
    expect(res!.status).toBe(200);
    expect(res!.headers.get("content-type")).toBe("text/event-stream");
    const text = await res!.text();
    expect(text).toContain("BCB kill");
    expect(text).toContain('"finish_reason":"stop"');
    expect(text).toContain("data: [DONE]");
  });
});
