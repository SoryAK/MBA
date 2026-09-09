/**
 * Per-model append-only event log (tools + breaker trips).
 *
 * Separate SQLite file from `bcb-kill-state.db`. Kill-state is a live fuse
 * that resets on kill; this ledger keeps the facts for later analysis and
 * suggestions. Uses `node:sqlite` (Node 22 built-in) — no native dependency.
 *
 * Does not splice `messages[]`. A write failure must never break serving.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ChatMessage } from "../chat-message.js";
import { orderedToolCalls } from "../bcb/parse-calls.js";
import { fingerprint } from "../bcb/fingerprint.js";
import type { ToolCircuitBreakerTrip } from "../bcb/types.js";

export const CREATE_MODEL_HISTORY_SCHEMA = `
CREATE TABLE IF NOT EXISTS model_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           INTEGER NOT NULL,
  model_id     TEXT NOT NULL,
  kind         TEXT NOT NULL,
  tool         TEXT NOT NULL,
  tool_call_id TEXT NOT NULL DEFAULT '',
  rule         TEXT NOT NULL DEFAULT '',
  harness      TEXT NOT NULL DEFAULT '',
  target_key   TEXT NOT NULL DEFAULT '',
  tier         TEXT NOT NULL DEFAULT ''
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_model_events_dedup
  ON model_events(model_id, kind, tool_call_id, rule, tier);

CREATE INDEX IF NOT EXISTS idx_model_events_model_ts
  ON model_events(model_id, ts);
`;

export interface ModelHistoryRow {
  readonly id: number;
  readonly ts: number;
  readonly modelId: string;
  readonly kind: string;
  readonly tool: string;
  readonly toolCallId: string;
  readonly rule: string;
  readonly harness: string;
  readonly targetKey: string;
  readonly tier: string;
}

export interface RecordModelHistoryInput {
  readonly modelId: string;
  readonly harness: string;
  readonly tools: readonly { readonly tool: string; readonly toolCallId: string }[];
  readonly trips: readonly {
    readonly tool: string;
    readonly toolCallId: string;
    readonly rule: string;
    readonly targetKey: string;
  }[];
  readonly lastTier?: string;
  readonly now?: number;
}

/** Open the dedicated model-history database. Independent of kill-state. */
export function openModelHistoryDb(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  migrateModelHistory(db);
  return db;
}

export function migrateModelHistory(db: DatabaseSync): void {
  db.exec(CREATE_MODEL_HISTORY_SCHEMA);
}

/** Tool calls on the latest assistant turn that carried tools. */
export function lastTurnToolCalls(messages: readonly ChatMessage[]): ReturnType<typeof orderedToolCalls> {
  const all = orderedToolCalls(messages);
  if (all.length === 0) return [];
  const last = all[all.length - 1]!.turnIndex;
  return all.filter((c) => c.turnIndex === last);
}

/**
 * Append last-turn tools and any trips. Duplicate
 * (model, kind, tool_call_id, rule, tier) rows are ignored so a client retry
 * does not double-count; a later kill on the same call still records.
 */
export function recordModelHistory(db: DatabaseSync, input: RecordModelHistoryInput): void {
  if (!input.modelId) return;
  if (input.tools.length === 0 && input.trips.length === 0) return;
  const ts = input.now ?? Date.now();
  const tier = input.lastTier ?? "";
  const insert = db.prepare(
    `INSERT OR IGNORE INTO model_events
      (ts, model_id, kind, tool, tool_call_id, rule, harness, target_key, tier)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const tool of input.tools) {
    insert.run(
      ts,
      input.modelId,
      "tool",
      tool.tool,
      tool.toolCallId,
      "",
      input.harness,
      "",
      "",
    );
  }
  for (const trip of input.trips) {
    insert.run(
      ts,
      input.modelId,
      "trip",
      trip.tool,
      trip.toolCallId,
      trip.rule,
      input.harness,
      trip.targetKey,
      tier,
    );
  }
}

export function listModelEvents(db: DatabaseSync, modelId?: string): ModelHistoryRow[] {
  const rows = (
    modelId
      ? db.prepare(`SELECT * FROM model_events WHERE model_id = ? ORDER BY id`).all(modelId)
      : db.prepare(`SELECT * FROM model_events ORDER BY id`).all()
  ) as Array<{
    id: number;
    ts: number;
    model_id: string;
    kind: string;
    tool: string;
    tool_call_id: string;
    rule: string;
    harness: string;
    target_key: string;
    tier: string;
  }>;
  return rows.map((r) => ({
    id: r.id,
    ts: r.ts,
    modelId: r.model_id,
    kind: r.kind,
    tool: r.tool,
    toolCallId: r.tool_call_id,
    rule: r.rule,
    harness: r.harness,
    targetKey: r.target_key,
    tier: r.tier,
  }));
}

/**
 * Parse a chat-completions body and append history. Never throws.
 */
export function appendHistoryFromChatRequest(
  db: DatabaseSync | undefined,
  input: {
    readonly modelId: string | undefined;
    readonly body: string;
    readonly ua: string;
    readonly trips?: readonly ToolCircuitBreakerTrip[];
    readonly harness?: string;
    readonly lastTier?: string;
  },
): void {
  if (!db || !input.modelId) return;
  try {
    const parsed = JSON.parse(input.body) as {
      messages?: unknown;
      tools?: unknown;
    };
    const messages = Array.isArray(parsed.messages) ? (parsed.messages as ChatMessage[]) : [];
    const tools = lastTurnToolCalls(messages).map((c) => ({
      tool: c.tool,
      toolCallId: c.toolCallId,
    }));
    const trips = input.trips ?? [];
    if (tools.length === 0 && trips.length === 0) return;
    let harness = input.harness;
    if (!harness) {
      const systemPrompt = extractSystemPrompt(messages);
      const hasTools = Array.isArray(parsed.tools) && parsed.tools.length > 0;
      harness = fingerprint(systemPrompt, input.ua, hasTools).harness;
    }
    recordModelHistory(db, {
      modelId: input.modelId,
      harness,
      tools,
      trips,
      lastTier: input.lastTier,
    });
  } catch {
    // History must never break serving.
  }
}

function extractSystemPrompt(messages: readonly ChatMessage[]): string {
  for (const m of messages) {
    if (m.role === "system" && typeof m.content === "string") return m.content;
  }
  return "";
}
