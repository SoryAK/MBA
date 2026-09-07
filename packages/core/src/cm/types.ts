/**
 * Context Management types (ADR-0105).
 *
 * CM owns what the model is about to see. Closed cuts only — callers never
 * splice `messages[]` themselves. CGC is the cleanup family; guard cuts are
 * the mechanical edits TCB uses (replace a tool result, insert a hint).
 */

import type { ChatMessage } from "../chat-message.js";
import type { ToolCircuitBreakerTrip } from "../bcb/types.js";

export const CM_CGC_CUTS = ["prune-duplicates"] as const;
export type CmCgcCut = (typeof CM_CGC_CUTS)[number];

export const CM_GUARD_CUTS = ["replace-tool-result", "insert-system"] as const;
export type CmGuardCut = (typeof CM_GUARD_CUTS)[number];

export const CM_CUTS = [...CM_CGC_CUTS, ...CM_GUARD_CUTS] as const;
export type CmCut = (typeof CM_CUTS)[number];

export interface CmEditContext {
  readonly messages: readonly ChatMessage[];
  readonly trip: ToolCircuitBreakerTrip;
}

export interface CmReplaceToolResultContext {
  readonly messages: readonly ChatMessage[];
  readonly toolCallId: string;
  readonly content: string;
}

export interface CmInsertSystemContext {
  readonly messages: readonly ChatMessage[];
  /** Insertion index, clamped to [0, messages.length]. */
  readonly at: number;
  readonly contents: readonly string[];
}

export interface CmEditResult {
  readonly messages: readonly ChatMessage[];
  readonly cut: CmCut;
  /** Remaining progress after the cut. 0 means nothing left to clean for this cut. */
  readonly progress: number;
}

/**
 * Closed CM request. Callers name a cut and its args; they never pass a
 * hand-built `messages[]` patch. The engine holds the current transcript.
 */
export type CmIntent =
  | { readonly cut: "prune-duplicates"; readonly trip: ToolCircuitBreakerTrip }
  | { readonly cut: "replace-tool-result"; readonly toolCallId: string; readonly content: string }
  | { readonly cut: "insert-system"; readonly at: number; readonly contents: readonly string[] };

export interface CmEngineResult {
  readonly messages: readonly ChatMessage[];
  readonly applied: readonly CmCut[];
  readonly cutsUsed: number;
}
