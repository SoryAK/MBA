import { describe, expect, it } from "vitest";
import { insertEofOverflowHints } from "./hints.js";
import type { ChatMessage } from "../chat-message.js";
import type { ToolCall } from "./types.js";

const tc = (id: string, filePath: string, start: number, end: number): ToolCall => ({
  toolCallId: id,
  tool: "read_file",
  rawArgs: { filePath, startLine: start, endLine: end },
  argHash: `${filePath}:${start}-${end}`,
  turnIndex: 0,
  read: { filePath, start, end },
});

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

describe("insertEofOverflowHints", () => {
  it("adds a hint before the latest assistant tool-call message when read requests exceed file length", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: "read it" },
      read("a", "short.json", 1, 100),
      { role: "tool", tool_call_id: "a", content: "line1\nline2\nline3" },
    ];
    const out = insertEofOverflowHints(msgs, [
      tc("a", "short.json", 1, 100),
    ], { lineCounts: { "short.json": 3 } }, { enabled: true });

    expect(out.messages).toHaveLength(4);
    expect(out.hints).toHaveLength(1);
    expect(out.hints[0]!.filePath).toBe("short.json");
    expect(out.hints[0]!.actualLines).toBe(3);
    expect(out.hints[0]!.requestedEnd).toBe(100);
    expect(out.hints[0]!.message).toContain("short.json has 3 line(s)");
    expect((out.messages[1] as { role: string; content: string }).role).toBe("system");
    expect((out.messages[1] as { role: string; content: string }).content).toContain("short.json has 3 line(s)");
    expect((out.messages[2] as { role: string }).role).toBe("assistant");
  });

  it("does not add a hint when the requested range is within bounds", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: "read it" },
      read("a", "short.json", 1, 3),
      { role: "tool", tool_call_id: "a", content: "line1\nline2\nline3" },
    ];
    const out = insertEofOverflowHints(msgs, [
      tc("a", "short.json", 1, 3),
    ], { lineCounts: { "short.json": 3 } }, { enabled: true });
    expect(out.messages).toEqual(msgs);
    expect(out.hints).toEqual([]);
  });

  it("respects a custom message template", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: "read it" },
      read("a", "short.json", 1, 100),
      { role: "tool", tool_call_id: "a", content: "data" },
    ];
    const out = insertEofOverflowHints(msgs, [
      tc("a", "short.json", 1, 100),
    ], { lineCounts: { "short.json": 3 } }, {
      enabled: true,
      message: "File {filePath} ends at {actualLines}; requested {requestedEnd}.",
    });
    const hint = (out.messages[1] as { content: string }).content;
    expect(hint).toBe("File short.json ends at 3; requested 100.");
  });

  it("returns original messages when hints are disabled", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: "read it" },
      read("a", "short.json", 1, 100),
    ];
    const out = insertEofOverflowHints(msgs, [
      tc("a", "short.json", 1, 100),
    ], { lineCounts: { "short.json": 3 } }, { enabled: false });
    expect(out.messages).toEqual(msgs);
    expect(out.hints).toEqual([]);
  });
});
