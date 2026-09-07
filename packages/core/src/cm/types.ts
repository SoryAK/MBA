/**
 * Context Management types (ADR-0105).
 *
 * Four categories, five cuts: Write (replace, insert), Mark (set-mark),
 * Sweep (sweep), Compact (later). Callers name a closed intent.
 */

import type { ChatMessage } from "../chat-message.js";
import type { ToolCircuitBreakerTrip } from "../bcb/types.js";

export const CM_MARKS = ["scratch", "pin"] as const;
export type CmMark = (typeof CM_MARKS)[number];

export const CM_REPLACE_TARGETS = ["tool-result", "system", "residue"] as const;
export type CmReplaceTarget = (typeof CM_REPLACE_TARGETS)[number];

export const CM_INSERT_ROLES = ["system", "user"] as const;
export type CmInsertRole = (typeof CM_INSERT_ROLES)[number];

export const CM_SWEEP_WHATS = ["duplicates", "scratch", "budget"] as const;
export type CmSweepWhat = (typeof CM_SWEEP_WHATS)[number];

export const CM_CUTS = ["replace", "insert", "set-mark", "sweep", "compact"] as const;
export type CmCut = (typeof CM_CUTS)[number];

/** @deprecated Use CM_CUTS. */
export const CM_CGC_CUTS = ["sweep"] as const;
export type CmCgcCut = "sweep";
/** @deprecated Use CM_CUTS. */
export const CM_GUARD_CUTS = ["replace", "insert"] as const;
export type CmGuardCut = "replace" | "insert";

export interface CmEditContext {
  readonly messages: readonly ChatMessage[];
  readonly trip: ToolCircuitBreakerTrip;
}

export interface CmEditResult {
  readonly messages: readonly ChatMessage[];
  readonly cut: CmCut;
  readonly progress: number;
}

export type CmIntent =
  | {
      readonly cut: "replace";
      readonly target: CmReplaceTarget;
      readonly content: string;
      readonly toolCallId?: string;
      readonly at?: number;
    }
  | {
      readonly cut: "insert";
      readonly role: CmInsertRole;
      readonly at: number;
      readonly contents: readonly string[];
    }
  | {
      readonly cut: "set-mark";
      readonly tag: CmMark | "clear";
      readonly toolCallId: string;
    }
  | {
      readonly cut: "sweep";
      readonly what: CmSweepWhat;
      readonly trip?: ToolCircuitBreakerTrip;
    }
  | {
      readonly cut: "compact";
      readonly target: "reasoning";
    };

export interface CmEngineResult {
  readonly messages: readonly ChatMessage[];
  readonly applied: readonly CmCut[];
  readonly cutsUsed: number;
}

/** Extra field on a ChatMessage that travels with the transcript. */
export const MBA_META_KEY = "mba";

export interface MbaMeta {
  readonly mark?: CmMark;
}

export function readMark(message: ChatMessage): CmMark | undefined {
  const raw = message[MBA_META_KEY];
  if (!raw || typeof raw !== "object") return undefined;
  const mark = (raw as MbaMeta).mark;
  return mark === "scratch" || mark === "pin" ? mark : undefined;
}

export function withMark(message: ChatMessage, tag: CmMark | undefined): ChatMessage {
  const prev = message[MBA_META_KEY];
  const base =
    prev && typeof prev === "object" && !Array.isArray(prev)
      ? { ...(prev as Record<string, unknown>) }
      : {};
  if (tag === undefined) {
    delete base.mark;
    const next = { ...message } as Record<string, unknown>;
    if (Object.keys(base).length === 0) delete next[MBA_META_KEY];
    else next[MBA_META_KEY] = base;
    return next as ChatMessage;
  }
  return { ...message, [MBA_META_KEY]: { ...base, mark: tag } };
}
