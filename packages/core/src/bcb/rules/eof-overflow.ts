/**
 * eofOverflow rule — detects read-file calls that request lines beyond the
 * file's actual length.
 *
 * A weak local model can mis-estimate file length and keep asking for the next
 * page even though there is nothing left. The tool result for such a read is
 * empty or short, which the model may interpret as a transient failure rather
 * than EOF. This rule appends an explicit end-of-file marker to the latest
 * out-of-bounds read so the model knows the real length and stops asking.
 */

import type { ChatMessage } from "../../chat-message.js";
import type {
  ToolCall,
  ToolCircuitBreakerContext,
  ToolCircuitBreakerResult,
  ToolRuleSet,
} from "../types.js";

export function formatEofOverflowMessage(
  filePath: string,
  requestedEnd: number,
  actualLines: number,
): string {
  return (
    `[[c-yard: requested range ends at line ${requestedEnd}, but ${filePath} only ` +
    `has ${actualLines} line${actualLines === 1 ? "" : "s"}. ` +
    `There is no more content to read; continue using what you already have.]]`
  );
}

export function runEofOverflow(
  messages: readonly ChatMessage[],
  calls: readonly ToolCall[],
  _ruleSet: ToolRuleSet,
  ctx: ToolCircuitBreakerContext,
): ToolCircuitBreakerResult {
  const reads = calls.filter((c): c is ToolCall & { read: NonNullable<ToolCall["read"]> } => c.read != null);
  if (reads.length === 0) return { messages, tripped: false, trips: [], clamps: [], hints: [] };

  const last = reads[reads.length - 1]!;
  const actualLines = ctx.lineCounts[last.read.filePath];
  if (actualLines === undefined || last.read.end <= actualLines) {
    return { messages, tripped: false, trips: [], clamps: [], hints: [] };
  }

  const message = formatEofOverflowMessage(last.read.filePath, last.read.end, actualLines);
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
        rule: "eofOverflow",
        toolCallId: last.toolCallId,
        message,
        targetKey: `${last.read.filePath}:requested=${last.read.end},actual=${actualLines}`,
        meta: {
          filePath: last.read.filePath,
          requestedEnd: last.read.end,
          actualLines,
        },
      },
    ],
    clamps: [],
    hints: [],
  };
}
