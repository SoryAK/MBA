/**
 * Sweep cut (ADR-0105).
 *
 * Drop by policy. Always leave residue when something is removed.
 * `duplicates` is the shipped prune. `scratch` drops marked scratch, skips pins.
 * `budget` is a no-op until a window size is wired.
 */

import type { ChatMessage } from "../chat-message.js";
import type { ToolCircuitBreakerTrip } from "../bcb/types.js";
import { pruneDuplicates } from "./cgc/prune-duplicates.js";
import { readMark } from "./types.js";
import type { CmEditResult, CmSweepWhat } from "./types.js";

export interface SweepArgs {
  readonly messages: readonly ChatMessage[];
  readonly what: CmSweepWhat;
  readonly trip?: ToolCircuitBreakerTrip;
}

function residue(kind: string): ChatMessage {
  return {
    role: "user",
    content: `[[mba: swept ${kind}. Those messages were removed; continue with what remains.]]`,
  };
}

function sweepScratch(messages: readonly ChatMessage[]): CmEditResult {
  const drop = new Set<number>();
  for (let i = 0; i < messages.length; i += 1) {
    if (readMark(messages[i]!) === "scratch") drop.add(i);
  }
  if (drop.size === 0) {
    return { messages, cut: "sweep", progress: 0 };
  }
  const kept = messages.filter((_, i) => !drop.has(i));
  kept.push(residue("scratch"));
  return { messages: kept, cut: "sweep", progress: 0 };
}

export function sweep(ctx: SweepArgs): CmEditResult {
  if (ctx.what === "duplicates") {
    if (!ctx.trip) return { messages: ctx.messages, cut: "sweep", progress: 0 };
    return pruneDuplicates({ messages: ctx.messages, trip: ctx.trip });
  }
  if (ctx.what === "scratch") {
    return sweepScratch(ctx.messages);
  }
  return { messages: ctx.messages, cut: "sweep", progress: 0 };
}
