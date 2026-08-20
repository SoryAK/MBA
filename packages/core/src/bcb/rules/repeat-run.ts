/**
 * repeatRun rule — detects a trailing run of byte-identical read-file calls.
 *
 * Refactored from the original `breakReadLoop` (commit 2e10186). A weak local
 * model can fixate on a `read_file` call and re-issue the exact same range
 * every turn. result-suppression collapses each duplicate into a passive
 * "shown earlier" marker, but that does not break the loop. Once the trailing
 * run of an identical file+start+end read reaches the threshold, this rule
 * rewrites the LATEST matching tool result into a firm imperative telling the
 * model to stop and continue.
 *
 * Exact-match only (file + startLine + endLine): an overlapping-but-narrower
 * re-read is left alone so a legitimate range narrowing is never tripped. The
 * FIRST read of the range keeps its real content — only the most recent
 * duplicate's result is replaced — so the content the model needs is still
 * present in the conversation above the trip message.
 */

import type { ChatMessage } from "../../chat-message.js";
import { orderedToolCalls } from "../parse-calls.js";
import type {
  ReadTarget,
  ToolCall,
  ToolCircuitBreakerResult,
  ToolRuleSet,
} from "../types.js";

/** A ToolCall known to carry the read bridge field. */
type ReadShapedCall = ToolCall & { read: NonNullable<ToolCall["read"]> };

function isReadShaped(c: ToolCall): c is ReadShapedCall {
  return c.read != null;
}

function sameRange(a: ReadShapedCall, b: ReadShapedCall): boolean {
  return (
    a.read.filePath === b.read.filePath &&
    a.read.start === b.read.start &&
    a.read.end === b.read.end
  );
}

export function formatRepeatRunMessage(target: ReadTarget, runLength: number): string {
  return (
    `[[c-yard: you have already read lines ${target.start}-${target.end} of ` +
    `${target.filePath} — this identical range was requested ${runLength} times in a row. ` +
    `That content is already in this conversation above. Do NOT read this range again; ` +
    `continue the task using what you already have.]]`
  );
}

export function runRepeatRun(
  messages: readonly ChatMessage[],
  calls: readonly ToolCall[],
  ruleSet: ToolRuleSet,
): ToolCircuitBreakerResult {
  if (!ruleSet.repeatRun?.enabled) {
    return { messages, tripped: false, trips: [], clamps: [], hints: [] };
  }
  const threshold = ruleSet.repeatRun.threshold;
  if (!Number.isInteger(threshold) || threshold < 1) {
    return { messages, tripped: false, trips: [], clamps: [], hints: [] };
  }
  const reads = calls.filter(isReadShaped);
  if (reads.length === 0) return { messages, tripped: false, trips: [], clamps: [], hints: [] };

  const last = reads[reads.length - 1]!;
  let runLength = 1;
  for (let i = reads.length - 2; i >= 0; i -= 1) {
    if (sameRange(reads[i]!, last)) runLength += 1;
    else break;
  }

  if (runLength < threshold) return { messages, tripped: false, trips: [], clamps: [], hints: [] };

  const target: ReadTarget = {
    filePath: last.read.filePath,
    start: last.read.start,
    end: last.read.end,
  };
  const message = formatRepeatRunMessage(target, runLength);
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
        rule: "repeatRun",
        toolCallId: last.toolCallId,
        message,
        targetKey: `${last.read.filePath}:${last.read.start}-${last.read.end}`,
        meta: {
          filePath: last.read.filePath,
          start: last.read.start,
          end: last.read.end,
          runLength,
        },
      },
    ],
    clamps: [],
    hints: [],
  };
}

/** Convenience entry point that parses calls itself. */
export function runRepeatRunOnMessages(
  messages: readonly ChatMessage[],
  ruleSet: ToolRuleSet,
): ToolCircuitBreakerResult {
  return runRepeatRun(
    messages,
    orderedToolCalls(messages, new Set(ruleSet.repeatRun?.enabled ? ["read_file"] : [])),
    ruleSet,
  );
}
