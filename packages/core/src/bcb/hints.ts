/**
 * Proactive BCB hints — inject guidance into the conversation before the
 * model repeats a known bad pattern. Hints are system messages inserted by
 * CM (`insert-system`); tool results are not rewritten here.
 */

import type { ChatMessage } from "../chat-message.js";
import { applyCm } from "../cm/index.js";
import type { EofOverflowHintRule, ToolCall, ToolCircuitBreakerContext } from "./types.js";

const DEFAULT_EOF_HINT =
  "[[mba: {filePath} has {actualLines} line(s). Do not call read_file beyond line {actualLines}; use the range you already have or ask a follow-up question.]]";

export function buildEofOverflowHint(
  filePath: string,
  requestedEnd: number,
  actualLines: number,
  hintRule: EofOverflowHintRule | undefined,
): string | undefined {
  if (!hintRule?.enabled) return undefined;
  const template = hintRule.message ?? DEFAULT_EOF_HINT;
  return template
    .replaceAll("{filePath}", filePath)
    .replaceAll("{requestedEnd}", String(requestedEnd))
    .replaceAll("{actualLines}", String(actualLines));
}

/**
 * Insert proactive EOF-overflow hints for any read calls whose requested end
 * exceeds the actual file length. The hint is placed as a system message
 * immediately before the latest assistant tool-call message so it is in-scope
 * for the model's next reasoning step.
 */
export interface EofOverflowHintResult {
  readonly messages: readonly ChatMessage[];
  readonly hints: ReadonlyArray<{
    readonly filePath: string;
    readonly actualLines: number;
    readonly requestedEnd: number;
    readonly message: string;
  }>;
}

export function insertEofOverflowHints(
  messages: readonly ChatMessage[],
  calls: readonly ToolCall[],
  ctx: ToolCircuitBreakerContext,
  hintRule: EofOverflowHintRule | undefined,
): EofOverflowHintResult {
  if (!hintRule?.enabled || calls.length === 0) {
    return { messages, hints: [] };
  }

  const hints = new Map<string, string>();
  const hintMeta: { filePath: string; actualLines: number; requestedEnd: number; message: string }[] = [];
  for (const call of calls) {
    if (!call.read) continue;
    const actualLines = ctx.lineCounts[call.read.filePath];
    if (actualLines === undefined || call.read.end <= actualLines) continue;
    if (hints.has(call.read.filePath)) continue;
    const hint = buildEofOverflowHint(call.read.filePath, call.read.end, actualLines, hintRule);
    if (hint) {
      hints.set(call.read.filePath, hint);
      hintMeta.push({ filePath: call.read.filePath, actualLines, requestedEnd: call.read.end, message: hint });
    }
  }
  if (hints.size === 0) {
    return { messages, hints: [] };
  }

  const lastCall = calls[calls.length - 1]!;
  const lastCallIndex = messages.findIndex(
    (m) => m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.some(
      (tc) => (tc as { id?: string }).id === lastCall.toolCallId,
    ),
  );
  const insertAt = lastCallIndex >= 0 ? lastCallIndex : messages.length;
  const edited = applyCm(messages, {
    cut: "insert-system",
    at: insertAt,
    contents: Array.from(hints.values()),
  });

  return {
    messages: edited.messages,
    hints: hintMeta,
  };
}
