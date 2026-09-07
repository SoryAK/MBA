/**
 * Alias for `sanitize` + `duplicates` (ADR-0105).
 */

import { runSanitize } from "./sanitize.js";
import type { AmpiRecipe, AmpiRecipeContext, AmpiRecipeStep } from "../types.js";

export const SWEEP_DUPLICATES_RECIPE = "sweep-duplicates";

export function runSweepDuplicates(ctx: AmpiRecipeContext): AmpiRecipeStep {
  return runSanitize(ctx, { what: "duplicates" });
}

export const sweepDuplicatesRecipe: AmpiRecipe = {
  name: SWEEP_DUPLICATES_RECIPE,
  maxTurns: 1,
  run: runSweepDuplicates,
};
