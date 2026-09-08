/**
 * AMPI engine (ADR-0101 Step 3, Notch 0 / ADR-0105).
 *
 * Looks up a named recipe, runs it, asks the CM engine to apply each cut,
 * and enforces structural termination: a hard `maxTurns` cap and a strictly
 * decreasing progress measure. Unknown recipes are a no-op.
 *
 * Recipes name a CM intent. They do not splice `messages[]`.
 *
 * Worker-thread isolation and the Notch-1 expression language are deferred.
 */

import { runCm } from "../cm/engine.js";
import type { CmIntent } from "../cm/types.js";
import { lookupRecipe } from "./registry.js";
import type { AmpiEngineResult, AmpiRecipe, AmpiRecipeContext } from "./types.js";

export interface RunAmpiOptions {
  /** Override the built-in registry (tests). */
  readonly recipes?: ReadonlyMap<string, AmpiRecipe>;
}

function noop(ctx: AmpiRecipeContext): AmpiEngineResult {
  return {
    messages: ctx.messages,
    act: "rewrite-context",
    turnsUsed: 0,
    progress: 0,
  };
}

export function runAmpi(
  name: string,
  ctx: AmpiRecipeContext,
  opts: RunAmpiOptions = {},
): AmpiEngineResult {
  const recipe = lookupRecipe(name, opts.recipes);
  if (!recipe) {
    console.log(`[ampi] unknown recipe: ${name}`);
    return noop(ctx);
  }

  let messages = ctx.messages;
  let progress = Number.POSITIVE_INFINITY;
  let turnsUsed = 0;
  let act: AmpiEngineResult["act"] = "rewrite-context";

  while (turnsUsed < recipe.maxTurns) {
    const step = recipe.run({ ...ctx, messages });
    turnsUsed += 1;
    act = step.act;
    const intents: readonly CmIntent[] = Array.isArray(step.cm) ? step.cm : [step.cm];
    const edited = runCm(messages, intents);
    if (step.progress >= progress) {
      break;
    }
    progress = step.progress;
    messages = edited.messages;
    if (progress <= 0) break;
  }

  return {
    messages,
    act,
    turnsUsed,
    progress: Number.isFinite(progress) ? progress : 0,
  };
}

/** Alias for {@link runAmpi}. */
export const runRecipe = runAmpi;
export type RunRecipeOptions = RunAmpiOptions;
