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
import { dropToolCallIds } from "./drop-pairs.js";
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

function scratchIds(messages: readonly ChatMessage[]): Set<string> {
  const pinned = new Set<string>();
  const scratched = new Set<string>();
  for (const message of messages) {
    if (message.role !== "tool" || typeof message.tool_call_id !== "string") continue;
    const mark = readMark(message);
    if (mark === "pin") pinned.add(message.tool_call_id);
    if (mark === "scratch") scratched.add(message.tool_call_id);
  }
  for (const id of pinned) scratched.delete(id);
  return scratched;
}

function sweepScratch(messages: readonly ChatMessage[]): CmEditResult {
  const ids = scratchIds(messages);
  const kept = dropToolCallIds(messages, ids);
  if (kept === messages) {
    return { messages, cut: "sweep", progress: 0 };
  }
  return { messages: [...kept, residue("scratch")], cut: "sweep", progress: 0 };
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
