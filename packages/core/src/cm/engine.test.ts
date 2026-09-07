import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../chat-message.js";
import type { ToolCircuitBreakerTrip } from "../bcb/types.js";
import { applyCm, runCm } from "./engine.js";
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
  it("dispatches replace-tool-result", () => {
    const messages: ChatMessage[] = [
      { role: "tool", tool_call_id: "a", content: "old" },
    ];
    const out = applyCm(messages, {
      cut: "replace-tool-result",
      toolCallId: "a",
      content: "stop",
    });
    expect(out.cut).toBe("replace-tool-result");
    expect(out.messages[0]).toEqual({ role: "tool", tool_call_id: "a", content: "stop" });
  });

  it("dispatches insert-system", () => {
    const messages: ChatMessage[] = [{ role: "user", content: "hi" }];
    const out = applyCm(messages, { cut: "insert-system", at: 0, contents: ["hint"] });
    expect(out.cut).toBe("insert-system");
    expect(out.messages[0]).toEqual({ role: "system", content: "hint" });
  });

  it("dispatches prune-duplicates", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "read" },
      ...pair("a", "n.md", "1"),
      ...pair("b", "n.md", "2"),
    ];
    const out = applyCm(messages, { cut: "prune-duplicates", trip });
    expect(out.cut).toBe("prune-duplicates");
    expect(out.messages.some((m) => m.tool_call_id === "b")).toBe(false);
    expect(out.messages.some((m) => m.tool_call_id === "a")).toBe(true);
  });

  it("no-ops an unknown cut", () => {
    const messages: ChatMessage[] = [{ role: "user", content: "hi" }];
    const out = applyCm(messages, { cut: "not-a-cut" } as unknown as CmIntent);
    expect(out.messages).toBe(messages);
    expect(out.progress).toBe(0);
  });

  it("runs a sequence and honors maxCuts", () => {
    const messages: ChatMessage[] = [
      { role: "tool", tool_call_id: "a", content: "old" },
      { role: "user", content: "hi" },
    ];
    const out = runCm(
      messages,
      [
        { cut: "replace-tool-result", toolCallId: "a", content: "stop" },
        { cut: "insert-system", at: 0, contents: ["hint"] },
      ],
      { maxCuts: 1 },
    );
    expect(out.cutsUsed).toBe(1);
    expect(out.applied).toEqual(["replace-tool-result"]);
    expect(out.messages[0]).toEqual({ role: "tool", tool_call_id: "a", content: "stop" });
    expect(out.messages.some((m) => m.role === "system")).toBe(false);
  });
});
