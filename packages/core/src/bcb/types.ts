/**
 * Behavioral Circuit Breakers (BCB) — types for tool circuit breakers (TCB).
 *
 * TCB detects model-side doom-loops on deterministic tools (e.g. re-reading the
 * same file range or asking past EOF) and rewrites the latest matching tool
 * result into a firm, model-legible stop message.
 *
 * Pure (ADR 0008 Mode A). Wire shapes are read defensively; the proxy owns the
 * messages[] mutation edge and the live config, this module owns the policy.
 */

import type { ChatMessage } from "../chat-message.js";

/**
 * Universal tool call (ADR-0086) — captures ANY tool, not just read-shaped
 * ones. Generic rules key off `argHash`; sequence rules off `turnIndex` + `tool`;
 * read rules read the optional `read` bridge field.
 */
export interface ToolCall {
  readonly toolCallId: string;
  readonly tool: string;
  /** Parsed args, verbatim. Empty object when args are absent or malformed. */
  readonly rawArgs: Record<string, unknown>;
  /** Canonical (key-sorted) hash of the hashed arg subset. */
  readonly argHash: string;
  /** Model-turn position (assistant tool-call turns only), for sequence rules. */
  readonly turnIndex: number;
  /** True when args were present as a string but could not be parsed as JSON. */
  readonly malformed?: boolean;
  /** Populated only for read-shaped calls (filePath/path + integer line range). */
  readonly read?: {
    readonly filePath: string;
    readonly start: number;
    readonly end: number;
  };
}

/** Options for {@link orderedToolCalls}. */
export interface OrderedToolCallsOptions {
  /**
   * Per-tool allowlist of arg keys to include in `argHash`. When a tool has an
   * entry, only those keys contribute to the hash (noise fields like a reworded
   * `explanation` are ignored). Tools absent from the map hash all args.
   */
  readonly hashKeys?: Readonly<Record<string, readonly string[]>>;
}

/** Identity of a read range a loop is fixating on. */
export interface ReadTarget {
  readonly filePath: string;
  readonly start: number;
  readonly end: number;
}

/** Per-tool rule set. */
export interface ToolRuleSet {
  /** Detect a trailing run of byte-identical reads and trip at threshold. */
  readonly repeatRun?: RepeatRunRule;
  /** Clamp read requests that exceed the file's actual length and return metadata. */
  readonly readClamp?: ReadClampRule;
  /** Detect reads whose requested range exceeds the file's actual length. */
  readonly eofOverflow?: EofOverflowRule;
  /** Detect a trailing run of identical (tool+argHash) calls on ANY tool. */
  readonly directDuplication?: DirectDuplicationRule;
  /** Block reads of binary files by extension. */
  readonly binaryBlock?: BinaryBlockRule;
}

/** Trailing-run duplicate-call detector, tool-agnostic (ADR-0086 Part 3). */
export interface DirectDuplicationRule {
  readonly enabled: boolean;
  /** Consecutive identical (tool+argHash) calls that trip the breaker. */
  readonly threshold: number;
  /** Optional escalation when warnings are ignored (legacy nudge→kill). */
  readonly kill?: KillRule;
  /** Optional tiered escalation ladder (ADR-0086 Part 3); overrides `kill` when set. */
  readonly escalation?: EscalationLadder;
}

/** Block reads whose target path ends with a configured binary extension. */
export interface BinaryBlockRule {
  readonly enabled: boolean;
  /** File extensions (with leading dot) that cannot be read. */
  readonly extensions: readonly string[];
  /** Stop message; `{filePath}` is substituted. */
  readonly message?: string;
  /** Optional escalation when warnings are ignored (legacy nudge→kill). */
  readonly kill?: KillRule;
  /** Optional tiered escalation ladder (ADR-0086 Part 3); overrides `kill` when set. */
  readonly escalation?: EscalationLadder;
}

export type KillAction =
  | "return-error"
  | "close-stream"
  | "drop-tools"
  | "block-tool";

export interface KillRule {
  readonly enabled: boolean;
  /** Ignored trips before the kill action fires. */
  readonly ignoredTrips: number;
  /** What the proxy does when the ignored-trip limit is reached. */
  readonly action: KillAction;
}

/** One rung of the escalation ladder (ADR-0086 Part 3). */
export type EscalationTierName = "nudge" | "mask" | "kill";

export interface EscalationTier {
  readonly tier: EscalationTierName;
  /**
   * Ignored trips (trips beyond the first) required to reach this tier.
   * `nudge` is typically 0 (fires on the first trip).
   */
  readonly afterIgnoredTrips: number;
  /** kill tier only: the hard action to take. */
  readonly action?: KillAction;
  /** mask tier only: tool calls (of any kind) before the masked tool is revived. */
  readonly revivalCalls?: number;
}

export interface EscalationLadder {
  readonly tiers: readonly EscalationTier[];
  /**
   * How the ignored-trip counter is interpreted:
   * - `monotonic` (default): one running total; the highest tier whose
   *   threshold is met wins.
   * - `reset-per-tier`: the counter resets each time a tier fires, so every
   *   tier requires its own N ignored trips before the next.
   */
  readonly counterMode?: "monotonic" | "reset-per-tier";
}

/** Result of evaluating the escalation ladder for one trip. */
export interface EscalationDecision {
  readonly tier: EscalationTierName;
  /** Index of the tier in the ladder. */
  readonly tierIndex: number;
  /** kill tier only. */
  readonly action?: KillAction;
  /** mask tier only. */
  readonly revivalCalls?: number;
  /** reset-per-tier only: true when this decision advanced a tier and the counter should reset. */
  readonly resetCounter: boolean;
}

export interface RepeatRunRule {
  readonly enabled: boolean;
  /** Consecutive identical reads that trip the breaker. */
  readonly threshold: number;
  /** Optional escalation when warnings are ignored (legacy nudge→kill). */
  readonly kill?: KillRule;
  /** Optional tiered escalation ladder (ADR-0086 Part 3); overrides `kill` when set. */
  readonly escalation?: EscalationLadder;
}

export interface ReadClampRule {
  readonly enabled: boolean;
}

export interface EofOverflowRule {
  readonly enabled: boolean;
  /** Optional escalation when warnings are ignored. */
  readonly kill?: KillRule;
  /** Optional tiered escalation ladder (ADR-0086 Part 3); overrides `kill` when set. */
  readonly escalation?: EscalationLadder;
  /**
   * Optional proactive hint inserted into the conversation before the model
   * repeats an out-of-bounds read. Tells the model the actual line count so
   * it can pick a valid range on the next turn.
   */
  readonly hint?: EofOverflowHintRule;
}

export interface EofOverflowHintRule {
  readonly enabled: boolean;
  /** Template string. Supported placeholders: {filePath}, {actualLines}, {requestedEnd}. */
  readonly message?: string;
}

/** Top-level TCB config: one rule set per tool name. */
export interface ToolCircuitBreakerConfig {
  readonly tools: Readonly<Record<string, ToolRuleSet | undefined>>;
}

/** Context supplied by the caller on each request. */
export interface ToolCircuitBreakerContext {
  /** Actual line counts for files referenced by read calls (path → count). */
  readonly lineCounts: Readonly<Record<string, number | undefined>>;
}

/** Description of one triggered breaker. */
export interface ToolCircuitBreakerTrip {
  readonly tool: string;
  readonly rule: "repeatRun" | "eofOverflow" | "directDuplication" | "binaryBlock";
  /** The `tool_call_id` whose result was rewritten. */
  readonly toolCallId: string;
  /** Human-readable stop message now in the tool result. */
  readonly message: string;
  /** Rule-specific metadata for telemetry. */
  readonly meta: Readonly<Record<string, number | string | boolean>>;
  /**
   * Stable key for kill-state tracking. Two trips with the same key are
   * considered the same ignored warning; different keys reset the counter.
   */
  readonly targetKey: string;
}

/** Description of one clamped read (readClamp rule). */
export interface ReadClampRecord {
  readonly tool: string;
  readonly rule: "readClamp";
  readonly toolCallId: string;
  readonly filePath: string;
  readonly requestedStart: number;
  readonly requestedEnd: number;
  readonly actualLines: number;
}

export interface ToolCircuitBreakerResult {
  readonly messages: readonly ChatMessage[];
  /** True when at least one rule tripped and rewrote a tool result. */
  readonly tripped: boolean;
  readonly trips: readonly ToolCircuitBreakerTrip[];
  /** Reads that were clamped to the file's actual line count. */
  readonly clamps: readonly ReadClampRecord[];
  /** Proactive hints that were inserted before any trip. */
  readonly hints: ReadonlyArray<{
    readonly filePath: string;
    readonly actualLines: number;
    readonly requestedEnd: number;
    readonly message: string;
  }>;
}

/** Kill escalation emitted by the proxy after ignored trips cross the limit. */
export interface ToolCircuitBreakerKill {
  readonly tool: string;
  readonly rule: "repeatRun" | "eofOverflow" | "directDuplication" | "binaryBlock";
  readonly action: KillAction;
  readonly ignoredTrips: number;
  readonly targetKey: string;
  readonly reason: string;
}
