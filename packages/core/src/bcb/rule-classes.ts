/**
 * Rule-class registry (ADR-0086 / ADR-0087) — named bundles of rule
 * definitions with a shared default escalation ladder. A binding can apply a
 * whole class in one line (`rule_class`) instead of enumerating each rule.
 *
 * Built-in classes live here (code); user classes are layered on top by the
 * proxy loader. Pure: expansion + merge only.
 */

import type { EscalationLadder } from "./types.js";

/** A named bundle: member rule ids → default params, plus an optional ladder. */
export interface RuleClassDef {
  readonly members: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  /** Default escalation applied to every member (rules that ignore it are unaffected). */
  readonly escalation?: EscalationLadder;
}

export type RuleClassRegistry = Readonly<Record<string, RuleClassDef>>;

/** Default binary extensions blocked by the readSafety class. */
export const DEFAULT_BINARY_EXTENSIONS: readonly string[] = [
  ".db", ".sqlite", ".sqlite3", ".bin", ".exe", ".dll", ".so", ".dylib", ".o", ".a", ".lib",
  ".zip", ".tar", ".gz", ".rar", ".7z",
  ".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".svgz",
  ".mp3", ".mp4", ".mov", ".avi", ".mkv",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
];

/** Built-in rule classes. User classes may override these by name. */
export const BUILTIN_RULE_CLASSES: RuleClassRegistry = {
  readSafety: {
    members: {
      readClamp: {},
      eofOverflow: { kill: { enabled: true, ignoredTrips: 2, action: "return-error" } },
      binaryBlock: {
        extensions: DEFAULT_BINARY_EXTENSIONS,
        kill: { enabled: true, ignoredTrips: 3, action: "return-error" },
      },
    },
  },
  loopBreaker: {
    members: {
      repeatRun: { threshold: 4 },
      directDuplication: { threshold: 3 },
    },
    escalation: {
      tiers: [
        { tier: "nudge", afterIgnoredTrips: 0 },
        { tier: "mask", afterIgnoredTrips: 2, revivalCalls: 3 },
        { tier: "kill", afterIgnoredTrips: 4, action: "return-error" },
      ],
      counterMode: "monotonic",
    },
  },
  readLoop: {
    // read-only loop breaker: repeatRun alone (no arg-hash directDuplication,
    // which would double-guard reads and overwrite the read-specific message).
    members: {
      repeatRun: { threshold: 4 },
    },
    escalation: {
      tiers: [
        { tier: "nudge", afterIgnoredTrips: 0 },
        { tier: "mask", afterIgnoredTrips: 2, revivalCalls: 3 },
        { tier: "kill", afterIgnoredTrips: 4, action: "return-error" },
      ],
      counterMode: "monotonic",
    },
  },
};

/**
 * Expand a class into a `{ ruleId: ruleBody }` map ready to merge into a tool's
 * rule set. Disabled bindings produce `{ enabled: false }` members; enabled
 * ones layer class params ← class escalation ← per-member overrides.
 */
export function expandRuleClass(
  classDef: RuleClassDef,
  enabled: boolean,
  overrides?: Readonly<Record<string, Record<string, unknown>>>,
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [ruleId, params] of Object.entries(classDef.members)) {
    if (!enabled) {
      out[ruleId] = { enabled: false };
      continue;
    }
    out[ruleId] = {
      enabled: true,
      ...params,
      ...(classDef.escalation ? { escalation: classDef.escalation } : {}),
      ...(overrides?.[ruleId] ?? {}),
    };
  }
  return out;
}

/**
 * Merge registries left-to-right; a later class of the same name overrides the
 * earlier one. Returns the overridden names so the caller can surface an alert.
 */
export function mergeRuleClassRegistries(
  ...registries: readonly RuleClassRegistry[]
): { registry: RuleClassRegistry; collisions: readonly string[] } {
  const out: Record<string, RuleClassDef> = {};
  const collisions: string[] = [];
  for (const reg of registries) {
    for (const [name, def] of Object.entries(reg)) {
      if (name in out) collisions.push(name);
      out[name] = def;
    }
  }
  return { registry: out, collisions };
}

export function isRuleClassDef(value: unknown): value is RuleClassDef {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.members !== "object" || v.members === null || Array.isArray(v.members)) return false;
  for (const params of Object.values(v.members as Record<string, unknown>)) {
    if (typeof params !== "object" || params === null || Array.isArray(params)) return false;
  }
  return true;
}

export function isRuleClassRegistry(value: unknown): value is RuleClassRegistry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every(isRuleClassDef);
}
