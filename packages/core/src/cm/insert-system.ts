/**
 * Guard cut `insert-system` (ADR-0105).
 *
 * Inserts system messages at an index. TCB hints decide the text and
 * placement; CM applies the splice.
 */

import type { ChatMessage } from "../chat-message.js";
import type { CmEditResult, CmInsertSystemContext } from "./types.js";

export function insertSystem(ctx: CmInsertSystemContext): CmEditResult {
  if (ctx.contents.length === 0) {
    return { messages: ctx.messages, cut: "insert-system", progress: 0 };
  }
  const at = Math.max(0, Math.min(ctx.at, ctx.messages.length));
  const inserted: ChatMessage[] = ctx.contents.map((content) => ({
    role: "system",
    content,
  }));
  return {
    messages: [...ctx.messages.slice(0, at), ...inserted, ...ctx.messages.slice(at)],
    cut: "insert-system",
    progress: 0,
  };
}
