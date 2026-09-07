/**
 * Write cut `replace` (ADR-0105).
 *
 * Overwrite one existing message. Closed targets only.
 */

import type { ChatMessage } from "../chat-message.js";
import { CGC_MARKER_PREFIX } from "./cgc/prune-duplicates.js";
import type { CmEditResult, CmReplaceTarget } from "./types.js";

export interface ReplaceArgs {
  readonly messages: readonly ChatMessage[];
  readonly target: CmReplaceTarget;
  readonly content: string;
  readonly toolCallId?: string;
  readonly at?: number;
}

function replaceAt(
  messages: readonly ChatMessage[],
  index: number,
  content: string,
  roleOk: (m: ChatMessage) => boolean,
): CmEditResult {
  const m = messages[index];
  if (!m || !roleOk(m) || m.content === content) {
    return { messages, cut: "replace", progress: 0 };
  }
  const next = messages.slice();
  next[index] = { ...m, content };
  return { messages: next, cut: "replace", progress: 0 };
}

export function replace(ctx: ReplaceArgs): CmEditResult {
  if (ctx.target === "tool-result") {
    if (!ctx.toolCallId) return { messages: ctx.messages, cut: "replace", progress: 0 };
    let found = false;
    let changed = false;
    const next: ChatMessage[] = ctx.messages.map((m) => {
      if (m.role !== "tool" || m.tool_call_id !== ctx.toolCallId) return m;
      found = true;
      if (m.content === ctx.content) return m;
      changed = true;
      return { ...m, content: ctx.content };
    });
    return {
      messages: found && changed ? next : ctx.messages,
      cut: "replace",
      progress: 0,
    };
  }

  if (ctx.target === "system") {
    const at = ctx.at ?? ctx.messages.findIndex((m) => m.role === "system");
    if (at < 0) return { messages: ctx.messages, cut: "replace", progress: 0 };
    return replaceAt(ctx.messages, at, ctx.content, (m) => m.role === "system");
  }

  const at =
    ctx.at ??
    [...ctx.messages]
      .map((m, i) => i)
      .reverse()
      .find((i) => String(ctx.messages[i]!.content ?? "").startsWith(CGC_MARKER_PREFIX));
  if (at === undefined || at < 0) {
    return { messages: ctx.messages, cut: "replace", progress: 0 };
  }
  return replaceAt(ctx.messages, at, ctx.content, (m) =>
    String(m.content ?? "").startsWith(CGC_MARKER_PREFIX),
  );
}

/** @deprecated Use {@link replace} with target tool-result. */
export function replaceToolResult(ctx: {
  readonly messages: readonly ChatMessage[];
  readonly toolCallId: string;
  readonly content: string;
}): CmEditResult {
  return replace({
    messages: ctx.messages,
    target: "tool-result",
    toolCallId: ctx.toolCallId,
    content: ctx.content,
  });
}
