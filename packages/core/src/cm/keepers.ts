/**
 * Pin as a keeper list (ADR-0105 step 2).
 *
 * A pin is not only "don't sweep this." It is the residue that may travel
 * into a later action sandbox. Paths come from the pinned tool pair's args.
 */

import type { ChatMessage } from "../chat-message.js";
import { orderedToolCalls } from "../bcb/parse-calls.js";
import { readMark } from "./types.js";

export interface Keeper {
  readonly toolCallId: string;
  readonly tool: string;
  readonly path?: string;
}

const PATH_KEYS = ["path", "filePath", "file", "filename"] as const;

function pathFromArgs(args: Record<string, unknown>): string | undefined {
  for (const key of PATH_KEYS) {
    const value = args[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function pinnedCallIds(messages: readonly ChatMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    if (readMark(message) !== "pin") continue;
    if (message.role === "tool" && typeof message.tool_call_id === "string") {
      ids.add(message.tool_call_id);
    }
    const calls = message.tool_calls;
    if (message.role !== "assistant" || !Array.isArray(calls)) continue;
    for (const raw of calls) {
      if (!raw || typeof raw !== "object") continue;
      const id = (raw as { id?: unknown }).id;
      if (typeof id === "string") ids.add(id);
    }
  }
  return ids;
}

/** Keepers currently marked `pin` on the transcript, in call order. */
export function listKeepers(messages: readonly ChatMessage[]): Keeper[] {
  const pinned = pinnedCallIds(messages);
  if (pinned.size === 0) return [];
  const seen = new Set<string>();
  const keepers: Keeper[] = [];
  for (const call of orderedToolCalls(messages)) {
    if (!pinned.has(call.toolCallId) || seen.has(call.toolCallId)) continue;
    seen.add(call.toolCallId);
    keepers.push({
      toolCallId: call.toolCallId,
      tool: call.tool,
      path: pathFromArgs(call.rawArgs) ?? call.read?.filePath,
    });
  }
  return keepers;
}
