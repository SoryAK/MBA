/**
 * Context Management types (ADR-0105).
 *
 * CM owns what the model is about to see. Closed cuts only — callers never
 * splice `messages[]` themselves. CGC is a family of cleanup cuts under CM.
 */

import type { ChatMessage } from "../chat-message.js";
import type { ToolCircuitBreakerTrip } from "../bcb/types.js";

export const CM_CGC_CUTS = ["prune-duplicates"] as const;
export type CmCgcCut = (typeof CM_CGC_CUTS)[number];

export interface CmEditContext {
  readonly messages: readonly ChatMessage[];
  readonly trip: ToolCircuitBreakerTrip;
}

export interface CmEditResult {
  readonly messages: readonly ChatMessage[];
  readonly cut: CmCgcCut;
  /** Remaining progress after the cut. 0 means nothing left to clean for this cut. */
  readonly progress: number;
}
