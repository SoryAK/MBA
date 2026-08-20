/**
 * Tool Circuit Breaker (TCB) orchestrator.
 *
 * TCB is a Behavioral Circuit Breaker (BCB) subsystem that detects model-side
 * doom-loops on deterministic read-style tools and rewrites the latest
 * matching tool result into a firm, model-legible stop message.
 *
 * Rules are configured per-tool in a JSON file that is reloaded every request.
 * The default config ships with `read_file` rules for the loop patterns we
 * have observed live:
 *   - repeatRun: same byte-identical range requested repeatedly
 *   - readClamp: requested range exceeds the file's actual line count; clamp
 *     to the real length and return metadata instead of erroring. Runs first
 *     so clamped calls are skipped by the other rules.
 *   - repeatRun: same byte-identical range requested repeatedly
 *   - eofOverflow: requested range exceeds the file's actual line count and
 *     was not handled by readClamp; rewrite to a stop message
 *
 * Pure (ADR 0008 Mode A). The proxy owns the messages[] mutation edge, the
 * live config, and the line-count lookup; this module owns the policy.
 */

import type { ChatMessage } from "../chat-message.js";
import { defaultToolCircuitBreakerConfig } from "./default-config.js";
import { orderedToolCalls } from "./parse-calls.js";
import { insertEofOverflowHints } from "./hints.js";
import { runEofOverflow } from "./rules/eof-overflow.js";
import { runReadClamp } from "./rules/read-clamp.js";
import { runRepeatRun } from "./rules/repeat-run.js";
import { runDirectDuplication } from "./rules/direct-duplication.js";
import { runBinaryBlock } from "./rules/binary-block.js";
import type {
  ReadClampRecord,
  ToolCall,
  ToolCircuitBreakerConfig,
  ToolCircuitBreakerContext,
  ToolCircuitBreakerResult,
  ToolCircuitBreakerTrip,
} from "./types.js";

/** Most recent tool call that carries the read bridge field, if any. */
function lastReadShaped(calls: readonly ToolCall[]): ToolCall | undefined {
  for (let i = calls.length - 1; i >= 0; i -= 1) {
    if (calls[i]!.read) return calls[i];
  }
  return undefined;
}

/**
 * Apply all enabled TCB rules to the message array.
 *
 * Rules are evaluated in declaration order. Only the LATEST matching tool
 * result is rewritten for any single rule, preserving earlier real content so
 * the model can still reference it. If multiple rules trip on the same latest
 * call, each rule rewrites the same result in sequence (the result text grows
 * to include all stop messages). readClamp runs first; any clamped calls are
 * removed from the call list seen by repeatRun and eofOverflow.
 *
 * All rules consume the universal ToolCall list (ADR-0086). Read rules
 * (readClamp, repeatRun, eofOverflow) read the `.read` bridge field and ignore
 * non-read calls; directDuplication keys off `tool:argHash` and fires on ANY
 * tool — including no-line-range tools like `mba_file_metadata`.
 */
export function applyToolCircuitBreakers(
  messages: readonly ChatMessage[],
  config: ToolCircuitBreakerConfig | null | undefined,
  ctx: ToolCircuitBreakerContext,
): ToolCircuitBreakerResult {
  const effective = config ?? defaultToolCircuitBreakerConfig();
  const configuredTools = new Set(Object.keys(effective.tools));
  const toolCalls = orderedToolCalls(messages, configuredTools);
  if (toolCalls.length === 0) {
    return { messages, tripped: false, trips: [], clamps: [], hints: [] };
  }

  // Proactive hints: tell the model the real file length BEFORE it reads past
  // EOF, using the same read calls and line-count context the breaker uses.
  const hintResult = insertEofOverflowHints(
    messages,
    toolCalls,
    ctx,
    effective.tools.read_file?.eofOverflow?.hint,
  );

  let current: readonly ChatMessage[] = hintResult.messages;
  let clampedIds = new Set<string>();
  const trips: ToolCircuitBreakerTrip[] = [];
  const clamps: ReadClampRecord[] = [];

  // readClamp — universal ToolCall list (ADR-0086), read-shaped internally.
  // Runs first; clamped reads are removed from the calls the other rules see.
  {
    const lastRead = lastReadShaped(toolCalls);
    const ruleSet = lastRead ? effective.tools[lastRead.tool] : undefined;
    if (ruleSet) {
      const result = runReadClamp(current, toolCalls, ruleSet, ctx);
      if (result.messages !== current) current = result.messages;
      if (result.clamps.length > 0) {
        clamps.push(...result.clamps);
        clampedIds = new Set(result.clamps.map((c) => c.toolCallId));
      }
    }
  }

  // repeatRun — universal ToolCall list (ADR-0086), read-shaped internally.
  // Runs on the clamp-filtered calls so clamped reads don't count toward a run.
  {
    const repeatCalls = toolCalls.filter((c) => !clampedIds.has(c.toolCallId));
    const lastRead = lastReadShaped(repeatCalls);
    const ruleSet = lastRead ? effective.tools[lastRead.tool] : undefined;
    if (ruleSet) {
      const result = runRepeatRun(current, repeatCalls, ruleSet);
      if (result.messages !== current) current = result.messages;
      if (result.tripped) trips.push(...result.trips);
    }
  }

  // directDuplication — universal (ADR-0086): trailing run of identical
  // (tool+argHash) calls on ANY tool. Stateless; pairs with the mask tier.
  {
    const lastTool = toolCalls[toolCalls.length - 1];
    const ruleSet = lastTool ? effective.tools[lastTool.tool] : undefined;
    if (ruleSet) {
      const result = runDirectDuplication(current, toolCalls, ruleSet);
      if (result.messages !== current) current = result.messages;
      if (result.tripped) trips.push(...result.trips);
    }
  }

  // binaryBlock — stateless: blocks reads of binary files by extension.
  {
    const lastTool = toolCalls[toolCalls.length - 1];
    const ruleSet = lastTool ? effective.tools[lastTool.tool] : undefined;
    if (ruleSet) {
      const result = runBinaryBlock(current, toolCalls, ruleSet);
      if (result.messages !== current) current = result.messages;
      if (result.tripped) trips.push(...result.trips);
    }
  }

  // eofOverflow — universal ToolCall list (ADR-0086), read-shaped internally.
  // Runs on the clamp-filtered calls so a clamped read does not also trip the
  // EOF marker.
  {
    const eofCalls = toolCalls.filter((c) => !clampedIds.has(c.toolCallId));
    const lastRead = lastReadShaped(eofCalls);
    const ruleSet = lastRead ? effective.tools[lastRead.tool] : undefined;
    if (ruleSet) {
      const result = runEofOverflow(current, eofCalls, ruleSet, ctx);
      if (result.messages !== current) current = result.messages;
      if (result.tripped) trips.push(...result.trips);
    }
  }

  return {
    messages: current,
    tripped: trips.length > 0 || clamps.length > 0,
    trips,
    clamps,
    hints: hintResult.hints,
  };
}

export { defaultToolCircuitBreakerConfig } from "./default-config.js";
export { isToolCircuitBreakerConfig } from "./is-config.js";
export type {
  ToolCircuitBreakerConfig,
  ToolCircuitBreakerContext,
  ToolCircuitBreakerResult,
  ToolCircuitBreakerTrip,
  ToolCircuitBreakerKill,
  KillAction,
  KillRule,
  EscalationTierName,
  EscalationTier,
  EscalationLadder,
  EscalationDecision,
} from "./types.js";
export { deriveLadderFromKill, evaluateEscalation } from "./escalation.js";
export type { EscalationInput } from "./escalation.js";
export {
  BUILTIN_RULE_CLASSES,
  DEFAULT_BINARY_EXTENSIONS,
  expandRuleClass,
  mergeRuleClassRegistries,
  isRuleClassDef,
  isRuleClassRegistry,
} from "./rule-classes.js";
export type { RuleClassDef, RuleClassRegistry } from "./rule-classes.js";
