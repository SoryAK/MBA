import { describe, expect, it } from "vitest";
import { applyCm } from "../../cm/engine.js";
import { runAmpi } from "../engine.js";
import { SWEEP_DUPLICATES_RECIPE, runSweepDuplicates } from "./sweep-duplicates.js";
import type { ChatMessage } from "../../chat-message.js";
import type { ToolCircuitBreakerTrip } from "../../bcb/types.js";

const trip: ToolCircuitBreakerTrip = {
  tool: "read_file",
  rule: "directDuplication",
  toolCallId: "b",
  message: "dup",
  meta: {},
  targetKey: "x",
};

describe("AMPI recipe sweep-duplicates", () => {
  it("is an AMPI recipe name, not a CM cut name", () => {
    expect(SWEEP_DUPLICATES_RECIPE).toBe("sweep-duplicates");
    expect(SWEEP_DUPLICATES_RECIPE).not.toContain("cgc");
    expect(SWEEP_DUPLICATES_RECIPE).not.toBe("context-gc");
  });

  it("names a CM cut and does not return spliced messages", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        tool_calls: [
          {
            id: "a",
            type: "function",
            function: { name: "read_file", arguments: JSON.stringify({ path: "n.md" }) },
          },
        ],
      },
      { role: "tool", tool_call_id: "a", content: "1" },
      {
        role: "assistant",
        tool_calls: [
          {
            id: "b",
            type: "function",
            function: { name: "read_file", arguments: JSON.stringify({ path: "n.md" }) },
          },
        ],
      },
      { role: "tool", tool_call_id: "b", content: "2" },
    ];
    const step = runSweepDuplicates({ messages, trip });
    expect(step.act).toBe("rewrite-context");
    expect(step.cm).toEqual({ cut: "prune-duplicates", trip });
    expect(step).not.toHaveProperty("messages");

    const viaEngine = runAmpi(SWEEP_DUPLICATES_RECIPE, { messages, trip });
    const viaCm = applyCm(messages, { cut: "prune-duplicates", trip });
    expect(viaEngine.messages).toEqual(viaCm.messages);
  });
});
