import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../chat-message.js";
import { dropToolCallIds } from "./drop-pairs.js";

describe("dropToolCallIds", () => {
  it("strips one call from a parallel assistant turn and keeps the sibling", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "q" },
      {
        role: "assistant",
        tool_calls: [
          {
            id: "keep",
            type: "function",
            function: { name: "search", arguments: '{"q":"a"}' },
          },
          {
            id: "junk",
            type: "function",
            function: { name: "search", arguments: '{"q":"b"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "keep", content: "A" },
      { role: "tool", tool_call_id: "junk", content: "B" },
    ];
    const out = dropToolCallIds(messages, new Set(["junk"]));
    expect(out).not.toBe(messages);
    const assistant = out.find((m) => m.role === "assistant")!;
    expect(assistant.tool_calls).toEqual([
      {
        id: "keep",
        type: "function",
        function: { name: "search", arguments: '{"q":"a"}' },
      },
    ]);
    expect(out.some((m) => m.tool_call_id === "junk")).toBe(false);
    expect(out.some((m) => m.tool_call_id === "keep")).toBe(true);
  });

  it("drops the assistant when every call is removed", () => {
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        tool_calls: [
          {
            id: "a",
            type: "function",
            function: { name: "search", arguments: "{}" },
          },
        ],
      },
      { role: "tool", tool_call_id: "a", content: "x" },
    ];
    const out = dropToolCallIds(messages, new Set(["a"]));
    expect(out).toEqual([]);
  });

  it("returns the same array when ids miss", () => {
    const messages: ChatMessage[] = [{ role: "user", content: "q" }];
    expect(dropToolCallIds(messages, new Set(["nope"]))).toBe(messages);
  });
});
