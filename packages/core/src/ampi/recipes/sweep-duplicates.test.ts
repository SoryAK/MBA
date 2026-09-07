import { describe, expect, it } from "vitest";
import { applyCm } from "../../cm/engine.js";
import { runAmpi } from "../engine.js";
import { SANITIZE_RECIPE } from "./sanitize.js";
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

describe("AMPI sanitize / sweep-duplicates", () => {
  it("keeps sweep-duplicates as an alias, not a CM cut name", () => {
    expect(SWEEP_DUPLICATES_RECIPE).toBe("sweep-duplicates");
    expect(SANITIZE_RECIPE).toBe("sanitize");
  });

  it("names a CM sweep and does not return spliced messages", () => {
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
    expect(step.cm).toEqual({ cut: "sweep", what: "duplicates", trip });
    expect(step).not.toHaveProperty("messages");

    const viaAlias = runAmpi(SWEEP_DUPLICATES_RECIPE, { messages, trip });
    const viaSanitize = runAmpi(SANITIZE_RECIPE, { messages, trip });
    const viaCm = applyCm(messages, { cut: "sweep", what: "duplicates", trip });
    expect(viaAlias.messages).toEqual(viaCm.messages);
    expect(viaSanitize.messages).toEqual(viaCm.messages);
  });
});
