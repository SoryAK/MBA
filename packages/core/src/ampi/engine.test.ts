import { describe, expect, it } from "vitest";
import { runRecipe } from "./engine.js";
import type { AmpiRecipe, AmpiRecipeContext } from "./types.js";
import type { ToolCircuitBreakerTrip } from "../bcb/types.js";

const trip: ToolCircuitBreakerTrip = {
  tool: "read_file",
  rule: "directDuplication",
  toolCallId: "call_1",
  message: "dup",
  meta: {},
  targetKey: "read_file:x",
};

const ctx: AmpiRecipeContext = {
  messages: [{ role: "user", content: "hi" }],
  trip,
};

describe("runRecipe", () => {
  it("no-ops an unknown recipe", () => {
    const out = runRecipe("does-not-exist", ctx);
    expect(out.messages).toBe(ctx.messages);
    expect(out.turnsUsed).toBe(0);
    expect(out.progress).toBe(0);
  });

  it("stops a runaway stub at maxTurns", () => {
    let remaining = 100;
    const runaway: AmpiRecipe = {
      name: "runaway",
      maxTurns: 3,
      run: (input) => ({
        messages: [...input.messages, { role: "user", content: "again" }],
        act: "rewrite-context",
        turnsUsed: 1,
        progress: remaining--,
      }),
    };
    const out = runRecipe("runaway", ctx, { recipes: new Map([["runaway", runaway]]) });
    expect(out.turnsUsed).toBe(3);
    expect(out.messages).toHaveLength(4);
    expect(out.progress).toBe(98);
  });

  it("stops when progress does not decrease", () => {
    const stuck: AmpiRecipe = {
      name: "stuck",
      maxTurns: 8,
      run: (input) => ({
        messages: input.messages,
        act: "rewrite-context",
        turnsUsed: 1,
        progress: 4,
      }),
    };
    const out = runRecipe("stuck", ctx, { recipes: new Map([["stuck", stuck]]) });
    expect(out.turnsUsed).toBe(2);
    expect(out.progress).toBe(4);
  });
});
