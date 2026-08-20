/**
 * ChatMessage — minimal view of an openai chat message (read defensively).
 *
 * Home of the shared message shape for the MBA framework (ADR-0092): the
 * BCB/TCB rule engine consumes it, and the original project core re-imports it from here.
 * The framework must not depend on @the original project/core, so the shape lives in the
 * framework and core imports it (dependency direction: core → mba).
 */

export interface ChatMessage {
  readonly role?: unknown;
  readonly content?: unknown;
  readonly tool_call_id?: unknown;
  readonly tool_calls?: unknown;
  readonly [k: string]: unknown;
}
