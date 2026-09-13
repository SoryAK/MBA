/**
 * Drop assistant/tool pairs by `tool_call_id` without discarding sibling
 * calls that share the same assistant message.
 */

import type { ChatMessage } from "../chat-message.js";

function callId(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const id = (raw as { id?: unknown }).id;
  return typeof id === "string" ? id : undefined;
}

/**
 * Remove tool results and tool_calls whose ids are in `ids`.
 * An assistant with no remaining calls is dropped.
 * Same `messages` reference when nothing is removed.
 */
export function dropToolCallIds(
  messages: readonly ChatMessage[],
  ids: ReadonlySet<string>,
): readonly ChatMessage[] {
  if (ids.size === 0) return messages;
  let changed = false;
  const next: ChatMessage[] = [];
  for (const message of messages) {
    if (
      message.role === "tool" &&
      typeof message.tool_call_id === "string" &&
      ids.has(message.tool_call_id)
    ) {
      changed = true;
      continue;
    }
    const calls = message.tool_calls;
    if (message.role === "assistant" && Array.isArray(calls)) {
      const kept = calls.filter((raw) => {
        const id = callId(raw);
        return id === undefined || !ids.has(id);
      });
      if (kept.length !== calls.length) {
        changed = true;
        if (kept.length === 0) continue;
        next.push({ ...message, tool_calls: kept });
        continue;
      }
    }
    next.push(message);
  }
  return changed ? next : messages;
}
