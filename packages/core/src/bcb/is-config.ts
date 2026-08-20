/**
 * Lightweight validator for user-supplied Tool Circuit Breaker config files.
 */

import type { KillRule, ToolCircuitBreakerConfig, ToolRuleSet } from "./types.js";

const KILL_ACTIONS = new Set(["return-error", "close-stream", "drop-tools", "block-tool"]);
const TIER_NAMES = new Set(["nudge", "mask", "kill"]);

function isKillRule(value: unknown): value is KillRule {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.enabled !== "boolean") return false;
  if (typeof v.ignoredTrips !== "number" || !Number.isInteger(v.ignoredTrips)) return false;
  if (typeof v.action !== "string" || !KILL_ACTIONS.has(v.action)) return false;
  return true;
}

function isEscalationLadder(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.tiers)) return false;
  for (const tier of v.tiers) {
    if (typeof tier !== "object" || tier === null) return false;
    const t = tier as Record<string, unknown>;
    if (typeof t.tier !== "string" || !TIER_NAMES.has(t.tier)) return false;
    if (typeof t.afterIgnoredTrips !== "number" || !Number.isInteger(t.afterIgnoredTrips)) return false;
    if (t.action !== undefined && (typeof t.action !== "string" || !KILL_ACTIONS.has(t.action))) return false;
    if (t.revivalCalls !== undefined && (typeof t.revivalCalls !== "number" || !Number.isInteger(t.revivalCalls))) return false;
  }
  if (v.counterMode !== undefined && v.counterMode !== "monotonic" && v.counterMode !== "reset-per-tier") return false;
  return true;
}

function isToolRuleSet(value: unknown): value is ToolRuleSet {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.repeatRun !== undefined) {
    if (typeof v.repeatRun !== "object" || v.repeatRun === null) return false;
    const r = v.repeatRun as Record<string, unknown>;
    if (typeof r.enabled !== "boolean") return false;
    if (typeof r.threshold !== "number" || !Number.isInteger(r.threshold)) return false;
    if (r.kill !== undefined && !isKillRule(r.kill)) return false;
    if (r.escalation !== undefined && !isEscalationLadder(r.escalation)) return false;
  }
  if (v.directDuplication !== undefined) {
    if (typeof v.directDuplication !== "object" || v.directDuplication === null) return false;
    const d = v.directDuplication as Record<string, unknown>;
    if (typeof d.enabled !== "boolean") return false;
    if (typeof d.threshold !== "number" || !Number.isInteger(d.threshold)) return false;
    if (d.kill !== undefined && !isKillRule(d.kill)) return false;
    if (d.escalation !== undefined && !isEscalationLadder(d.escalation)) return false;
  }
  if (v.binaryBlock !== undefined) {
    if (typeof v.binaryBlock !== "object" || v.binaryBlock === null) return false;
    const b = v.binaryBlock as Record<string, unknown>;
    if (typeof b.enabled !== "boolean") return false;
    if (b.enabled) {
      if (!Array.isArray(b.extensions) || !b.extensions.every((e) => typeof e === "string")) return false;
    }
    if (b.message !== undefined && typeof b.message !== "string") return false;
    if (b.kill !== undefined && !isKillRule(b.kill)) return false;
    if (b.escalation !== undefined && !isEscalationLadder(b.escalation)) return false;
  }
  if (v.readClamp !== undefined) {
    if (typeof v.readClamp !== "object" || v.readClamp === null) return false;
    const c = v.readClamp as Record<string, unknown>;
    if (typeof c.enabled !== "boolean") return false;
  }
  if (v.eofOverflow !== undefined) {
    if (typeof v.eofOverflow !== "object" || v.eofOverflow === null) return false;
    const e = v.eofOverflow as Record<string, unknown>;
    if (typeof e.enabled !== "boolean") return false;
    if (e.kill !== undefined && !isKillRule(e.kill)) return false;
    if (e.escalation !== undefined && !isEscalationLadder(e.escalation)) return false;
    if (e.hint !== undefined) {
      if (typeof e.hint !== "object" || e.hint === null) return false;
      const h = e.hint as Record<string, unknown>;
      if (typeof h.enabled !== "boolean") return false;
      if (h.message !== undefined && typeof h.message !== "string") return false;
    }
  }
  return true;
}

export function isToolCircuitBreakerConfig(value: unknown): value is ToolCircuitBreakerConfig {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.tools !== "object" || v.tools === null || Array.isArray(v.tools)) return false;
  for (const ruleSet of Object.values(v.tools as Record<string, unknown>)) {
    if (!isToolRuleSet(ruleSet)) return false;
  }
  return true;
}
