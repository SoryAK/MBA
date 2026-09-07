/**
 * Mark cut `set-mark` (ADR-0105).
 *
 * Tag a tool-call pair (`mba.mark` on the tool result and its assistant).
 * Does not delete. `clear` removes the tag.
 */

import type { ChatMessage } from "../chat-message.js";
import type { CmEditResult, CmMark } from "./types.js";
import { readMark, withMark } from "./types.js";

export interface SetMarkArgs {
  readonly messages: readonly ChatMessage[];
  readonly tag: CmMark | "clear";
  readonly toolCallId: string;
}

function ownsCall(message: ChatMessage, toolCallId: string): boolean {
  const calls = message.tool_calls;
  if (message.role !== "assistant" || !Array.isArray(calls)) return false;
  return calls.some((raw) => {
    if (!raw || typeof raw !== "object") return false;
    return (raw as { id?: unknown }).id === toolCallId;
  });
}

export function setMark(ctx: SetMarkArgs): CmEditResult {
  const tag = ctx.tag === "clear" ? undefined : ctx.tag;
  let changed = false;
  const next: ChatMessage[] = ctx.messages.map((m) => {
    const hit =
      (m.role === "tool" && m.tool_call_id === ctx.toolCallId) || ownsCall(m, ctx.toolCallId);
    if (!hit) return m;
    const already = readMark(m);
    if (already === tag) return m;
    changed = true;
    return withMark(m, tag);
  });
  return {
    messages: changed ? next : ctx.messages,
    cut: "set-mark",
    progress: 0,
  };
}
