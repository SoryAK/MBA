import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../chat-message.js";
import { replace } from "./replace.js";

describe("cm.replace", () => {
  const messages: ChatMessage[] = [
    { role: "user", content: "read" },
    { role: "tool", tool_call_id: "a", content: "old" },
    { role: "tool", tool_call_id: "b", content: "keep" },
  ];

  it("replaces only the matching tool result", () => {
    const out = replace({
      messages,
      target: "tool-result",
      toolCallId: "a",
      content: "stop",
    });
    expect(out.cut).toBe("replace");
    expect(out.messages[1]).toEqual({ role: "tool", tool_call_id: "a", content: "stop" });
    expect(out.messages[2]).toBe(messages[2]);
  });

  it("is a no-op when the tool id is missing", () => {
    const out = replace({
      messages,
      target: "tool-result",
      toolCallId: "missing",
      content: "x",
    });
    expect(out.messages).toBe(messages);
  });
});
