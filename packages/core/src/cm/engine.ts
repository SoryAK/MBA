/**
 * Context Management engine (ADR-0105).
 *
 * One door: callers name a closed cut, the engine splices `messages[]`.
 * Unknown cuts are a no-op. A sequence runner (`runCm`) applies cuts in
 * order with a hard cap. AMPI and TCB both come through here.
 */

import type { ChatMessage } from "../chat-message.js";
import { insertSystem } from "./insert-system.js";
import { pruneDuplicates } from "./cgc/prune-duplicates.js";
import { replaceToolResult } from "./replace-tool-result.js";
import { CM_CUTS, type CmCut, type CmEditResult, type CmEngineResult, type CmIntent } from "./types.js";

const KNOWN = new Set<string>(CM_CUTS);

export interface RunCmOptions {
  /** Hard cap on cuts applied. Defaults to the number of intents. */
  readonly maxCuts?: number;
}

export function applyCm(
  messages: readonly ChatMessage[],
  intent: CmIntent,
): CmEditResult {
  if (!KNOWN.has(intent.cut)) {
    return { messages, cut: intent.cut, progress: 0 };
  }
  switch (intent.cut) {
    case "prune-duplicates":
      return pruneDuplicates({ messages, trip: intent.trip });
    case "replace-tool-result":
      return replaceToolResult({
        messages,
        toolCallId: intent.toolCallId,
        content: intent.content,
      });
    case "insert-system":
      return insertSystem({
        messages,
        at: intent.at,
        contents: intent.contents,
      });
  }
}

export function runCm(
  messages: readonly ChatMessage[],
  intents: readonly CmIntent[],
  opts: RunCmOptions = {},
): CmEngineResult {
  const maxCuts = opts.maxCuts ?? intents.length;
  let current = messages;
  const applied: CmCut[] = [];
  for (const intent of intents) {
    if (applied.length >= maxCuts) break;
    const out = applyCm(current, intent);
    current = out.messages;
    applied.push(out.cut);
  }
  return { messages: current, applied, cutsUsed: applied.length };
}
