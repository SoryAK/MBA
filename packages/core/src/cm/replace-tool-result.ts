/**
 * Guard cut `replace-tool-result` (ADR-0105).
 *
 * Sets the content of the tool message with the given `tool_call_id`.
 * TCB rules decide the text; CM applies the splice.
 */

import type { ChatMessage } from "../chat-message.js";
import type { CmEditResult, CmReplaceToolResultContext } from "./types.js";

export function replaceToolResult(ctx: CmReplaceToolResultContext): CmEditResult {
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
    cut: "replace-tool-result",
    progress: 0,
  };
}
