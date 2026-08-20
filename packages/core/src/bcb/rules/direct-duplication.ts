/**
 * directDuplication rule — detects a trailing run of identical calls
 * (same tool + same argHash) on ANY tool, and trips at threshold.
 *
 * Stateless, transcript-derived (like repeatRun): the run is counted from the
 * message history, so it self-revokes — the moment the model makes any other
 * call the trailing run breaks and the rule stops tripping. This is the
 * detector the mask tier (ADR-0086 Part 3) uses to guard non-read tools such
 * as `mba_file_metadata`; it replaces the stateful in-memory sinkOnRepeat.
 */

import type { ChatMessage } from "../../chat-message.js";
import type { ToolCall, ToolCircuitBreakerResult, ToolRuleSet } from "../types.js";

export function formatDirectDuplicationMessage(tool: string, runLength: number): string {
  return (
    `[[c-yard: you have called ${tool} ${runLength} times in a row with identical ` +
    `arguments. The result will not change. Do NOT call it again with the same ` +
    `arguments; continue the task using what you already have.]]`
  );
}

export function runDirectDuplication(
  messages: readonly ChatMessage[],
  calls: readonly ToolCall[],
  ruleSet: ToolRuleSet,
): ToolCircuitBreakerResult {
  const rule = ruleSet.directDuplication;
  if (!rule?.enabled) {
    return { messages, tripped: false, trips: [], clamps: [], hints: [] };
  }
  const threshold = rule.threshold;
  if (!Number.isInteger(threshold) || threshold < 1) {
    return { messages, tripped: false, trips: [], clamps: [], hints: [] };
  }
  if (calls.length === 0) return { messages, tripped: false, trips: [], clamps: [], hints: [] };

  const last = calls[calls.length - 1]!;
  let runLength = 1;
  for (let i = calls.length - 2; i >= 0; i -= 1) {
    if (calls[i]!.tool === last.tool && calls[i]!.argHash === last.argHash) runLength += 1;
    else break;
  }

  if (runLength < threshold) return { messages, tripped: false, trips: [], clamps: [], hints: [] };

  const message = formatDirectDuplicationMessage(last.tool, runLength);
  const out = messages.map((m): ChatMessage =>
    m.role === "tool" && m.tool_call_id === last.toolCallId
      ? { ...m, content: message }
      : m,
  );

  return {
    messages: out,
    tripped: true,
    trips: [
      {
        tool: last.tool,
        rule: "directDuplication",
        toolCallId: last.toolCallId,
        message,
        targetKey: `${last.tool}:${last.argHash}`,
        meta: { argHash: last.argHash, runLength },
      },
    ],
    clamps: [],
    hints: [],
  };
}
