/**
 * binaryBlock rule — blocks reads whose target path ends with a configured
 * binary extension (e.g. `.db`, `.png`), rewriting the tool result into a
 * message that points the model at the right CLI instead.
 *
 * Stateless: inspects the last call's raw `filePath`/`path` arg, so it fires
 * even when the read carries no line range.
 */

import type { ChatMessage } from "../../chat-message.js";
import { applyCm } from "../../cm/index.js";
import type { ToolCall, ToolCircuitBreakerResult, ToolRuleSet } from "../types.js";

export function formatBinaryBlockMessage(filePath: string): string {
  return (
    `[[mba: ${filePath} is a binary file. read_file cannot parse it. ` +
    `Use the appropriate CLI (e.g. sqlite3 for .db/.sqlite files) instead.]]`
  );
}

export function runBinaryBlock(
  messages: readonly ChatMessage[],
  calls: readonly ToolCall[],
  ruleSet: ToolRuleSet,
): ToolCircuitBreakerResult {
  const rule = ruleSet.binaryBlock;
  if (!rule?.enabled) {
    return { messages, tripped: false, trips: [], clamps: [], hints: [] };
  }
  if (calls.length === 0) return { messages, tripped: false, trips: [], clamps: [], hints: [] };

  const last = calls[calls.length - 1]!;
  const raw = last.rawArgs.filePath ?? last.rawArgs.path;
  if (typeof raw !== "string") return { messages, tripped: false, trips: [], clamps: [], hints: [] };

  const lower = raw.toLowerCase();
  const matched = rule.extensions.some((ext) => lower.endsWith(ext.toLowerCase()));
  if (!matched) return { messages, tripped: false, trips: [], clamps: [], hints: [] };

  const message = (rule.message ?? formatBinaryBlockMessage(raw)).replaceAll("{filePath}", raw);
  const edited = applyCm(messages, {
    cut: "replace-tool-result",
    toolCallId: last.toolCallId,
    content: message,
  });

  return {
    messages: edited.messages,
    tripped: true,
    trips: [
      {
        tool: last.tool,
        rule: "binaryBlock",
        toolCallId: last.toolCallId,
        message,
        targetKey: `binaryBlock:${raw}`,
        meta: { filePath: raw },
      },
    ],
    clamps: [],
    hints: [],
  };
}
