import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../chat-message.js";
import type { ToolCircuitBreakerTrip } from "../../bcb/types.js";
import { COMPACT_REASONING_RESIDUE } from "../../cm/compact.js";
import { listKeepers } from "../../cm/keepers.js";
import { setMark } from "../../cm/set-mark.js";
import { readMark } from "../../cm/types.js";
import { runAmpi } from "../engine.js";
import { SANITIZE_RECIPE, runSanitize, sanitizeIntents } from "./sanitize.js";

const trip: ToolCircuitBreakerTrip = {
  tool: "read_file",
  rule: "directDuplication",
  toolCallId: "keep",
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

describe("AMPI sanitize modes", () => {
  it("skips compact when reasoning is off", () => {
    const ctx = {
      messages: [] as ChatMessage[],
      trip,
      reasoning: { modelReasons: false },
    };
    expect(sanitizeIntents(ctx, { what: "reasoning" })).toEqual([]);
    expect(sanitizeIntents({ ...ctx, reasoning: { reasoningBudget: 0 } }, { what: "phase" })).toEqual([
      { cut: "sweep", what: "scratch", trip },
    ]);
  });

  it("names compact for reasoning", () => {
    const ctx = { messages: [] as ChatMessage[], trip };
    expect(sanitizeIntents(ctx, { what: "reasoning" })).toEqual([
      { cut: "compact", target: "reasoning" },
    ]);
    expect(runSanitize(ctx, { what: "reasoning" }).cm).toEqual({
      cut: "compact",
      target: "reasoning",
    });
  });

  it("names sweep then compact for phase", () => {
    const ctx = { messages: [] as ChatMessage[], trip };
    expect(sanitizeIntents(ctx, { what: "phase" })).toEqual([
      { cut: "sweep", what: "scratch", trip },
      { cut: "compact", target: "reasoning" },
    ]);
  });

  it("pin mode marks the tripped pair as a keeper", () => {
    const messages = [{ role: "user", content: "q" }, ...pair("keep", "src/foo.ts", "src")];
    const out = runAmpi(SANITIZE_RECIPE, { messages, trip, sanitize: { what: "pin" } });
    expect(readMark(out.messages.find((m) => m.tool_call_id === "keep")!)).toBe("pin");
    expect(listKeepers(out.messages)).toEqual([
      { toolCallId: "keep", tool: "read_file", path: "src/foo.ts" },
    ]);
  });

  it("pin?: true pins the trip before the mop", () => {
    const messages = [
      { role: "user", content: "q" },
      ...pair("keep", "src/foo.ts", "src"),
      { role: "assistant", content: "<think>x</think>\nok" },
    ];
    const step = runSanitize({ messages, trip }, { what: "reasoning", pin: true });
    expect(step.cm).toEqual([
      { cut: "set-mark", tag: "pin", toolCallId: "keep" },
      { cut: "compact", target: "reasoning" },
    ]);
    const out = runAmpi(SANITIZE_RECIPE, {
      messages,
      trip,
      sanitize: { what: "reasoning", pin: true },
    });
    expect(listKeepers(out.messages)[0]?.path).toBe("src/foo.ts");
    expect(String(out.messages[out.messages.length - 1]!.content)).toBe(
      `${COMPACT_REASONING_RESIDUE}\nok`,
    );
  });

  it("reasoning folds think and keeps the answer", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "q" },
      { role: "assistant", content: "<think>maybe bar</think>\nfoo.ts" },
    ];
    const out = runAmpi(SANITIZE_RECIPE, {
      messages,
      trip,
      sanitize: { what: "reasoning" },
    });
    expect(String(out.messages[1]!.content)).toBe(`${COMPACT_REASONING_RESIDUE}\nfoo.ts`);
  });

  it("phase sweeps scratch, keeps pins, and compactes reasoning", () => {
    const seeded: ChatMessage[] = [
      { role: "user", content: "q" },
      ...pair("keep", "hit.md", "good"),
      ...pair("junk", "miss.md", "bad"),
      { role: "assistant", content: "<think>wandered</think>\nuse hit.md" },
    ];
    const messages = setMark({
      messages: setMark({ messages: seeded, tag: "pin", toolCallId: "keep" }).messages,
      tag: "scratch",
      toolCallId: "junk",
    }).messages;

    const out = runAmpi(SANITIZE_RECIPE, { messages, trip, sanitize: { what: "phase" } });

    expect(out.messages.some((m) => m.tool_call_id === "junk")).toBe(false);
    expect(out.messages.some((m) => m.tool_call_id === "keep")).toBe(true);
    expect(listKeepers(out.messages).map((k) => k.path)).toEqual(["hit.md"]);
    const last = String(out.messages[out.messages.length - 1]!.content);
    expect(last).toContain("[[mba:");
    expect(last).not.toContain("<think>");
    expect(out.messages.some((m) => String(m.content).includes("use hit.md"))).toBe(true);
  });
});
