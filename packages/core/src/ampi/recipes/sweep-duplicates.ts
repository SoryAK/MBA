/**
 * AMPI recipe `sweep-duplicates` (ADR-0105).
 *
 * Runner only: terminate in one turn and ask CM for the CGC cut
 * `prune-duplicates`. This recipe does not splice `messages[]`.
 */

import { pruneDuplicates } from "../../cm/cgc/prune-duplicates.js";
import type { AmpiRecipe, AmpiRecipeContext, AmpiRecipeResult } from "../types.js";

export const SWEEP_DUPLICATES_RECIPE = "sweep-duplicates";

export function runSweepDuplicates(ctx: AmpiRecipeContext): AmpiRecipeResult {
  const edited = pruneDuplicates({ messages: ctx.messages, trip: ctx.trip });
  return {
    messages: edited.messages,
    act: "rewrite-context",
    turnsUsed: 1,
    progress: edited.progress,
  };
}

export const sweepDuplicatesRecipe: AmpiRecipe = {
  name: SWEEP_DUPLICATES_RECIPE,
  maxTurns: 1,
  run: runSweepDuplicates,
};
