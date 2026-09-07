/**
 * Context Management engine (ADR-0105).
 *
 * One door: callers name a closed cut, the engine splices `messages[]`.
 */

import type { ChatMessage } from "../chat-message.js";
import { compact } from "./compact.js";
import { insert } from "./insert.js";
import { replace } from "./replace.js";
import { setMark } from "./set-mark.js";
import { sweep } from "./sweep.js";
import { CM_CUTS, type CmCut, type CmEditResult, type CmEngineResult, type CmIntent } from "./types.js";

const KNOWN = new Set<string>(CM_CUTS);

export interface RunCmOptions {
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
    case "replace":
      return replace({
        messages,
        target: intent.target,
        content: intent.content,
        toolCallId: intent.toolCallId,
        at: intent.at,
      });
    case "insert":
      return insert({
        messages,
        role: intent.role,
        at: intent.at,
        contents: intent.contents,
      });
    case "set-mark":
      return setMark({
        messages,
        tag: intent.tag,
        toolCallId: intent.toolCallId,
      });
    case "sweep":
      return sweep({
        messages,
        what: intent.what,
        trip: intent.trip,
      });
    case "compact":
      return compact({ messages, target: intent.target });
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
