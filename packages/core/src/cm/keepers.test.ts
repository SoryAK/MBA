import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../chat-message.js";
import { listKeepers } from "./keepers.js";
import { setMark } from "./set-mark.js";

function pair(id: string, path: string, body: string): ChatMessage[] {
  return [
    {
      role: "assistant",
      tool_calls: [
        {
          id,
          type: "function",
          function: { name: "read_file", arguments: JSON.stringify({ path }) },
        },
      ],
    },
    { role: "tool", tool_call_id: id, content: body },
  ];
}

describe("listKeepers", () => {
  it("is empty when nothing is pinned", () => {
    const messages = [{ role: "user", content: "q" }, ...pair("a", "foo.ts", "src")];
    expect(listKeepers(messages)).toEqual([]);
  });

  it("returns the path from a pinned tool pair", () => {
    const raw = [{ role: "user", content: "q" }, ...pair("keep", "src/foo.ts", "src")];
    const messages = setMark({ messages: raw, tag: "pin", toolCallId: "keep" }).messages;
    expect(listKeepers(messages)).toEqual([
      { toolCallId: "keep", tool: "read_file", path: "src/foo.ts" },
    ]);
  });

  it("skips scratch and unpinned pairs", () => {
    const raw = [
      ...pair("keep", "hit.md", "good"),
      ...pair("junk", "miss.md", "bad"),
    ];
    const pinned = setMark({ messages: raw, tag: "pin", toolCallId: "keep" }).messages;
    const mixed = setMark({ messages: pinned, tag: "scratch", toolCallId: "junk" }).messages;
    expect(listKeepers(mixed).map((k) => k.path)).toEqual(["hit.md"]);
  });
});
