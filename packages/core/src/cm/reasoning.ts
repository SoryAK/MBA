/**
 * Whether compact / sanitize-reasoning should run (ADR-0105).
 *
 * Two facts, both required when known:
 *   - the weights actually emit a thinking trace (`modelReasons`)
 *   - the server dial is on (`reasoningBudget` > 0 and `reasoningPreserve`)
 *
 * Unknown (no gate) → try; compact no-ops if the transcript has no span.
 * Either fact false → do not compact.
 */

export interface ReasoningGate {
  /** Adapter/dossier: this model emits a thinking trace. */
  readonly modelReasons?: boolean;
  /** --reasoning-budget. 0 means the server will not think. */
  readonly reasoningBudget?: number;
  /** --reasoning-preserve. false means the trace is not kept in history. */
  readonly reasoningPreserve?: boolean;
}

/** `true` / `false` when we know; `undefined` when nobody said. */
export function reasoningIsOn(gate?: ReasoningGate): boolean | undefined {
  if (!gate) return undefined;
  if (gate.modelReasons === false) return false;
  if (gate.reasoningBudget === 0) return false;
  if (gate.reasoningPreserve === false) return false;
  if (gate.modelReasons === true) return true;
  if (gate.reasoningBudget !== undefined && gate.reasoningBudget > 0) return true;
  if (gate.reasoningPreserve === true) return true;
  return undefined;
}

/** Compact only when the gate is not an explicit off. */
export function shouldCompactReasoning(gate?: ReasoningGate): boolean {
  return reasoningIsOn(gate) !== false;
}
