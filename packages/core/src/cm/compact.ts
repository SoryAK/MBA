/**
 * Compact cut (ADR-0105).
 *
 * Shrink a spent reasoning span to residue. Not implemented this slice —
 * unknown/empty target is a no-op so the engine switch stays closed.
 */

import type { ChatMessage } from "../chat-message.js";
import type { CmEditResult } from "./types.js";

export function compact(ctx: {
  readonly messages: readonly ChatMessage[];
  readonly target: "reasoning";
}): CmEditResult {
  return { messages: ctx.messages, cut: "compact", progress: 0 };
}
