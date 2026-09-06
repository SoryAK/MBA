import { describe, expect, it } from "vitest";
import { pruneDuplicates } from "../../cm/cgc/prune-duplicates.js";
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

  it("delegates the splice to CM and does not invent its own messages", () => {
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
    const viaRecipe = runSweepDuplicates({ messages, trip });
    const viaCm = pruneDuplicates({ messages, trip });
    expect(viaRecipe.act).toBe("rewrite-context");
    expect(viaRecipe.messages).toEqual(viaCm.messages);
    expect(viaRecipe.progress).toBe(viaCm.progress);
  });
});
