import { describe, expect, it } from "vitest";
import { runAmpi } from "./engine.js";
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

describe("runAmpi", () => {
  it("no-ops an unknown recipe", () => {
    const out = runAmpi("does-not-exist", ctx);
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
        act: "rewrite-context",
        cm: { cut: "insert", role: "system", at: input.messages.length, contents: ["again"] },
        turnsUsed: 1,
        progress: remaining--,
      }),
    };
    const out = runAmpi("runaway", ctx, { recipes: new Map([["runaway", runaway]]) });
    expect(out.turnsUsed).toBe(3);
    expect(out.messages).toHaveLength(4);
    expect(out.progress).toBe(98);
  });

  it("stops when progress does not decrease", () => {
    const stuck: AmpiRecipe = {
      name: "stuck",
      maxTurns: 8,
      run: () => ({
        act: "rewrite-context",
        cm: { cut: "insert", role: "system", at: 0, contents: [] },
        turnsUsed: 1,
        progress: 4,
      }),
    };
    const out = runAmpi("stuck", ctx, { recipes: new Map([["stuck", stuck]]) });
    expect(out.turnsUsed).toBe(2);
    expect(out.progress).toBe(4);
    expect(out.messages).toBe(ctx.messages);
  });
});
