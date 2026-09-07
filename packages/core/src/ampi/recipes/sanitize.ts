/**
 * AMPI function `sanitize` (ADR-0105).
 *
 * Clean trip residue. This slice: `what: duplicates` or `scratch`.
 */

import type { AmpiRecipe, AmpiRecipeContext, AmpiRecipeStep } from "../types.js";

export const SANITIZE_RECIPE = "sanitize";

export interface SanitizeOptions {
  readonly what?: "duplicates" | "scratch";
}

export function runSanitize(
  ctx: AmpiRecipeContext,
  opts: SanitizeOptions = {},
): AmpiRecipeStep {
  return {
    act: "rewrite-context",
    cm: { cut: "sweep", what: opts.what ?? "duplicates", trip: ctx.trip },
    turnsUsed: 1,
    progress: 0,
  };
}

export const sanitizeRecipe: AmpiRecipe = {
  name: SANITIZE_RECIPE,
  maxTurns: 1,
  run: (ctx) => runSanitize(ctx, { what: "duplicates" }),
};
