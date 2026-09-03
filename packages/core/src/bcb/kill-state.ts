/**
 * SQLite-backed kill-state for Behavioral Circuit Breakers (BCB).
 *
 * Tracks, per session, how many times in a row the model has ignored a TCB
 * trip for the same tool/rule/target. When the count reaches the configured
 * `ignoredTrips` limit, the daemon escalates to the rule's kill action.
 *
 * Copied from C-Yard `packages/proxy/src/db/bcb-kill-state.ts` (ADR-0101
 * Step 2). Uses `node:sqlite` (Node 22 built-in) — no native dependency.
 *
 * Session identity is `sha256(harness + systemPrompt)` (see `escalate.ts`),
 * so a system-prompt change resets counters — deliberate per-user request.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface BcbKillStateRow {
  readonly sessionId: string;
  readonly tool: string;
  readonly rule: string;
  readonly targetKey: string;
  readonly ignoredTrips: number;
  readonly updatedAt: number;
}

export interface BcbKillStateUpdate {
  readonly sessionId: string;
  readonly tool: string;
  readonly rule: string;
  readonly targetKey: string;
}

export const CREATE_BCB_KILL_STATE_SCHEMA = `
CREATE TABLE IF NOT EXISTS bcb_kill_state (
  session_id    TEXT NOT NULL,
  tool          TEXT NOT NULL,
  rule          TEXT NOT NULL,
  target_key    TEXT NOT NULL,
  ignored_trips INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (session_id, tool, rule, target_key)
);

CREATE INDEX IF NOT EXISTS idx_bcb_kill_state_session ON bcb_kill_state(session_id, updated_at);
`;

/**
 * Open the dedicated BCB kill-state SQLite database.
 *
 * Independent of any memory/Corpus store so kill escalation works even when
 * memory is off.
 */
export function openBcbDb(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  migrateBcbKillState(db);
  return db;
}

/**
 * Ensure the bcb_kill_state table exists. Idempotent.
 */
export function migrateBcbKillState(db: DatabaseSync): void {
  db.exec(CREATE_BCB_KILL_STATE_SCHEMA);
}

/**
 * Read the current ignored-trip count for a session/tool/rule/target.
 * Returns 0 if no row exists.
 */
export function readBcbKillState(
  db: DatabaseSync,
  key: BcbKillStateUpdate,
): number {
  const row = db
    .prepare(
      `SELECT ignored_trips FROM bcb_kill_state
       WHERE session_id = ? AND tool = ? AND rule = ? AND target_key = ?`,
    )
    .get(key.sessionId, key.tool, key.rule, key.targetKey) as
    | { ignored_trips: number }
    | undefined;
  return row?.ignored_trips ?? 0;
}

/**
 * Increment the ignored-trip count and return the new value.
 * If the target changes, callers must reset via resetBcbKillState first.
 */
export function incrementBcbKillState(
  db: DatabaseSync,
  key: BcbKillStateUpdate,
): number {
  const now = Date.now();
  db.prepare(
    `INSERT INTO bcb_kill_state (session_id, tool, rule, target_key, ignored_trips, updated_at)
     VALUES (?, ?, ?, ?, 1, ?)
     ON CONFLICT(session_id, tool, rule, target_key) DO UPDATE SET
       ignored_trips = ignored_trips + 1,
       updated_at = excluded.updated_at`,
  ).run(key.sessionId, key.tool, key.rule, key.targetKey, now);
  const row = db
    .prepare(
      `SELECT ignored_trips FROM bcb_kill_state
       WHERE session_id = ? AND tool = ? AND rule = ? AND target_key = ?`,
    )
    .get(key.sessionId, key.tool, key.rule, key.targetKey) as {
      ignored_trips: number;
    };
  return row.ignored_trips;
}

/**
 * Reset the ignored-trip count for a session/tool/rule (any target).
 * Called when the target changes or when a kill fires.
 */
export function resetBcbKillState(
  db: DatabaseSync,
  sessionId: string,
  tool: string,
  rule: string,
): void {
  db.prepare(
    `DELETE FROM bcb_kill_state WHERE session_id = ? AND tool = ? AND rule = ?`,
  ).run(sessionId, tool, rule);
}
