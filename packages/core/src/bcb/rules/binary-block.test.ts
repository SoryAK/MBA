import { describe, expect, it } from "vitest";
import { formatBinaryBlockMessage, runBinaryBlock } from "./binary-block.js";
import type { ChatMessage } from "../../chat-message.js";
import type { ToolCall, ToolRuleSet } from "../types.js";

const toolMsg = (id: string, content: string): ChatMessage => ({
  role: "tool",
  tool_call_id: id,
  content,
});

const call = (id: string, filePath: string): ToolCall => ({
  toolCallId: id,
  tool: "read_file",
  rawArgs: { filePath },
  argHash: filePath,
  turnIndex: 0,
});

const ruleSet = (enabled: boolean, extensions: string[], message?: string): ToolRuleSet => ({
  binaryBlock: { enabled, extensions, ...(message ? { message } : {}) },
});

describe("runBinaryBlock", () => {
  it("does nothing when disabled", () => {
    const messages = [toolMsg("a", "raw")];
    const out = runBinaryBlock(messages, [call("a", "turns.db")], ruleSet(false, [".db"]));
    expect(out.tripped).toBe(false);
    expect(out.messages).toBe(messages);
  });

  it("trips when the last read targets a blocked extension", () => {
    const messages = [toolMsg("a", "\u0000binarygarbage")];
    const out = runBinaryBlock(messages, [call("a", "data/turns.db")], ruleSet(true, [".db", ".sqlite"]));
    expect(out.tripped).toBe(true);
    expect(out.trips[0]!.rule).toBe("binaryBlock");
    expect(out.trips[0]!.tool).toBe("read_file");
    expect(out.trips[0]!.targetKey).toBe("binaryBlock:data/turns.db");
    expect(String(out.messages[0]!.content)).toContain("data/turns.db");
  });

  it("is case-insensitive on the extension", () => {
    const out = runBinaryBlock([toolMsg("a", "x")], [call("a", "IMG.PNG")], ruleSet(true, [".png"]));
    expect(out.tripped).toBe(true);
  });

  it("does not trip on a non-blocked extension", () => {
    const out = runBinaryBlock([toolMsg("a", "x")], [call("a", "src/index.ts")], ruleSet(true, [".db", ".png"]));
    expect(out.tripped).toBe(false);
  });

  it("substitutes {filePath} in a custom message", () => {
    const out = runBinaryBlock(
      [toolMsg("a", "x")],
      [call("a", "a.bin")],
      ruleSet(true, [".bin"], "Cannot read {filePath} — it is binary."),
    );
    expect(String(out.messages[0]!.content)).toBe("Cannot read a.bin — it is binary.");
  });
});

describe("formatBinaryBlockMessage", () => {
  it("names the file", () => {
    expect(formatBinaryBlockMessage("x.db")).toContain("x.db");
  });
});
