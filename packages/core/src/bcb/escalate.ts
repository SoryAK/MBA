/**
 * TCB escalation evaluation (ADR-0101 Step 2).
 *
 * Copied from C-Yard `packages/proxy/src/server.ts` (`evaluateBcbEscalation`),
 * adapted for the daemon:
 *
 * - Session key is `sha256(harness + systemPrompt)` (was
 *   `sha256(systemPrompt)`). C-Yard's key collided for every no-prompt
 *   request (all shared `sha256("")`), which was masked in practice because
 *   its only client always sends a system prompt. Keying on the harness too
 *   isolates no-prompt requests per client.
 * - Degrades to "no escalation" (returns undefined) when the harness is
 *   `unknown` AND the system prompt is empty — there is no stable identity
 *   to key the counter on, so counting would be meaningless.
 *
 * The kill-state store (`kill-state.ts`) and the ladder engine
 * (`escalation.ts`) are the same modules the C-Yard proxy used.
 */

import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { deriveLadderFromKill, evaluateEscalation } from "./escalation.js";
import type { Harness } from "./fingerprint.js";
import {
  incrementBcbKillState,
  readBcbKillState,
  resetBcbKillState,
  type BcbKillStateUpdate,
} from "./kill-state.js";
import type { ToolCircuitBreakerConfig, ToolCircuitBreakerKill, ToolCircuitBreakerTrip } from "./types.js";

/** Intervention resolved for a TCB trip via the escalation ladder (ADR-0086 Part 3). */
export interface TcbEscalationResult {
  readonly tier: "nudge" | "mask" | "kill";
  readonly ignoredTrips: number;
  /** Present only when tier === "kill". */
  readonly kill?: ToolCircuitBreakerKill;
}

/** Stable session identity: `sha256(harness + systemPrompt)`. */
export function bcbSessionKey(harness: Harness, systemPrompt: string): string {
  return createHash("sha256").update(harness + systemPrompt).digest("hex");
}

/**
 * Evaluate the escalation ladder for a TCB trip (Nudge → Mask → Kill).
 *
 * Returns undefined when there is no kill-state db, or when the session
 * identity is too weak to count (unknown harness + empty prompt).
 */
export function evaluateBcbEscalation(
  trip: ToolCircuitBreakerTrip,
  config: ToolCircuitBreakerConfig,
  systemPrompt: string,
  harness: Harness,
  db: DatabaseSync | undefined,
): TcbEscalationResult | undefined {
  if (!db) return undefined;
  if (harness === "unknown" && systemPrompt === "") return undefined;

  const ruleSet = config.tools[trip.tool];
  const rule = ruleSet?.[trip.rule];
  const explicitLadder = rule && "escalation" in rule ? rule.escalation : undefined;
  const legacyKill = rule && "kill" in rule ? rule.kill : undefined;
  const ladder = explicitLadder ?? deriveLadderFromKill(legacyKill);

  const sessionId = bcbSessionKey(harness, systemPrompt);
  const key: BcbKillStateUpdate = {
    sessionId,
    tool: trip.tool,
    rule: trip.rule,
    targetKey: trip.targetKey,
  };
  // tripCount = 1 on first warning, 2 on first ignored repeat, etc.
  const previous = readBcbKillState(db, key);
  const tripCount = previous + 1;
  incrementBcbKillState(db, key);

  const decision = evaluateEscalation({ ladder, tripCount });
  if (!decision) return undefined;
  const ignoredTrips = tripCount - 1;

  if (decision.tier === "kill") {
    resetBcbKillState(db, sessionId, trip.tool, trip.rule);
    return {
      tier: "kill",
      ignoredTrips,
      kill: {
        tool: trip.tool,
        rule: trip.rule,
        action: decision.action ?? "return-error",
        ignoredTrips,
        targetKey: trip.targetKey,
        reason: `ignored ${ignoredTrips} trip(s) for ${trip.rule} on ${trip.tool}`,
      },
    };
  }

  return { tier: decision.tier, ignoredTrips };
}
