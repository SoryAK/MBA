import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../chat-message.js";
import { insertSystem } from "./insert-system.js";

describe("cm.insertSystem", () => {
  const messages: ChatMessage[] = [
    { role: "user", content: "hi" },
    { role: "assistant", content: "ok" },
  ];

  it("inserts system messages at the given index", () => {
    const out = insertSystem({ messages, at: 1, contents: ["hint-a", "hint-b"] });
    expect(out.cut).toBe("insert-system");
    expect(out.messages.map((m) => m.role)).toEqual(["user", "system", "system", "assistant"]);
    expect(out.messages[1]).toEqual({ role: "system", content: "hint-a" });
    expect(out.messages[2]).toEqual({ role: "system", content: "hint-b" });
  });

  it("is a no-op when there is nothing to insert", () => {
    const out = insertSystem({ messages, at: 0, contents: [] });
    expect(out.messages).toBe(messages);
  });
});
