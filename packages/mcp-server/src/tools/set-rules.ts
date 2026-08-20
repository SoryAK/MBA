/**
 * mba_set_rules — update the global TCB rules (and optionally the rule-class
 * registry) via the service.
 *
 * Thin wrapper over POST /set_rules. The service validates the shapes and
 * owns the atomic write + version bump; this tool never touches the files.
 */
import {
  fetchSetRules,
  type MbaServiceClientOptions,
  type MbaSetRulesResult,
} from "../service-client.js";

export interface SetRulesInput {
  /** Full ToolCircuitBreakerConfig object (validated by the service). */
  readonly tcb: unknown;
  /** Optional full RuleClassRegistry object (validated by the service). */
  readonly ruleClasses?: unknown;
}

export type SetRulesOutput =
  | (MbaSetRulesResult & { readonly error?: undefined })
  | { readonly error: string };

export function createSetRulesHandler(
  clientOpts: MbaServiceClientOptions = {},
): (input: SetRulesInput) => Promise<SetRulesOutput> {
  return async (input) => {
    const res = await fetchSetRules(clientOpts, {
      tcb: input.tcb,
      ruleClasses: input.ruleClasses,
    });
    if (!res.ok) return { error: res.error };
    return res.data;
  };
}
