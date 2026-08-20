import { describe, expect, it } from "vitest";
import {
  applyToolCircuitBreakers,
  defaultToolCircuitBreakerConfig,
} from "./tool-circuit-breaker.js";
import type { ChatMessage } from "../chat-message.js";
import type { ToolCircuitBreakerConfig } from "./types.js";

const read = (id: string, filePath: string, startLine: number, endLine: number): ChatMessage => ({
  role: "assistant",
  content: "",
  tool_calls: [
    {
      id,
      type: "function",
      function: { name: "read_file", arguments: JSON.stringify({ filePath, startLine, endLine }) },
    },
  ],
});

const result = (id: string, content: string): ChatMessage => ({
  role: "tool",
  tool_call_id: id,
  content,
});

const cfg = defaultToolCircuitBreakerConfig();

const emptyContext = { lineCounts: {} };

describe("applyToolCircuitBreakers", () => {
  it("does not trip on a single read with unknown line count", () => {
    const msgs = [read("a", "f.ts", 1, 50), result("a", "line data")];
    const out = applyToolCircuitBreakers(msgs, cfg, emptyContext);
    expect(out.tripped).toBe(false);
    expect(out.messages).toEqual(msgs);
    expect(out.trips).toEqual([]);
  });

  it("annotates every in-bounds read with metadata", () => {
    const msgs = [read("a", "f.ts", 1, 4), result("a", "line1\nline2\nline3\nline4")];
    const ctx = { lineCounts: { "f.ts": 4 } };
    const out = applyToolCircuitBreakers(msgs, cfg, ctx);
    expect(out.tripped).toBe(false);
    expect(out.clamps).toEqual([]);
    const latest = (out.messages[1] as { content: string }).content;
    expect(latest).toContain("--- READ_RESULT ---");
    expect(latest).toContain("file: f.ts");
    expect(latest).toContain("range: 1-4 of 4");
    expect(latest).toContain("requested: 1-4");
    expect(latest).toContain("line1");
  });

  it("trips repeatRun at threshold 2 on two byte-identical consecutive reads", () => {
    const msgs = [
      read("a", "f.ts", 1, 50),
      result("a", "REAL CONTENT"),
      read("b", "f.ts", 1, 50),
      result("b", "REAL CONTENT"),
    ];
    const out = applyToolCircuitBreakers(msgs, cfg, emptyContext);
    expect(out.tripped).toBe(true);
    expect(out.trips[0]?.rule).toBe("repeatRun");
    expect(out.trips[0]?.targetKey).toBe("f.ts:1-50");
    expect(out.trips[0]?.meta.runLength).toBe(2);
    expect((out.messages[1] as { content: string }).content).toBe("REAL CONTENT");
    const latest = (out.messages[3] as { content: string }).content;
    expect(latest).not.toBe("REAL CONTENT");
    expect(latest).toContain("already read");
    expect(latest).toContain("1-50");
    expect(latest).toContain("f.ts");
  });

  it("does not repeatRun when the two most recent reads differ in range", () => {
    const msgs = [
      read("a", "f.ts", 1, 50),
      result("a", "x"),
      read("b", "f.ts", 1, 40),
      result("b", "y"),
    ];
    const out = applyToolCircuitBreakers(msgs, cfg, emptyContext);
    expect(out.tripped).toBe(false);
  });

  it("does not repeatRun on alternating reads", () => {
    const msgs = [
      read("a", "f.ts", 1, 50), result("a", "x"),
      read("b", "g.ts", 1, 50), result("b", "y"),
      read("c", "f.ts", 1, 50), result("c", "z"),
    ];
    const out = applyToolCircuitBreakers(msgs, cfg, emptyContext);
    expect(out.tripped).toBe(false);
  });

  it("reports repeatRun trailing run length", () => {
    const msgs = [
      read("a", "f.ts", 1, 50), result("a", "x"),
      read("b", "f.ts", 1, 50), result("b", "x"),
      read("c", "f.ts", 1, 50), result("c", "x"),
    ];
    const out = applyToolCircuitBreakers(msgs, cfg, emptyContext);
    expect(out.tripped).toBe(true);
    expect(out.trips[0]?.meta.runLength).toBe(3);
  });

  it("clamps readClamp when requested range exceeds actual file length", () => {
    const msgs = [read("a", "f.ts", 5, 5), result("a", "")];
    const ctx = { lineCounts: { "f.ts": 4 } };
    const out = applyToolCircuitBreakers(msgs, cfg, ctx);
    expect(out.tripped).toBe(true);
    expect(out.trips).toEqual([]);
    expect(out.clamps[0]?.rule).toBe("readClamp");
    expect(out.clamps[0]?.toolCallId).toBe("a");
    expect(out.clamps[0]?.actualLines).toBe(4);
    const latest = out.messages.find(
      (m): m is ChatMessage => m.role === "tool" && m.tool_call_id === "a",
    )?.content;
    expect(latest).toContain("--- READ_RESULT ---");
    expect(latest).toContain("file: f.ts");
    expect(latest).toContain("range: 5-4 of 4");
    expect(latest).toContain("requested: 5-5");
  });

  it("trips eofOverflow when requested range exceeds actual file length and readClamp is disabled", () => {
    const noClamp = JSON.parse(JSON.stringify(cfg)) as ToolCircuitBreakerConfig;
    (noClamp.tools.read_file as { readClamp?: { enabled: boolean } }).readClamp = { enabled: false };
    const msgs = [read("a", "f.ts", 5, 5), result("a", "")];
    const ctx = { lineCounts: { "f.ts": 4 } };
    const out = applyToolCircuitBreakers(msgs, noClamp, ctx);
    expect(out.tripped).toBe(true);
    expect(out.trips[0]?.rule).toBe("eofOverflow");
    expect(out.trips[0]?.targetKey).toBe("f.ts:requested=5,actual=4");
    const latest = out.messages.find(
      (m): m is ChatMessage => m.role === "tool" && m.tool_call_id === "a",
    )?.content;
    expect(latest).toContain("only has 4 lines");
    expect(latest).toContain("line 5");
  });

  it("does not trip eofOverflow when requested range is within bounds", () => {
    const msgs = [read("a", "f.ts", 1, 4), result("a", "line1\nline2\nline3\nline4")];
    const ctx = { lineCounts: { "f.ts": 4 } };
    const out = applyToolCircuitBreakers(msgs, cfg, ctx);
    expect(out.tripped).toBe(false);
    const latest = (out.messages[1] as { content: string }).content;
    expect(latest).toContain("--- READ_RESULT ---");
    expect(latest).toContain("range: 1-4 of 4");
  });

  it("trips eofOverflow even on a first out-of-bounds read when readClamp is disabled", () => {
    const noClamp = JSON.parse(JSON.stringify(cfg)) as ToolCircuitBreakerConfig;
    (noClamp.tools.read_file as { readClamp?: { enabled: boolean } }).readClamp = { enabled: false };
    const msgs = [read("a", "short.json", 10, 20), result("a", "")];
    const ctx = { lineCounts: { "short.json": 4 } };
    const out = applyToolCircuitBreakers(msgs, noClamp, ctx);
    expect(out.tripped).toBe(true);
    expect(out.trips[0]?.rule).toBe("eofOverflow");
  });

  it("returns default config with readClamp when no config is supplied", () => {
    const msgs = [read("a", "f.ts", 5, 5), result("a", "")];
    const ctx = { lineCounts: { "f.ts": 4 } };
    const out = applyToolCircuitBreakers(msgs, null, ctx);
    expect(out.tripped).toBe(true);
    expect(out.clamps[0]?.rule).toBe("readClamp");
    expect(out.trips).toEqual([]);
  });

  it("ignores tools not present in the config", () => {
    const msgs = [
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "a",
            type: "function",
            function: { name: "custom_tool", arguments: JSON.stringify({ filePath: "f.ts", startLine: 1, endLine: 10 }) },
          },
        ],
      },
      result("a", "x"),
    ];
    const out = applyToolCircuitBreakers(msgs, cfg, emptyContext);
    expect(out.tripped).toBe(false);
  });
});
