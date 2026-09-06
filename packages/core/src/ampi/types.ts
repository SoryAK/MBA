/**
 * AMPI recipe types (ADR-0101 Step 3, Notch 0).
 *
 * The `act` surface is a closed enum — the line that never moves. This slice
 * ships one act (`rewrite-context`). Later notches add expressions, not acts.
 */

import type { ChatMessage } from "../chat-message.js";
import type { ToolCircuitBreakerTrip } from "../bcb/types.js";

export const AMPI_ACTS = ["rewrite-context"] as const;
export type AmpiAct = (typeof AMPI_ACTS)[number];

export interface AmpiRecipeContext {
  readonly messages: readonly ChatMessage[];
  readonly trip: ToolCircuitBreakerTrip;
}

export interface AmpiRecipeResult {
  readonly messages: readonly ChatMessage[];
  readonly act: AmpiAct;
  readonly turnsUsed: number;
  /**
   * Remaining progress measure after this step. 0 means the recipe is done.
   * The engine requires this to strictly decrease each turn.
   */
  readonly progress: number;
}

export interface AmpiRecipe {
  readonly name: string;
  readonly maxTurns: number;
  run(ctx: AmpiRecipeContext): AmpiRecipeResult;
}
