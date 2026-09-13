import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../chat-message.js";
import type { ToolCircuitBreakerTrip } from "../../bcb/types.js";
import { CGC_MARKER_PREFIX, pruneDuplicates, trailingDuplicateRun } from "./prune-duplicates.js";

function assistantCall(id: string, tool: string, args: Record<string, unknown>): ChatMessage {
  return {
    role: "assistant",
    tool_calls: [
      {
        id,
        type: "function",
        function: { name: tool, arguments: JSON.stringify(args) },
      },
    ],
  };
}

function toolResult(id: string, content: string): ChatMessage {
  return { role: "tool", tool_call_id: id, content };
}

const sameArgs = { path: "notes.md" };

function duplicateTranscript(): ChatMessage[] {
  return [
    { role: "user", content: "summarize notes" },
    assistantCall("a", "read_file", { path: "other.md" }),
    toolResult("a", "other"),
    assistantCall("b", "read_file", sameArgs),
    toolResult("b", "first"),
    assistantCall("c", "read_file", sameArgs),
    toolResult("c", "second"),
    assistantCall("d", "read_file", sameArgs),
    toolResult("d", "third"),
  ];
}

const trip: ToolCircuitBreakerTrip = {
  tool: "read_file",
  rule: "directDuplication",
  toolCallId: "d",
  message: "duplicate",
  meta: {},
  targetKey: "read_file:ignored",
};

describe("cm.cgc.pruneDuplicates", () => {
  it("prunes trailing duplicates and keeps the first pair", () => {
    const messages = duplicateTranscript();
    const out = pruneDuplicates({ messages, trip });
    expect(out.cut).toBe("sweep");
    expect(out.progress).toBe(0);
    const roles = out.messages.map((m) => m.role);
    expect(roles).toEqual(["user", "assistant", "tool", "assistant", "tool", "user"]);
    expect(out.messages[1]).toEqual(messages[1]);
    expect(out.messages[3]).toEqual(messages[3]);
    expect(out.messages[4]).toEqual(messages[4]);
    const marker = out.messages[out.messages.length - 1]!;
    expect(marker.role).toBe("user");
    expect(String(marker.content)).toContain(CGC_MARKER_PREFIX);
    expect(String(marker.content)).toContain("2 duplicate");
  });

  it("is a no-op when there is no trailing duplicate run", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "hi" },
      assistantCall("a", "read_file", { path: "a.md" }),
      toolResult("a", "a"),
      assistantCall("b", "read_file", { path: "b.md" }),
      toolResult("b", "b"),
    ];
    const out = pruneDuplicates({
      messages,
      trip: { ...trip, toolCallId: "b" },
    });
    expect(out.messages).toBe(messages);
    expect(out.progress).toBe(0);
  });

  it("preserves unrelated earlier calls", () => {
    const messages = duplicateTranscript();
    const run = trailingDuplicateRun(messages, trip);
    expect(run.map((p) => p.toolCallId)).toEqual(["b", "c", "d"]);
    const out = pruneDuplicates({ messages, trip });
    expect(out.messages.some((m) => m.tool_call_id === "a")).toBe(true);
    expect(out.messages.some((m) => m.tool_call_id === "c")).toBe(false);
    expect(out.messages.some((m) => m.tool_call_id === "d")).toBe(false);
  });

  it("does not drop a sibling tool_call on the same assistant turn", () => {
    const loop = JSON.stringify({ q: "loop" });
    const messages: ChatMessage[] = [
      { role: "user", content: "both" },
      {
        role: "assistant",
        tool_calls: [
          {
            id: "dup1",
            type: "function",
            function: { name: "search", arguments: loop },
          },
        ],
      },
      { role: "tool", tool_call_id: "dup1", content: "first" },
      {
        role: "assistant",
        tool_calls: [
          {
            id: "dup2",
            type: "function",
            function: { name: "search", arguments: loop },
          },
          {
            id: "keep",
            type: "function",
            function: { name: "search", arguments: JSON.stringify({ q: "one" }) },
          },
        ],
      },
      { role: "tool", tool_call_id: "dup2", content: "second" },
      { role: "tool", tool_call_id: "keep", content: "ok" },
    ];
    const out = pruneDuplicates({
      messages,
      trip: {
        tool: "search",
        rule: "directDuplication",
        toolCallId: "dup2",
        message: "dup",
        meta: {},
        targetKey: "search:loop",
      },
    });
    const assistants = out.messages.filter((m) => m.role === "assistant");
    expect(assistants).toHaveLength(2);
    expect(
      (assistants[1]!.tool_calls as Array<{ id?: string }>).map((c) => c.id),
    ).toEqual(["keep"]);
    expect(out.messages.some((m) => m.tool_call_id === "keep")).toBe(true);
    expect(out.messages.some((m) => m.tool_call_id === "dup1")).toBe(true);
    expect(out.messages.some((m) => m.tool_call_id === "dup2")).toBe(false);
  });
});
