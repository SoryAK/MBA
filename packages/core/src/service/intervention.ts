/**
 * TCB intervention orchestrator (ADR-0101 Step 2).
 *
 * `intervene()` is the "guard at the door": it inspects every model request
 * that passes through the daemon, applies the Tool Circuit Breakers, and
 * either returns the (possibly mutated) body to forward, or a kill response
 * that short-circuits the request.
 *
 * Pure capability block (ADR-0051 idiom): explicit params in, a structured
 * decision out. It owns the "how" (detect + escalate + build the response);
 * the proxy route owns the "why/when" (status codes, forwarding).
 *
 * Pipeline (mirrors C-Yard `server.ts` `runToolPipeline` TCB block):
 *   parse body → fingerprint client → build line-count context →
 *   applyToolCircuitBreakers → (if trips) evaluateBcbEscalation →
 *   (if kill) buildBcbKillResponse.
 */

import type { DatabaseSync } from "node:sqlite";
import type { ChatMessage } from "../chat-message.js";
import { buildBcbContext } from "../bcb/context.js";
import { evaluateBcbEscalation } from "../bcb/escalate.js";
import { fingerprint } from "../bcb/fingerprint.js";
import { buildBcbKillResponse } from "../bcb/kill-response.js";
import { applyToolCircuitBreakers } from "../bcb/tool-circuit-breaker.js";
import type { ToolCircuitBreakerConfig } from "../bcb/types.js";

/**
 * Outcome of an intervention.
 *
 * - `forward`: the request proceeds to the upstream; `body` is the (possibly
 *   mutated) request body to send.
 * - `kill`: the request is short-circuited; `response` is the proxy response
 *   to return to the client.
 */
export type InterventionResult =
  | { readonly action: "forward"; readonly body: string }
  | { readonly action: "kill"; readonly response: Response };

/**
 * Inspect a model request and apply the Tool Circuit Breakers.
 *
 * @param body   Raw request body (JSON string) as read from the client.
 * @param ua     The client's User-Agent header (used for harness fingerprint).
 * @param config The active TCB config (from `readGlobalConfig(paths).tcb`).
 * @param db     The BCB kill-state database, or undefined to disable
 *               escalation (trips still rewrite tool results, but no kill).
 */
export function intervene(
  body: string,
  ua: string,
  config: ToolCircuitBreakerConfig,
  db: DatabaseSync | undefined,
): InterventionResult {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body) as Record<string, unknown>;
  } catch {
    // Not JSON we can inspect — forward verbatim.
    return { action: "forward", body };
  }

  const messages = parsed.messages;
  if (!Array.isArray(messages)) {
    // No messages array — nothing to inspect.
    return { action: "forward", body };
  }

  const chatMessages = messages as ChatMessage[];
  const systemPrompt = extractSystemPrompt(chatMessages);
  const hasTools = Array.isArray(parsed.tools) && (parsed.tools as unknown[]).length > 0;

  const { harness } = fingerprint(systemPrompt, ua, hasTools);
  const { ctx } = buildBcbContext(chatMessages, config);
  const broken = applyToolCircuitBreakers(chatMessages, config, ctx);

  // If any rule rewrote a tool result, the messages array is a new reference;
  // re-serialize so the upstream sees the mutation. Otherwise keep the
  // original body byte-for-byte.
  let outBody = body;
  if (broken.messages !== chatMessages) {
    parsed.messages = broken.messages;
    outBody = JSON.stringify(parsed);
  }

  if (broken.tripped && broken.trips.length > 0) {
    const lastTrip = broken.trips[broken.trips.length - 1]!;
    const escalation = evaluateBcbEscalation(lastTrip, config, systemPrompt, harness, db);
    if (escalation) {
      if (escalation.tier === "mask") {
        // Mask: hide the offending tool from the request so the model cannot
        // call it again this turn.
        maskTool(parsed, lastTrip.tool);
        outBody = JSON.stringify(parsed);
      } else if (escalation.tier === "kill" && escalation.kill) {
        const response = buildBcbKillResponse(escalation.kill, parsed);
        if (response) {
          return { action: "kill", response };
        }
        // drop-tools / block-tool mutate `parsed` in place; re-serialize and
        // continue forwarding.
        outBody = JSON.stringify(parsed);
      }
    }
  }

  return { action: "forward", body: outBody };
}

/** First system message content as a string ("" when absent or non-string). */
function extractSystemPrompt(messages: readonly ChatMessage[]): string {
  for (const m of messages) {
    if (m.role === "system" && typeof m.content === "string") {
      return m.content;
    }
  }
  return "";
}

/** Remove a tool from the request's `tools[]` (mask tier). */
function maskTool(parsed: Record<string, unknown>, tool: string): void {
  const tools = parsed.tools;
  if (Array.isArray(tools)) {
    parsed.tools = tools.filter((t) => {
      if (!t || typeof t !== "object") return true;
      const fn = (t as { function?: unknown }).function as { name?: unknown } | undefined;
      return fn?.name !== tool;
    });
  }
}
