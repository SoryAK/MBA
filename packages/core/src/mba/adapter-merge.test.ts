/**
 * Contract tests for the MBA deep-merge helper.
 *
 * The load-bearing assumption for `extraArgs` (ADR-0100): a nested plain
 * object under the `server` block must merge key-by-key across rungs, so a
 * child rung's `extraArgs` augments the parent's instead of wiping it.
 */
import { describe, expect, it } from "vitest";
import { deepMergeObjects } from "./adapter-merge.js";

describe("deepMergeObjects", () => {
  it("deep-merges a nested extraArgs map key-by-key (child augments parent)", () => {
    // Both literals are typed as Record<string, unknown> so deepMergeObjects'
    // single type parameter T unifies (the child rung legitimately omits
    // ctxSize that the parent rung carries).
    const parent: Record<string, unknown> = { "llama.cpp": { ctxSize: 100000, extraArgs: { "no-mmap": true, temp: 0.7 } } };
    const child: Record<string, unknown> = { "llama.cpp": { extraArgs: { "n-cpu-moe": 4 } } };
    const merged = deepMergeObjects(parent, child);
    // Parent keys survive; child key is added; the scalar ctxSize is untouched.
    expect(merged["llama.cpp"]).toEqual({
      ctxSize: 100000,
      extraArgs: { "no-mmap": true, temp: 0.7, "n-cpu-moe": 4 },
    });
  });

  it("child scalar overrides parent scalar (existing behavior)", () => {
    const merged = deepMergeObjects({ a: 1, b: 2 }, { b: 20 });
    expect(merged).toEqual({ a: 1, b: 20 });
  });
});
