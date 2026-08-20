import { describe, expect, it } from "vitest";
import {
  formatReadClampHeader,
  formatReadResultHeader,
  READ_RESULT_METADATA_END,
  runReadClamp,
} from "./read-clamp.js";
import type { ChatMessage } from "../../chat-message.js";
import type { ToolCall, ToolRuleSet } from "../types.js";

const toolMsg = (id: string, content: string): ChatMessage => ({
  role: "tool",
  tool_call_id: id,
  content,
});

const call = (id: string, filePath: string, start: number, end: number): ToolCall => ({
  toolCallId: id,
  tool: "read_file",
  rawArgs: { filePath, startLine: start, endLine: end },
  argHash: `${filePath}:${start}-${end}`,
  turnIndex: 0,
  read: { filePath, start, end },
});

const ruleSet = (enabled: boolean): ToolRuleSet => ({
  readClamp: { enabled },
});

const ctx = { lineCounts: { "f.ts": 4 } };

describe("formatReadResultHeader", () => {
  it("describes a clamped range with actual total", () => {
    const header = formatReadResultHeader("f.ts", 10, 20, 4);
    expect(header).toContain("--- READ_RESULT ---");
    expect(header).toContain("file: f.ts");
    expect(header).toContain("range: 10-4 of 4");
    expect(header).toContain("requested: 10-20");
    expect(header).toContain(READ_RESULT_METADATA_END);
  });

  it("uses the requested end when it is within bounds", () => {
    const header = formatReadResultHeader("f.ts", 1, 3, 4);
    expect(header).toContain("range: 1-3 of 4");
    expect(header).toContain("requested: 1-3");
  });

  it("backward-compatible alias produces the same header", () => {
    expect(formatReadClampHeader("f.ts", 1, 3, 4)).toBe(formatReadResultHeader("f.ts", 1, 3, 4));
  });
});

describe("runReadClamp", () => {
  it("does nothing when the rule is disabled", () => {
    const messages: ChatMessage[] = [toolMsg("a", "")];
    const calls = [call("a", "f.ts", 10, 20)];
    const out = runReadClamp(messages, calls, ruleSet(false), ctx);
    expect(out.tripped).toBe(false);
    expect(out.clamps).toEqual([]);
    expect(out.messages).toBe(messages);
  });

  it("does nothing when no calls are provided", () => {
    const messages: ChatMessage[] = [];
    const out = runReadClamp(messages, [], ruleSet(true), ctx);
    expect(out.tripped).toBe(false);
    expect(out.clamps).toEqual([]);
  });

  it("annotates in-bounds reads without clamping", () => {
    const messages: ChatMessage[] = [toolMsg("a", "line1\nline2")];
    const calls = [call("a", "f.ts", 1, 4)];
    const out = runReadClamp(messages, calls, ruleSet(true), ctx);
    expect(out.tripped).toBe(false);
    expect(out.clamps).toEqual([]);
    const updated = out.messages.find(
      (m): m is ChatMessage => m.role === "tool" && m.tool_call_id === "a",
    )?.content;
    expect(updated).toContain("--- READ_RESULT ---");
    expect(updated).toContain("file: f.ts");
    expect(updated).toContain("range: 1-4 of 4");
    expect(updated).toContain(READ_RESULT_METADATA_END);
    expect(updated).toContain("line1\nline2");
  });

  it("does nothing when the file length is unknown", () => {
    const messages: ChatMessage[] = [toolMsg("a", "")];
    const calls = [call("a", "missing.ts", 10, 20)];
    const out = runReadClamp(messages, calls, ruleSet(true), { lineCounts: {} });
    expect(out.tripped).toBe(false);
    expect(out.clamps).toEqual([]);
    expect(out.messages).toBe(messages);
  });

  it("clamps the latest out-of-bounds read and prefixes the result", () => {
    const messages: ChatMessage[] = [toolMsg("a", "")];
    const calls = [call("a", "f.ts", 5, 10)];
    const out = runReadClamp(messages, calls, ruleSet(true), ctx);
    expect(out.tripped).toBe(true);
    expect(out.trips).toEqual([]);
    expect(out.clamps).toHaveLength(1);
    expect(out.clamps[0]).toMatchObject({
      tool: "read_file",
      rule: "readClamp",
      toolCallId: "a",
      filePath: "f.ts",
      requestedStart: 5,
      requestedEnd: 10,
      actualLines: 4,
    });
    const updated = out.messages.find(
      (m): m is ChatMessage => m.role === "tool" && m.tool_call_id === "a",
    )?.content;
    expect(updated).toContain("--- READ_RESULT ---");
    expect(updated).toContain("file: f.ts");
    expect(updated).toContain("range: 5-4 of 4");
    expect(updated).toContain("requested: 5-10");
    expect(updated).toContain(READ_RESULT_METADATA_END);
  });

  it("clamps multiple out-of-bounds reads in one pass", () => {
    const messages: ChatMessage[] = [toolMsg("a", ""), toolMsg("b", "")];
    const calls = [call("a", "f.ts", 5, 10), call("b", "f.ts", 8, 12)];
    const out = runReadClamp(messages, calls, ruleSet(true), ctx);
    expect(out.tripped).toBe(true);
    expect(out.clamps).toHaveLength(2);
    expect(out.clamps.map((c) => c.toolCallId)).toEqual(["a", "b"]);
  });

  it("preserves original content when prefixing", () => {
    const messages: ChatMessage[] = [toolMsg("a", "existing content")];
    const calls = [call("a", "f.ts", 5, 10)];
    const out = runReadClamp(messages, calls, ruleSet(true), ctx);
    const updated = out.messages.find(
      (m): m is ChatMessage => m.role === "tool" && m.tool_call_id === "a",
    )?.content;
    expect(updated).toContain("existing content");
    expect(updated).toMatch(/^--- READ_RESULT ---/);
  });

  it("strip boundary separates metadata from raw content", () => {
    const messages: ChatMessage[] = [toolMsg("a", "1 | line one\n2 | line two")];
    const calls = [call("a", "f.ts", 1, 2)];
    const out = runReadClamp(messages, calls, ruleSet(true), ctx);
    const updated = out.messages.find(
      (m): m is ChatMessage => m.role === "tool" && m.tool_call_id === "a",
    )?.content as string;
    const boundary = `${READ_RESULT_METADATA_END}\n\n`;
    expect(updated.includes(boundary)).toBe(true);
    expect(updated.split(boundary)[1]).toBe("1 | line one\n2 | line two");
  });
});
