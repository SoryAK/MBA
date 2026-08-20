/**
 * @mba-ai/core — Model Behavioral Adapter framework (ADR-0092).
 *
 * Standalone framework for local-model management: the MBA adapter
 * resolution stack (adapters, rule classes, resolver) plus the BCB/TCB
 * behavioral circuit-breaker engine. The proxy is a thin consumer; this
 * package owns the policy.
 *
 * Barrel surface:
 *   - `./mba/index.js` — adapter loading, scoring, merge, resolution
 *   - `./bcb/tool-circuit-breaker.js` — TCB engine (rules, escalation,
 *     rule-class registry, config guards)
 *   - `./chat-message.js` — the minimal ChatMessage view shared by the
 *     engine and its consumers
 *   - `./service/config-store.js` — global rule-state store (files are truth)
 *   - `./service/server.js` — the global MBA service (hono app + listener)
 */
export * from "./mba/index.js";
export * from "./bcb/tool-circuit-breaker.js";
export type { ChatMessage } from "./chat-message.js";
export * from "./service/config-store.js";
export * from "./service/server.js";
