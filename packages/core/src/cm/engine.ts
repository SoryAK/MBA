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
import {
  CM_CUTS,
  classifyCmEffect,
  cmCacheAction,
  mergeCmEffects,
  type CmCut,
  type CmEditResult,
  type CmEffect,
  type CmEngineResult,
  type CmIntent,
} from "./types.js";

const KNOWN = new Set<string>(CM_CUTS);

export interface RunCmOptions {
  readonly maxCuts?: number;
}

export function applyCm(
  messages: readonly ChatMessage[],
  intent: CmIntent,
): CmEditResult {
  if (!KNOWN.has(intent.cut)) {
    return { messages, cut: intent.cut, progress: 0, effect: "none" };
  }
  let out: CmEditResult;
  switch (intent.cut) {
    case "replace":
      out = replace({
        messages,
        target: intent.target,
        content: intent.content,
        toolCallId: intent.toolCallId,
        at: intent.at,
      });
      break;
    case "insert":
      out = insert({
        messages,
        role: intent.role,
        at: intent.at,
        contents: intent.contents,
      });
      break;
    case "set-mark":
      out = setMark({
        messages,
        tag: intent.tag,
        toolCallId: intent.toolCallId,
      });
      break;
    case "sweep":
      out = sweep({
        messages,
        what: intent.what,
        trip: intent.trip,
      });
      break;
    case "compact":
      out = compact({ messages, target: intent.target });
      break;
  }
  return {
    ...out,
    effect: classifyCmEffect(out.cut, messages, out.messages),
  };
}

export function runCm(
  messages: readonly ChatMessage[],
  intents: readonly CmIntent[],
  opts: RunCmOptions = {},
): CmEngineResult {
  const maxCuts = opts.maxCuts ?? intents.length;
  let current = messages;
  const applied: CmCut[] = [];
  let effect: CmEffect = "none";
  let changed = 0;
  for (const intent of intents) {
    if (applied.length >= maxCuts) break;
    const out = applyCm(current, intent);
    current = out.messages;
    applied.push(out.cut);
    effect = mergeCmEffects(effect, out.effect ?? "none");
    if (out.effect && out.effect !== "none") changed += 1;
  }
  return {
    messages: current,
    applied,
    cutsUsed: applied.length,
    effect,
    changed,
    cacheAction: cmCacheAction(effect),
  };
}
