/**
 * readClamp rule — clamps read-file calls that request lines beyond the
 * file's actual length and returns the valid content with metadata.
 *
 * A weak local model can mis-estimate file length and request ranges that
 * overshoot EOF. Instead of treating this as a warning/trip, this rule
 * transparently clamps the requested end to the real line count, returns the
 * content that does exist, and prefixes it with a metadata header so the model
 * sees exactly what happened.
 */

import type { ChatMessage } from "../../chat-message.js";
import type {
  ToolCall,
  ToolCircuitBreakerContext,
  ToolCircuitBreakerResult,
  ToolRuleSet,
} from "../types.js";

export const READ_RESULT_METADATA_END = "--- END_READ_RESULT_METADATA ---";

export function formatReadResultHeader(
  filePath: string,
  requestedStart: number,
  requestedEnd: number,
  actualLines: number,
): string {
  const clampedEnd = Math.min(requestedEnd, actualLines);
  return (
    `--- READ_RESULT ---\n` +
    `file: ${filePath}\n` +
    `range: ${requestedStart}-${clampedEnd} of ${actualLines}\n` +
    `requested: ${requestedStart}-${requestedEnd}\n` +
    `${READ_RESULT_METADATA_END}\n\n`
  );
}

/** Convenience header for clamped overshoots (backward-compatible name). */
export function formatReadClampHeader(
  filePath: string,
  requestedStart: number,
  requestedEnd: number,
  actualLines: number,
): string {
  return formatReadResultHeader(filePath, requestedStart, requestedEnd, actualLines);
}

export function runReadClamp(
  messages: readonly ChatMessage[],
  calls: readonly ToolCall[],
  ruleSet: ToolRuleSet,
  ctx: ToolCircuitBreakerContext,
): ToolCircuitBreakerResult {
  if (!ruleSet.readClamp?.enabled) {
    return { messages, tripped: false, trips: [], clamps: [], hints: [] };
  }
  const reads = calls.filter((c): c is ToolCall & { read: NonNullable<ToolCall["read"]> } => c.read != null);
  if (reads.length === 0) return { messages, tripped: false, trips: [], clamps: [], hints: [] };

  let current = messages;
  const clampRecords: {
    toolCallId: string;
    filePath: string;
    requestedStart: number;
    requestedEnd: number;
    actualLines: number;
  }[] = [];

  for (const call of reads) {
    const actualLines = ctx.lineCounts[call.read.filePath];
    if (actualLines === undefined) continue;

    const header = formatReadResultHeader(call.read.filePath, call.read.start, call.read.end, actualLines);
    current = current.map((m): ChatMessage =>
      m.role === "tool" && m.tool_call_id === call.toolCallId
        ? { ...m, content: `${header}${String(m.content ?? "")}` }
        : m,
    );

    if (call.read.end > actualLines) {
      clampRecords.push({
        toolCallId: call.toolCallId,
        filePath: call.read.filePath,
        requestedStart: call.read.start,
        requestedEnd: call.read.end,
        actualLines,
      });
    }
  }

  return {
    messages: current,
    tripped: clampRecords.length > 0,
    trips: [],
    clamps: clampRecords.map((r) => {
      const call = reads.find((c) => c.toolCallId === r.toolCallId)!;
      return { ...r, tool: call.tool, rule: "readClamp" as const };
    }),
    hints: [],
  };
}
