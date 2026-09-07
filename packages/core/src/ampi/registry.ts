/**
 * Built-in AMPI recipe registry (ADR-0101 Step 3 / ADR-0105).
 *
 * Recipe names are AMPI-side only. They must not be CM cut names.
 * User-authored recipe files are deferred.
 */

import { sanitizeRecipe } from "./recipes/sanitize.js";
import { sweepDuplicatesRecipe } from "./recipes/sweep-duplicates.js";
import type { AmpiRecipe } from "./types.js";

const BUILTIN: ReadonlyMap<string, AmpiRecipe> = new Map([
  [sanitizeRecipe.name, sanitizeRecipe],
  [sweepDuplicatesRecipe.name, sweepDuplicatesRecipe],
]);

export function builtinRecipes(): ReadonlyMap<string, AmpiRecipe> {
  return BUILTIN;
}

export function lookupRecipe(
  name: string,
  recipes: ReadonlyMap<string, AmpiRecipe> = BUILTIN,
): AmpiRecipe | undefined {
  return recipes.get(name);
}
