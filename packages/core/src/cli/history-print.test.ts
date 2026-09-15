import { afterEach, describe, expect, it } from "vitest";
import {
  formatHistoryEventLine,
  formatHistoryLines,
  formatHistoryTime,
} from "./history-print.js";
import type { ModelHistoryEvent } from "./types.js";

const tool: ModelHistoryEvent = {
  ts: Date.UTC(2026, 8, 14, 23, 3, 1),
  kind: "tool",
  tool: "read_file",
  toolCallId: "call_1",
  rule: "",
  harness: "cursor",
  targetKey: "",
  tier: "",
};

const trip: ModelHistoryEvent = {
  ...tool,
  kind: "trip",
  rule: "eofOverflow",
  targetKey: "f:1-100",
  tier: "nudge",
};

describe("history-print", () => {
  const prevNoColor = process.env.NO_COLOR;

  afterEach(() => {
    if (prevNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = prevNoColor;
  });

  it("prints UTC time without milliseconds", () => {
    expect(formatHistoryTime(Date.UTC(2026, 8, 14, 23, 3, 1))).toBe("2026-09-14 23:03:01Z");
  });

  it("names a trip by rule and tier, a tool by tool name", () => {
    process.env.NO_COLOR = "1";
    expect(formatHistoryEventLine(trip)).toContain("trip");
    expect(formatHistoryEventLine(trip)).toContain("eofOverflow");
    expect(formatHistoryEventLine(trip)).toContain("nudge");
    expect(formatHistoryEventLine(tool)).toContain("tool");
    expect(formatHistoryEventLine(tool)).toContain("read_file");
    expect(formatHistoryEventLine(tool)).not.toContain("nudge");
  });

  it("prints none when the ledger is empty", () => {
    process.env.NO_COLOR = "1";
    const lines = formatHistoryLines("qwen3-coder-30b", []);
    expect(lines[0]).toContain("history");
    expect(lines[0]).toContain("qwen3-coder-30b");
    expect(lines.join("\n")).toContain("none");
  });
});
