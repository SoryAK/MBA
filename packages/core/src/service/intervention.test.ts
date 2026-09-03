/**
 * Tests for the TCB intervention orchestrator (ADR-0101 Step 2).
 *
 * `intervene()` is the "guard at the door": it inspects every model request
 * that passes through the daemon, applies the Tool Circuit Breakers, and
 * either returns the (possibly mutated) body to forward, or a kill response
 * that short-circuits the request.
 *
 * The orchestrator is a pure capability block (ADR-0051 idiom): explicit
 * params in, a structured decision out. It owns the "how" (detect + escalate +
 * build the response); the proxy route owns the "why/when" (status codes,
 * forwarding).
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { intervene, type InterventionResult } from "./intervention.js";
import { openBcbDb } from "../bcb/kill-state.js";
import type { ToolCircuitBreakerConfig } from "../bcb/types.js";

let dir: string;
let db: DatabaseSync;
let smallFile: string; // 3 lines

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "mba-intervene-"));
  db = openBcbDb(join(dir, "kill-state.db"));
  smallFile = join(dir, "small.txt");
  writeFileSync(smallFile, "a\nb\nc");
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A config where read_file trips eofOverflow and escalates to kill. */
const config: ToolCircuitBreakerConfig = {
  tools: {
    read_file: {
      eofOverflow: {
        enabled: true,
        escalation: {
          tiers: [
            { tier: "nudge", afterIgnoredTrips: 0 },
            { tier: "kill", afterIgnoredTrips: 1, action: "return-error" },
          ],
          counterMode: "monotonic",
        },
      },
    },
  },
};

/**
 * A request whose last assistant turn reads past EOF of `smallFile`.
 *
 * `systemPrompt` is parameterized so each test can pin its own session key
 * (`sha256(harness + systemPrompt)`) and keep its kill-state counter isolated
 * from the other tests.
 */
function eofBody(systemPrompt = "you are cline"): Record<string, unknown> {
  return {
    model: "llama-3.1-8b",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: "read the file" },
      {
        role: "assistant",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "read_file", arguments: JSON.stringify({ filePath: smallFile, startLine: 1, endLine: 100 }) },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "a\nb\nc" },
    ],
  };
}

describe("intervene (ADR-0101 Step 2)", () => {
  it("forwards a clean request verbatim (no tool calls)", () => {
    const body = JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] });
    const res = intervene(body, "copilot", config, db);
    expect(res.action).toBe("forward");
    if (res.action === "forward") {
      expect(res.body).toBe(body); // byte-identical, not re-serialized
    }
  });

  it("nudges on the first eofOverflow trip and forwards the mutated body", () => {
    const body = JSON.stringify(eofBody());
    const res = intervene(body, "copilot", config, db);
    expect(res.action).toBe("forward");
    if (res.action === "forward") {
      // The body was mutated (a stop message injected into the tool result),
      // so it is re-serialized and no longer byte-identical.
      expect(res.body).not.toBe(body);
      const parsed = JSON.parse(res.body) as { messages: Array<{ role?: string }> };
      expect(parsed.messages.length).toBeGreaterThan(0);
    }
  });

  it("kills on the second ignored trip and returns a 400 response", () => {
    // Distinct system prompt → distinct session key, so this test's counter is
    // isolated from the nudge test above.
    const body = () => JSON.stringify(eofBody("you are cline-kill-test"));
    // First trip (nudge) — consumes the counter.
    intervene(body(), "copilot", config, db);
    // Second trip (kill).
    const res = intervene(body(), "copilot", config, db);
    expect(res.action).toBe("kill");
    if (res.action === "kill") {
      expect(res.response.status).toBe(400);
      expect(res.response.headers.get("content-type")).toBe("application/json");
    }
  });

  it("isolates kill-state per harness (same body, different UA)", () => {
    // A fresh target so the counter starts at zero for this harness.
    // Neutral system prompt: the harness must come from the UA alone, so the
    // two calls below resolve to different harnesses (cline vs continue) and
    // therefore different session keys / counters.
    const body = JSON.stringify({
      ...eofBody(),
      messages: [
        { role: "system", content: "you are a helpful assistant" },
        { role: "user", content: "read" },
        {
          role: "assistant",
          tool_calls: [
            {
              id: "call_x",
              type: "function",
              function: { name: "read_file", arguments: JSON.stringify({ filePath: smallFile, startLine: 1, endLine: 500 }) },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_x", content: "a\nb\nc" },
      ],
    });
    // cline harness: first trip → nudge.
    const cline = intervene(body, "cline", config, db);
    expect(cline.action).toBe("forward");
    // continue harness: independent counter, also first trip → nudge (not kill).
    const cont = intervene(body, "continue", config, db);
    expect(cont.action).toBe("forward");
  });

  it("degrades to forward when harness is unknown and there is no system prompt", () => {
    const body = JSON.stringify({
      model: "m",
      messages: [
        { role: "user", content: "read" },
        {
          role: "assistant",
          tool_calls: [
            {
              id: "call_y",
              type: "function",
              function: { name: "read_file", arguments: JSON.stringify({ filePath: smallFile, startLine: 1, endLine: 500 }) },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_y", content: "a\nb\nc" },
      ],
    });
    // No system prompt + unknown harness → no escalation, but the trip still
    // rewrites the tool result (nudge is the default tier), so it forwards.
    const res = intervene(body, "unknown-ua", config, db);
    expect(res.action).toBe("forward");
  });
});
