import { describe, expect, it } from "vitest";
import { orderedToolCalls } from "./parse-calls.js";
import type { ChatMessage } from "../chat-message.js";

/** Build an assistant message carrying one or more tool calls. */
const assistant = (
  ...calls: ReadonlyArray<{ id: string; name: string; args: unknown }>
): ChatMessage => ({
  role: "assistant",
  tool_calls: calls.map((c) => ({
    id: c.id,
    type: "function",
    function: {
      name: c.name,
      arguments: typeof c.args === "string" ? c.args : JSON.stringify(c.args),
    },
  })),
});

describe("orderedToolCalls", () => {
  it("captures a non-read tool that has no line range", () => {
    // The exact miss ADR-0086 fixes: mba_file_metadata has only filePath.
    const messages: ChatMessage[] = [
      assistant({ id: "a", name: "mba_file_metadata", args: { filePath: "x.db" } }),
    ];
    const calls = orderedToolCalls(messages);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.tool).toBe("mba_file_metadata");
    expect(calls[0]!.toolCallId).toBe("a");
    expect(calls[0]!.read).toBeUndefined();
    expect(calls[0]!.argHash).toMatch(/^[0-9a-f]+$/);
  });

  it("populates the read bridge field for read-shaped calls", () => {
    const messages: ChatMessage[] = [
      assistant({ id: "r", name: "read_file", args: { filePath: "f.ts", startLine: 1, endLine: 40 } }),
    ];
    const [call] = orderedToolCalls(messages);
    expect(call!.read).toEqual({ filePath: "f.ts", start: 1, end: 40 });
  });

  it("accepts `path` as an alias for filePath in the read bridge", () => {
    const messages: ChatMessage[] = [
      assistant({ id: "r", name: "read_file", args: { path: "f.ts", startLine: 2, endLine: 3 } }),
    ];
    const [call] = orderedToolCalls(messages);
    expect(call!.read).toEqual({ filePath: "f.ts", start: 2, end: 3 });
  });

  it("gives identical args the same argHash regardless of key order", () => {
    const m1: ChatMessage[] = [
      assistant({ id: "a", name: "t", args: { b: 2, a: 1 } }),
    ];
    const m2: ChatMessage[] = [
      assistant({ id: "b", name: "t", args: { a: 1, b: 2 } }),
    ];
    expect(orderedToolCalls(m1)[0]!.argHash).toBe(orderedToolCalls(m2)[0]!.argHash);
  });

  it("gives different args different argHashes", () => {
    const m1: ChatMessage[] = [assistant({ id: "a", name: "t", args: { p: "x" } })];
    const m2: ChatMessage[] = [assistant({ id: "b", name: "t", args: { p: "y" } })];
    expect(orderedToolCalls(m1)[0]!.argHash).not.toBe(orderedToolCalls(m2)[0]!.argHash);
  });

  it("shares a turnIndex across calls in the same assistant message and increments per turn", () => {
    const messages: ChatMessage[] = [
      assistant(
        { id: "a", name: "t1", args: {} },
        { id: "b", name: "t2", args: {} },
      ),
      { role: "tool", tool_call_id: "a", content: "" },
      assistant({ id: "c", name: "t3", args: {} }),
    ];
    const calls = orderedToolCalls(messages);
    expect(calls.map((c) => c.turnIndex)).toEqual([0, 0, 1]);
  });

  it("restricts to the given tool set when one is supplied", () => {
    const messages: ChatMessage[] = [
      assistant({ id: "a", name: "read_file", args: { filePath: "f", startLine: 1, endLine: 2 } }),
      assistant({ id: "b", name: "other_tool", args: {} }),
    ];
    const calls = orderedToolCalls(messages, new Set(["read_file"]));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.tool).toBe("read_file");
  });

  it("flags malformed args instead of dropping the call", () => {
    const messages: ChatMessage[] = [
      assistant({ id: "a", name: "t", args: "{not valid json" }),
    ];
    const [call] = orderedToolCalls(messages);
    expect(call!.malformed).toBe(true);
    expect(call!.rawArgs).toEqual({});
  });

  it("honours a per-tool hashKeys allowlist", () => {
    // Same command, different noise field → identical hash when only `command` is hashed.
    const m1: ChatMessage[] = [
      assistant({ id: "a", name: "run", args: { command: "ls", explanation: "list files" } }),
    ];
    const m2: ChatMessage[] = [
      assistant({ id: "b", name: "run", args: { command: "ls", explanation: "show dir" } }),
    ];
    const opts = { hashKeys: { run: ["command"] } };
    expect(orderedToolCalls(m1, undefined, opts)[0]!.argHash).toBe(
      orderedToolCalls(m2, undefined, opts)[0]!.argHash,
    );
  });
});
