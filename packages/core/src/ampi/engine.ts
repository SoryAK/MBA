/**
 * AMPI engine (ADR-0101 Step 3, Notch 0 / ADR-0105).
 *
 * Looks up a named recipe, runs it, asks the CM engine to apply each cut,
 * and enforces structural termination: a hard `maxTurns` cap and a strictly
 * decreasing progress measure. Unknown recipes are an explicit miss, not a
 * successful mop.
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

function miss(ctx: AmpiRecipeContext, reason: "unknown-recipe"): AmpiEngineResult {
  return {
    ok: false,
    reason,
    messages: ctx.messages,
    act: "rewrite-context",
    turnsUsed: 0,
    progress: 0,
    effect: "none",
    applied: [],
    cacheAction: "keep",
  };
}

export function runAmpi(
  name: string,
  ctx: AmpiRecipeContext,
  opts: RunAmpiOptions = {},
): AmpiEngineResult {
  const recipe = lookupRecipe(name, opts.recipes);
  if (!recipe) {
    return miss(ctx, "unknown-recipe");
  }

  let messages = ctx.messages;
  let progress = Number.POSITIVE_INFINITY;
  let turnsUsed = 0;
  let act: AmpiEngineResult["act"] = "rewrite-context";
  let effect: AmpiEngineResult["effect"] = "none";
  let applied: AmpiEngineResult["applied"] = [];
  let cacheAction: AmpiEngineResult["cacheAction"] = "keep";

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
    effect = edited.effect;
    applied = edited.applied;
    cacheAction = edited.cacheAction;
    if (progress <= 0) break;
  }

  return {
    ok: true,
    messages,
    act,
    turnsUsed,
    progress: Number.isFinite(progress) ? progress : 0,
    effect,
    applied,
    cacheAction,
  };
}

/** Alias for {@link runAmpi}. */
export const runRecipe = runAmpi;
export type RunRecipeOptions = RunAmpiOptions;
