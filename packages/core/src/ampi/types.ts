/**
 * AMPI recipe types (ADR-0101 Step 3, Notch 0 / ADR-0105).
 *
 * The `act` surface is a closed enum — the line that never moves. This slice
 * ships one act (`rewrite-context`). Later notches add expressions, not acts.
 *
 * A recipe names a CM intent (or a short sequence). It does not return a
 * spliced `messages[]`. The AMPI engine asks the CM engine to apply the cut.
 */

import type { ChatMessage } from "../chat-message.js";
import type { ToolCircuitBreakerTrip } from "../bcb/types.js";
import type { CmIntent } from "../cm/types.js";
import type { ReasoningGate } from "../cm/reasoning.js";

export const SANITIZE_WHATS = ["duplicates", "scratch", "reasoning", "phase", "pin"] as const;
export type SanitizeWhat = (typeof SANITIZE_WHATS)[number];

export interface SanitizeOptions {
  readonly what?: SanitizeWhat;
  /** Pin the tripped tool pair as a keeper before the mop. */
  readonly pin?: boolean;
}

export const AMPI_ACTS = ["rewrite-context"] as const;
export type AmpiAct = (typeof AMPI_ACTS)[number];

export interface AmpiRecipeContext {
  readonly messages: readonly ChatMessage[];
  readonly trip: ToolCircuitBreakerTrip;
  /** Modes for the built-in `sanitize` recipe. Ignored by other recipes. */
  readonly sanitize?: SanitizeOptions;
  /** Model + server dial. Compact is skipped when this is an explicit off. */
  readonly reasoning?: ReasoningGate;
}

/** One recipe step: which act, which CM cut, remaining progress. */
export interface AmpiRecipeStep {
  readonly act: AmpiAct;
  /** One cut, or a short sequence (`phase` = sweep then compact). */
  readonly cm: CmIntent | readonly CmIntent[];
  readonly turnsUsed: number;
  /**
   * Remaining progress measure after this step. 0 means the recipe is done.
   * The engine requires this to strictly decrease each turn.
   */
  readonly progress: number;
}

/** What the AMPI engine returns after applying CM and enforcing termination. */
export interface AmpiEngineResult {
  readonly messages: readonly ChatMessage[];
  readonly act: AmpiAct;
  readonly turnsUsed: number;
  readonly progress: number;
}

export interface AmpiRecipe {
  readonly name: string;
  readonly maxTurns: number;
  run(ctx: AmpiRecipeContext): AmpiRecipeStep;
}

/** Alias for {@link AmpiEngineResult}. */
export type AmpiRecipeResult = AmpiEngineResult;
