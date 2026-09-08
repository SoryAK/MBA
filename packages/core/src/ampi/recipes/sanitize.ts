/**
 * AMPI function `sanitize` (ADR-0105).
 *
 * Modes: `duplicates` | `scratch` | `reasoning` | `phase` | `pin`.
 * `pin?: true` marks the tripped pair as a keeper before the mop.
 * Compact is omitted when `ctx.reasoning` says the model or the dial is off.
 */

import { shouldCompactReasoning } from "../../cm/reasoning.js";
import type { CmIntent } from "../../cm/types.js";
import type {
  AmpiRecipe,
  AmpiRecipeContext,
  AmpiRecipeStep,
  SanitizeOptions,
} from "../types.js";

export const SANITIZE_RECIPE = "sanitize";
export type { SanitizeOptions, SanitizeWhat } from "../types.js";
export { SANITIZE_WHATS } from "../types.js";

function pinIntent(ctx: AmpiRecipeContext): CmIntent | undefined {
  const id = ctx.trip.toolCallId;
  if (typeof id !== "string" || id.length === 0) return undefined;
  return { cut: "set-mark", tag: "pin", toolCallId: id };
}

export function sanitizeIntents(
  ctx: AmpiRecipeContext,
  opts: SanitizeOptions = {},
): CmIntent[] {
  const what = opts.what ?? "duplicates";
  const cuts: CmIntent[] = [];
  if (opts.pin === true && what !== "pin") {
    const pin = pinIntent(ctx);
    if (pin) cuts.push(pin);
  }
  switch (what) {
    case "pin": {
      const pin = pinIntent(ctx);
      if (pin) cuts.push(pin);
      break;
    }
    case "reasoning":
      if (shouldCompactReasoning(ctx.reasoning)) {
        cuts.push({ cut: "compact", target: "reasoning" });
      }
      break;
    case "phase":
      cuts.push({ cut: "sweep", what: "scratch", trip: ctx.trip });
      if (shouldCompactReasoning(ctx.reasoning)) {
        cuts.push({ cut: "compact", target: "reasoning" });
      }
      break;
    case "scratch":
      cuts.push({ cut: "sweep", what: "scratch", trip: ctx.trip });
      break;
    default:
      cuts.push({ cut: "sweep", what: "duplicates", trip: ctx.trip });
  }
  return cuts;
}

export function runSanitize(
  ctx: AmpiRecipeContext,
  opts: SanitizeOptions = {},
): AmpiRecipeStep {
  const cuts = sanitizeIntents(ctx, opts);
  return {
    act: "rewrite-context",
    cm: cuts.length === 1 ? cuts[0]! : cuts,
    turnsUsed: 1,
    progress: 0,
  };
}

export const sanitizeRecipe: AmpiRecipe = {
  name: SANITIZE_RECIPE,
  maxTurns: 1,
  run: (ctx) => runSanitize(ctx, ctx.sanitize ?? { what: "duplicates" }),
};
