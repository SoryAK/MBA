/**
 * AMPI recipe `sweep-duplicates` (ADR-0105).
 *
 * Runner only: name the CGC cut `prune-duplicates` and stop. The AMPI
 * engine asks CM to apply it. This recipe does not splice `messages[]`.
 */

import type { AmpiRecipe, AmpiRecipeContext, AmpiRecipeStep } from "../types.js";

export const SWEEP_DUPLICATES_RECIPE = "sweep-duplicates";

export function runSweepDuplicates(ctx: AmpiRecipeContext): AmpiRecipeStep {
  return {
    act: "rewrite-context",
    cm: { cut: "prune-duplicates", trip: ctx.trip },
    turnsUsed: 1,
    progress: 0,
  };
}

export const sweepDuplicatesRecipe: AmpiRecipe = {
  name: SWEEP_DUPLICATES_RECIPE,
  maxTurns: 1,
  run: runSweepDuplicates,
};
