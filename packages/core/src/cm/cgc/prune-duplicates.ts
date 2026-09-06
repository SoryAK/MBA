/**
 * CGC cut `prune-duplicates` (ADR-0105).
 *
 * Context Management owns this edit. AMPI recipes may call it; they do not
 * implement the splice.
 *
 * Finds the trailing run of identical (tool + argHash) assistant/tool pairs
 * for the tripped call, keeps the first pair, drops the later ones, and
 * appends an `[[mba: …]]` residue. No trailing run → messages unchanged.
 */

import type { ChatMessage } from "../../chat-message.js";
import { orderedToolCalls } from "../../bcb/parse-calls.js";
import type { ToolCircuitBreakerTrip } from "../../bcb/types.js";
import type { CmEditContext, CmEditResult } from "../types.js";

export const CGC_MARKER_PREFIX = "[[mba:";

interface ToolPair {
  readonly assistantIndex: number;
  readonly resultIndex: number | undefined;
  readonly toolCallId: string;
  readonly tool: string;
  readonly argHash: string;
}

function collectPairs(messages: readonly ChatMessage[]): ToolPair[] {
  const byId = new Map<string, { tool: string; argHash: string }>();
  for (const call of orderedToolCalls(messages)) {
    byId.set(call.toolCallId, { tool: call.tool, argHash: call.argHash });
  }

  const pairs: ToolPair[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i]!;
    const calls = m.tool_calls;
    if (m.role !== "assistant" || !Array.isArray(calls)) continue;
    for (const raw of calls) {
      if (!raw || typeof raw !== "object") continue;
      const id = (raw as { id?: unknown }).id;
      if (typeof id !== "string") continue;
      const ident = byId.get(id);
      if (!ident) continue;
      let resultIndex: number | undefined;
      for (let j = i + 1; j < messages.length; j += 1) {
        const next = messages[j]!;
        if (next.role === "assistant") break;
        if (next.role === "tool" && next.tool_call_id === id) {
          resultIndex = j;
          break;
        }
      }
      pairs.push({
        assistantIndex: i,
        resultIndex,
        toolCallId: id,
        tool: ident.tool,
        argHash: ident.argHash,
      });
    }
  }
  return pairs;
}

/** Trailing run of pairs that match the tripped call's (tool, argHash). */
export function trailingDuplicateRun(
  messages: readonly ChatMessage[],
  trip: ToolCircuitBreakerTrip,
): readonly ToolPair[] {
  const pairs = collectPairs(messages);
  if (pairs.length === 0) return [];

  const anchor =
    pairs.find((p) => p.toolCallId === trip.toolCallId) ??
    [...pairs].reverse().find((p) => p.tool === trip.tool);
  if (!anchor) return [];

  let start = pairs.lastIndexOf(anchor);
  while (start > 0) {
    const prev = pairs[start - 1]!;
    if (prev.tool !== anchor.tool || prev.argHash !== anchor.argHash) break;
    start -= 1;
  }
  return pairs.slice(start, pairs.lastIndexOf(anchor) + 1);
}

function formatMarker(tool: string, dropped: number): string {
  const noun = dropped === 1 ? "call" : "calls";
  return `[[mba: pruned ${dropped} duplicate ${tool} ${noun}. Those repeats were removed; try a different approach.]]`;
}

export function pruneDuplicates(ctx: CmEditContext): CmEditResult {
  const run = trailingDuplicateRun(ctx.messages, ctx.trip);
  const extra = Math.max(0, run.length - 1);
  if (extra === 0) {
    return { messages: ctx.messages, cut: "prune-duplicates", progress: 0 };
  }

  const drop = new Set<number>();
  for (const pair of run.slice(1)) {
    drop.add(pair.assistantIndex);
    if (pair.resultIndex !== undefined) drop.add(pair.resultIndex);
  }
  const kept: ChatMessage[] = ctx.messages.filter((_, i) => !drop.has(i));
  kept.push({ role: "user", content: formatMarker(run[0]!.tool, extra) });

  return { messages: kept, cut: "prune-duplicates", progress: 0 };
}
