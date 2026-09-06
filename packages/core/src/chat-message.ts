/**
 * ChatMessage — minimal view of an openai chat message (read defensively).
 *
 * Home of the shared message shape for the MBA framework (ADR-0092): the
 * BCB/TCB rule engine consumes it, and any downstream host can re-import it.
 * The shape lives in the framework so the core package never depends on a
 * consumer-specific implementation (dependency direction: core → mba).
 */

export interface ChatMessage {
  readonly role?: unknown;
  readonly content?: unknown;
  readonly tool_call_id?: unknown;
  readonly tool_calls?: unknown;
  readonly [k: string]: unknown;
}
