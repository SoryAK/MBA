/**
 * AMPI plane (ADR-0101 / ADR-0105).
 *
 * The engine (`runAmpi`) looks up a recipe, asks CM to edit, and terminates.
 */

export { runAmpi, runRecipe } from "./engine.js";
export type { RunAmpiOptions, RunRecipeOptions } from "./engine.js";
export { builtinRecipes, lookupRecipe } from "./registry.js";
export { SANITIZE_RECIPE, sanitizeRecipe } from "./recipes/sanitize.js";
export { SWEEP_DUPLICATES_RECIPE, sweepDuplicatesRecipe } from "./recipes/sweep-duplicates.js";
export type {
  AmpiAct,
  AmpiEngineResult,
  AmpiRecipe,
  AmpiRecipeContext,
  AmpiRecipeResult,
  AmpiRecipeStep,
} from "./types.js";
export { AMPI_ACTS } from "./types.js";
