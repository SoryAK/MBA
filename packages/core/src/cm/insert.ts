/**
 * Write cut `insert` (ADR-0105).
 *
 * Add messages at an index. Closed roles: system, user.
 */

import type { ChatMessage } from "../chat-message.js";
import type { CmEditResult, CmInsertRole } from "./types.js";

export interface InsertArgs {
  readonly messages: readonly ChatMessage[];
  readonly role: CmInsertRole;
  readonly at: number;
  readonly contents: readonly string[];
}

export function insert(ctx: InsertArgs): CmEditResult {
  if (ctx.contents.length === 0) {
    return { messages: ctx.messages, cut: "insert", progress: 0 };
  }
  const at = Math.max(0, Math.min(ctx.at, ctx.messages.length));
  const inserted: ChatMessage[] = ctx.contents.map((content) => ({
    role: ctx.role,
    content,
  }));
  return {
    messages: [...ctx.messages.slice(0, at), ...inserted, ...ctx.messages.slice(at)],
    cut: "insert",
    progress: 0,
  };
}

/** @deprecated Use {@link insert} with role system. */
export function insertSystem(ctx: {
  readonly messages: readonly ChatMessage[];
  readonly at: number;
  readonly contents: readonly string[];
}): CmEditResult {
  return insert({ ...ctx, role: "system" });
}
