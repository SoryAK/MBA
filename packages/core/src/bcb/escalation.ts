/**
 * Escalation engine (ADR-0086 Part 3) — decides which intervention tier
 * (Nudge → Mask → Kill) applies to a repeatedly-ignored trip.
 *
 * Pure (ADR 0008 Mode A). Detection lives in the rules; this module owns the
 * ladder logic only. The proxy holds the session-scoped trip counter and
 * applies the returned tier.
 */

import type { EscalationDecision, EscalationLadder, KillRule } from "./types.js";

/** Inputs to {@link evaluateEscalation}. */
export interface EscalationInput {
  readonly ladder: EscalationLadder;
  /**
   * Trips for this target key including the current one. For `monotonic` this
   * is the running total; for `reset-per-tier` it is trips since the counter
   * last reset.
   */
  readonly tripCount: number;
  /** reset-per-tier only: highest tier index already fired (default 0). */
  readonly reachedTier?: number;
}

/**
 * Back-compat: derive a ladder from a legacy per-rule `kill` config.
 * Enabled → `nudge` then `kill`; absent/disabled → `nudge` only.
 */
export function deriveLadderFromKill(kill: KillRule | undefined): EscalationLadder {
  const tiers: EscalationLadder["tiers"] = kill?.enabled
    ? [
        { tier: "nudge", afterIgnoredTrips: 0 },
        { tier: "kill", afterIgnoredTrips: kill.ignoredTrips, action: kill.action },
      ]
    : [{ tier: "nudge", afterIgnoredTrips: 0 }];
  return { tiers, counterMode: "monotonic" };
}

function decide(
  ladder: EscalationLadder,
  tierIndex: number,
  resetCounter: boolean,
): EscalationDecision {
  const t = ladder.tiers[tierIndex]!;
  return {
    tier: t.tier,
    tierIndex,
    ...(t.action !== undefined ? { action: t.action } : {}),
    ...(t.revivalCalls !== undefined ? { revivalCalls: t.revivalCalls } : {}),
    resetCounter,
  };
}

/**
 * Evaluate the ladder for one trip. Returns the tier to apply now, or null when
 * no tier qualifies (empty ladder).
 */
export function evaluateEscalation(input: EscalationInput): EscalationDecision | null {
  const { ladder, tripCount } = input;
  if (ladder.tiers.length === 0) return null;
  const ignoredTrips = tripCount - 1;

  if (ladder.counterMode === "reset-per-tier") {
    const reached = input.reachedTier ?? 0;
    const next = reached + 1;
    const nextTier = ladder.tiers[next];
    if (nextTier && ignoredTrips >= nextTier.afterIgnoredTrips) {
      return decide(ladder, next, true);
    }
    return decide(ladder, Math.min(reached, ladder.tiers.length - 1), false);
  }

  // monotonic: highest tier whose threshold is met by the running total.
  let best = -1;
  for (let i = 0; i < ladder.tiers.length; i += 1) {
    if (ladder.tiers[i]!.afterIgnoredTrips <= ignoredTrips) best = i;
  }
  if (best < 0) return null;
  return decide(ladder, best, false);
}
