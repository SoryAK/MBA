/**
 * Contract tests for the in-memory server log buffer (Feature 2).
 *
 * Replaces the per-port `.log`/`.err` files: llama-server stdout/stderr are
 * piped into a bounded ring buffer (live view for `mba servers logs`) and
 * teed to the daemon stdout (→ systemd journal for persistence).
 */

import { describe, expect, it } from "vitest";
import {
  ServerLogBuffer,
  getOrCreateLogBuffer,
  getLogBuffer,
  removeLogBuffer,
} from "./server-log-buffer.js";
import type { LifecycleSeams } from "./server-lifecycle.js";

describe("ServerLogBuffer (bounded ring, line-oriented)", () => {
  it("captures complete lines in order", () => {
    const buf = new ServerLogBuffer();
    buf.append("line one\nline two\n");
    expect(buf.lines()).toEqual(["line one", "line two"]);
  });

  it("holds a partial line until its newline arrives", () => {
    const buf = new ServerLogBuffer();
    buf.append("partial");
    expect(buf.lines()).toEqual([]);
    buf.append(" line\n");
    expect(buf.lines()).toEqual(["partial line"]);
  });

  it("splits a chunk that contains several lines", () => {
    const buf = new ServerLogBuffer();
    buf.append("a\nb\nc\n");
    expect(buf.lines()).toEqual(["a", "b", "c"]);
  });

  it("treats a trailing newline as a complete line", () => {
    const buf = new ServerLogBuffer();
    buf.append("done\n");
    expect(buf.lines()).toEqual(["done"]);
  });

  it("ignores empty lines from blank output", () => {
    const buf = new ServerLogBuffer();
    buf.append("\n\n");
    expect(buf.lines()).toEqual([]);
  });

  it("lines(n) returns only the last n lines", () => {
    const buf = new ServerLogBuffer();
    buf.append("1\n2\n3\n4\n5\n");
    expect(buf.lines(2)).toEqual(["4", "5"]);
    expect(buf.lines(100)).toEqual(["1", "2", "3", "4", "5"]);
  });

  it("drops the oldest lines when the buffer exceeds its byte bound", () => {
    const buf = new ServerLogBuffer(64); // tiny bound for the test
    // 8 distinct lines × 8 bytes each (7 chars + "\n") = 64 bytes — fits exactly.
    for (let i = 0; i < 8; i++) buf.append(`L${String(i).padStart(6, "0")}\n`);
    expect(buf.lines()).toHaveLength(8);
    // One more line pushes past the bound → oldest lines are evicted.
    buf.append("LNEWLINE\n");
    const lines = buf.lines();
    expect(lines[lines.length - 1]).toBe("LNEWLINE");
    // The oldest line (L000000) was evicted to make room.
    expect(lines).not.toContain("L000000");
    expect(lines.length).toBeLessThan(9);
  });

  it("keeps the newest lines after eviction", () => {
    const buf = new ServerLogBuffer(32);
    buf.append("aaaa\nbbbb\ncccc\n"); // 12 bytes
    buf.append("dddd\neeee\n"); // 10 bytes → 22
    buf.append("ffff\ngggg\n"); // 10 bytes → 32, still fits
    buf.append("hhhh\n"); // 5 bytes → 37 > 32 → evict oldest
    const lines = buf.lines();
    expect(lines[lines.length - 1]).toBe("hhhh");
    expect(lines[0]).not.toBe("aaaa");
  });

  it("subscribe delivers each new line as it completes", () => {
    const buf = new ServerLogBuffer();
    const seen: string[] = [];
    buf.subscribe((line) => seen.push(line));
    buf.append("one\ntwo\n");
    expect(seen).toEqual(["one", "two"]);
  });

  it("unsubscribe stops delivery", () => {
    const buf = new ServerLogBuffer();
    const seen: string[] = [];
    const off = buf.subscribe((line) => seen.push(line));
    buf.append("one\n");
    off();
    buf.append("two\n");
    expect(seen).toEqual(["one"]);
  });

  it("multiple subscribers each receive every line", () => {
    const buf = new ServerLogBuffer();
    const a: string[] = [];
    const b: string[] = [];
    buf.subscribe((l) => a.push(l));
    buf.subscribe((l) => b.push(l));
    buf.append("x\n");
    expect(a).toEqual(["x"]);
    expect(b).toEqual(["x"]);
  });
});

describe("port-keyed log buffer registry (seams-attached)", () => {
  it("getOrCreateLogBuffer returns the same instance for the same port", () => {
    const seams: LifecycleSeams = {};
    const a = getOrCreateLogBuffer(8080, seams);
    const b = getOrCreateLogBuffer(8080, seams);
    expect(a).toBe(b);
  });

  it("different ports get different buffers", () => {
    const seams: LifecycleSeams = {};
    expect(getOrCreateLogBuffer(8080, seams)).not.toBe(
      getOrCreateLogBuffer(9123, seams),
    );
  });

  it("getLogBuffer returns undefined for a port that was never created", () => {
    const seams: LifecycleSeams = {};
    expect(getLogBuffer(8080, seams)).toBeUndefined();
  });

  it("removeLogBuffer drops the buffer (a later getOrCreate is fresh)", () => {
    const seams: LifecycleSeams = {};
    const first = getOrCreateLogBuffer(8080, seams);
    first.append("old\n");
    removeLogBuffer(8080, seams);
    expect(getLogBuffer(8080, seams)).toBeUndefined();
    const second = getOrCreateLogBuffer(8080, seams);
    expect(second).not.toBe(first);
    expect(second.lines()).toEqual([]);
  });

  it("registries are isolated per seams instance", () => {
    const a: LifecycleSeams = {};
    const b: LifecycleSeams = {};
    getOrCreateLogBuffer(8080, a);
    expect(getLogBuffer(8080, b)).toBeUndefined();
  });
});
