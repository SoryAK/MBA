import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../chat-message.js";
import type { ToolCircuitBreakerTrip } from "../bcb/types.js";
import { applyCm, runCm } from "./engine.js";
import { readMark } from "./types.js";
import type { CmIntent } from "./types.js";

const trip: ToolCircuitBreakerTrip = {
  tool: "read_file",
  rule: "directDuplication",
  toolCallId: "b",
  message: "dup",
  meta: {},
  targetKey: "x",
};

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

describe("CM engine", () => {
  it("dispatches replace", () => {
    const messages: ChatMessage[] = [{ role: "tool", tool_call_id: "a", content: "old" }];
    const out = applyCm(messages, {
      cut: "replace",
      target: "tool-result",
      toolCallId: "a",
      content: "stop",
    });
    expect(out.cut).toBe("replace");
    expect(out.messages[0]).toEqual({ role: "tool", tool_call_id: "a", content: "stop" });
  });

  it("dispatches insert", () => {
    const messages: ChatMessage[] = [{ role: "user", content: "hi" }];
    const out = applyCm(messages, { cut: "insert", role: "system", at: 0, contents: ["hint"] });
    expect(out.cut).toBe("insert");
    expect(out.messages[0]).toEqual({ role: "system", content: "hint" });
  });

  it("dispatches sweep duplicates", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "read" },
      ...pair("a", "n.md", "1"),
      ...pair("b", "n.md", "2"),
    ];
    const out = applyCm(messages, { cut: "sweep", what: "duplicates", trip });
    expect(out.cut).toBe("sweep");
    expect(out.messages.some((m) => m.tool_call_id === "b")).toBe(false);
    expect(out.messages.some((m) => m.tool_call_id === "a")).toBe(true);
  });

  it("set-mark then sweep scratch skips pins", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "q" },
      ...pair("keep", "hit.md", "good"),
      ...pair("junk", "miss.md", "bad"),
    ];
    const pinned = applyCm(messages, { cut: "set-mark", tag: "pin", toolCallId: "keep" }).messages;
    const scratched = applyCm(pinned, { cut: "set-mark", tag: "scratch", toolCallId: "junk" }).messages;
    expect(readMark(scratched.find((m) => m.tool_call_id === "keep")!)).toBe("pin");
    const swept = applyCm(scratched, { cut: "sweep", what: "scratch" });
    expect(swept.messages.some((m) => m.tool_call_id === "junk")).toBe(false);
    expect(swept.messages.some((m) => m.tool_call_id === "keep")).toBe(true);
    expect(String(swept.messages[swept.messages.length - 1]!.content)).toContain("[[mba:");
  });

  it("no-ops an unknown cut", () => {
    const messages: ChatMessage[] = [{ role: "user", content: "hi" }];
    const out = applyCm(messages, { cut: "not-a-cut" } as unknown as CmIntent);
    expect(out.messages).toBe(messages);
  });

  it("runs a sequence and honors maxCuts", () => {
    const messages: ChatMessage[] = [
      { role: "tool", tool_call_id: "a", content: "old" },
      { role: "user", content: "hi" },
    ];
    const out = runCm(
      messages,
      [
        { cut: "replace", target: "tool-result", toolCallId: "a", content: "stop" },
        { cut: "insert", role: "system", at: 0, contents: ["hint"] },
      ],
      { maxCuts: 1 },
    );
    expect(out.cutsUsed).toBe(1);
    expect(out.applied).toEqual(["replace"]);
    expect(out.messages.some((m) => m.role === "system")).toBe(false);
  });
});
