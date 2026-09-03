/**
 * Tests for the SQLite-backed BCB kill-state (ADR-0101 Step 2).
 *
 * Copied from C-Yard `packages/proxy/src/db/bcb-kill-state.ts`. Tracks, per
 * session, how many times in a row the model ignored a TCB trip for the same
 * tool/rule/target. Uses `node:sqlite` (Node 22 built-in) — no native dep.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  incrementBcbKillState,
  openBcbDb,
  readBcbKillState,
  resetBcbKillState,
} from "./kill-state.js";
import type { BcbKillStateUpdate } from "./kill-state.js";

let dir: string;
let db: ReturnType<typeof openBcbDb>;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "bcb-kill-state-"));
  db = openBcbDb(join(dir, "bcb-kill-state.db"));
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const key = (over: Partial<BcbKillStateUpdate> = {}): BcbKillStateUpdate => ({
  sessionId: "sess-1",
  tool: "read_file",
  rule: "eofOverflow",
  targetKey: "/tmp/x.ts:requested=10,actual=5",
  ...over,
});

describe("readBcbKillState", () => {
  it("returns 0 when no row exists", () => {
    expect(readBcbKillState(db, key({ sessionId: "missing" }))).toBe(0);
  });
});

describe("incrementBcbKillState", () => {
  it("starts at 1 and increments on repeat", () => {
    const k = key({ sessionId: "inc-1" });
    expect(incrementBcbKillState(db, k)).toBe(1);
    expect(incrementBcbKillState(db, k)).toBe(2);
    expect(incrementBcbKillState(db, k)).toBe(3);
  });

  it("keeps separate counters per target key", () => {
    const a = key({ sessionId: "inc-2", targetKey: "target-a" });
    const b = key({ sessionId: "inc-2", targetKey: "target-b" });
    expect(incrementBcbKillState(db, a)).toBe(1);
    expect(incrementBcbKillState(db, a)).toBe(2);
    expect(incrementBcbKillState(db, b)).toBe(1);
  });

  it("keeps separate counters per session", () => {
    const a = key({ sessionId: "sess-a" });
    const b = key({ sessionId: "sess-b" });
    expect(incrementBcbKillState(db, a)).toBe(1);
    expect(incrementBcbKillState(db, a)).toBe(2);
    expect(incrementBcbKillState(db, b)).toBe(1);
  });
});

describe("resetBcbKillState", () => {
  it("clears the counter for a session/tool/rule (any target)", () => {
    const k = key({ sessionId: "reset-1" });
    incrementBcbKillState(db, k);
    incrementBcbKillState(db, k);
    expect(readBcbKillState(db, k)).toBe(2);
    resetBcbKillState(db, "reset-1", "read_file", "eofOverflow");
    expect(readBcbKillState(db, k)).toBe(0);
  });

  it("does not affect other tools in the same session", () => {
    const k1 = key({ sessionId: "reset-2", tool: "read_file" });
    const k2 = key({ sessionId: "reset-2", tool: "write_file" });
    incrementBcbKillState(db, k1);
    incrementBcbKillState(db, k2);
    resetBcbKillState(db, "reset-2", "read_file", "eofOverflow");
    expect(readBcbKillState(db, k1)).toBe(0);
    expect(readBcbKillState(db, k2)).toBe(1);
  });
});

describe("openBcbDb", () => {
  it("is idempotent — reopening an existing db keeps data", () => {
    const p = join(dir, "reopen.db");
    const first = openBcbDb(p);
    const k = key({ sessionId: "reopen-1" });
    incrementBcbKillState(first, k);
    first.close();
    const second = openBcbDb(p);
    expect(readBcbKillState(second, k)).toBe(1);
    second.close();
  });
});
