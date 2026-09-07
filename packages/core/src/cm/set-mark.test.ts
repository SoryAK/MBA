import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../chat-message.js";
import { setMark } from "./set-mark.js";
import { readMark } from "./types.js";

describe("cm.set-mark", () => {
  const messages: ChatMessage[] = [
    {
      role: "assistant",
      tool_calls: [
        { id: "a", type: "function", function: { name: "read_file", arguments: "{}" } },
      ],
    },
    { role: "tool", tool_call_id: "a", content: "body" },
    { role: "user", content: "ok" },
  ];

  it("marks the tool pair and does not delete", () => {
    const out = setMark({ messages, tag: "scratch", toolCallId: "a" });
    expect(out.cut).toBe("set-mark");
    expect(out.messages).toHaveLength(3);
    expect(readMark(out.messages[0]!)).toBe("scratch");
    expect(readMark(out.messages[1]!)).toBe("scratch");
    expect(readMark(out.messages[2]!)).toBeUndefined();
  });

  it("clears a mark", () => {
    const marked = setMark({ messages, tag: "pin", toolCallId: "a" }).messages;
    const out = setMark({ messages: marked, tag: "clear", toolCallId: "a" });
    expect(readMark(out.messages[1]!)).toBeUndefined();
  });
});
