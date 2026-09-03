/**
 * Tests for evaluateBcbEscalation (ADR-0101 Step 2).
 *
 * Copied from C-Yard `packages/proxy/src/server.ts`, adapted:
 * - session key is `sha256(harness + systemPrompt)` (was `sha256(systemPrompt)`),
 *   so no-prompt requests isolate per-harness instead of sharing one counter.
 * - degrades to "no escalation" (returns undefined) when the harness is
 *   unknown AND the system prompt is empty — there is no stable identity to
 *   key the counter on.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { evaluateBcbEscalation } from "./escalate.js";
import { openBcbDb } from "./kill-state.js";
import type { ToolCircuitBreakerConfig, ToolCircuitBreakerTrip } from "./types.js";
import type { Harness } from "./fingerprint.js";

let dir: string;
let db: DatabaseSync;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "bcb-escalate-"));
  db = openBcbDb(join(dir, "kill-state.db"));
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A trip on read_file / eofOverflow for a fixed target. */
const trip = (targetKey = "file.txt:1-100"): ToolCircuitBreakerTrip => ({
  tool: "read_file",
  rule: "eofOverflow",
  toolCallId: "call_1",
  message: "out of bounds",
  meta: {},
  targetKey,
});

/** Ladder: nudge on first trip, kill after 2 ignored trips. */
const config: ToolCircuitBreakerConfig = {
  tools: {
    read_file: {
      eofOverflow: {
        enabled: true,
        escalation: {
          tiers: [
            { tier: "nudge", afterIgnoredTrips: 0 },
            { tier: "kill", afterIgnoredTrips: 2, action: "return-error" },
          ],
          counterMode: "monotonic",
        },
      },
    },
  },
};

describe("evaluateBcbEscalation", () => {
  it("returns undefined when there is no db", () => {
    expect(evaluateBcbEscalation(trip(), config, "prompt", "cline", undefined)).toBeUndefined();
  });

  it("degrades to no escalation when harness is unknown and prompt is empty", () => {
    expect(evaluateBcbEscalation(trip(), config, "", "unknown", db)).toBeUndefined();
  });

  it("nudges on the first trip", () => {
    const r = evaluateBcbEscalation(trip(), config, "prompt", "cline", db);
    expect(r).toEqual({ tier: "nudge", ignoredTrips: 0 });
  });

  it("escalates to kill after the configured ignored trips, then resets", () => {
    // First trip already consumed above in a fresh target; use a new target.
    const t = trip("other.txt:1-50");
    expect(evaluateBcbEscalation(t, config, "prompt", "cline", db)).toEqual({
      tier: "nudge",
      ignoredTrips: 0,
    });
    expect(evaluateBcbEscalation(t, config, "prompt", "cline", db)).toEqual({
      tier: "nudge",
      ignoredTrips: 1,
    });
    const kill = evaluateBcbEscalation(t, config, "prompt", "cline", db);
    expect(kill?.tier).toBe("kill");
    expect(kill?.ignoredTrips).toBe(2);
    expect(kill?.kill).toMatchObject({
      tool: "read_file",
      rule: "eofOverflow",
      action: "return-error",
      ignoredTrips: 2,
      targetKey: "other.txt:1-50",
    });
    // After a kill the counter is reset: next trip is a fresh nudge.
    expect(evaluateBcbEscalation(t, config, "prompt", "cline", db)).toEqual({
      tier: "nudge",
      ignoredTrips: 0,
    });
  });

  it("isolates counters per harness (same prompt, different harness)", () => {
    const t = trip("iso.txt:1-10");
    // cline harness: first trip.
    expect(evaluateBcbEscalation(t, config, "prompt", "cline", db)).toEqual({
      tier: "nudge",
      ignoredTrips: 0,
    });
    // continue harness: independent counter, also first trip.
    expect(evaluateBcbEscalation(t, config, "prompt", "continue", db)).toEqual({
      tier: "nudge",
      ignoredTrips: 0,
    });
    // cline again: second trip (its own counter advanced).
    expect(evaluateBcbEscalation(t, config, "prompt", "cline", db)).toEqual({
      tier: "nudge",
      ignoredTrips: 1,
    });
  });

  it("isolates counters per system prompt (same harness, different prompt)", () => {
    const t = trip("iso2.txt:1-10");
    expect(evaluateBcbEscalation(t, config, "prompt-A", "cline", db)).toEqual({
      tier: "nudge",
      ignoredTrips: 0,
    });
    expect(evaluateBcbEscalation(t, config, "prompt-B", "cline", db)).toEqual({
      tier: "nudge",
      ignoredTrips: 0,
    });
  });
});
