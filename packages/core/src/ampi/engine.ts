/**
 * In-process AMPI engine (ADR-0101 Step 3, Notch 0).
 *
 * Looks up a named recipe, runs it, and enforces structural termination:
 * a hard `maxTurns` cap and a strictly decreasing progress measure.
 * Unknown recipes are a no-op (log + original messages).
 *
 * Worker-thread isolation and the Notch-1 expression language are deferred.
 */

import { lookupRecipe } from "./registry.js";
import type { AmpiRecipe, AmpiRecipeContext, AmpiRecipeResult } from "./types.js";

export interface RunRecipeOptions {
  /** Override the built-in registry (tests). */
  readonly recipes?: ReadonlyMap<string, AmpiRecipe>;
}

function noop(ctx: AmpiRecipeContext): AmpiRecipeResult {
  return {
    messages: ctx.messages,
    act: "rewrite-context",
    turnsUsed: 0,
    progress: 0,
  };
}

export function runRecipe(
  name: string,
  ctx: AmpiRecipeContext,
  opts: RunRecipeOptions = {},
): AmpiRecipeResult {
  const recipe = lookupRecipe(name, opts.recipes);
  if (!recipe) {
    console.log(`[ampi] unknown recipe: ${name}`);
    return noop(ctx);
  }

  let messages = ctx.messages;
  let progress = Number.POSITIVE_INFINITY;
  let turnsUsed = 0;
  let act: AmpiRecipeResult["act"] = "rewrite-context";

  while (turnsUsed < recipe.maxTurns) {
    const result = recipe.run({ ...ctx, messages });
    turnsUsed += 1;
    act = result.act;
    if (result.progress >= progress) {
      break;
    }
    progress = result.progress;
    messages = result.messages;
    if (progress <= 0) break;
  }

  return {
    messages,
    act,
    turnsUsed,
    progress: Number.isFinite(progress) ? progress : 0,
  };
}
