import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../chat-message.js";
import { insert } from "./insert.js";

describe("cm.insert", () => {
  const messages: ChatMessage[] = [
    { role: "user", content: "hi" },
    { role: "assistant", content: "ok" },
  ];

  it("inserts system messages at the given index", () => {
    const out = insert({ messages, role: "system", at: 1, contents: ["hint-a", "hint-b"] });
    expect(out.cut).toBe("insert");
    expect(out.messages.map((m) => m.role)).toEqual(["user", "system", "system", "assistant"]);
    expect(out.messages[1]).toEqual({ role: "system", content: "hint-a" });
  });

  it("can insert a user chunk", () => {
    const out = insert({ messages, role: "user", at: 2, contents: ["chunk"] });
    expect(out.messages[2]).toEqual({ role: "user", content: "chunk" });
  });

  it("is a no-op when there is nothing to insert", () => {
    const out = insert({ messages, role: "system", at: 0, contents: [] });
    expect(out.messages).toBe(messages);
  });
});
