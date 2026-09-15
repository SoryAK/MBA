/**
 * CLI mirrors of the service surfaces. Kept here so command modules share
 * one shape and do not re-declare GET /models/config or GET /servers.
 */

import type { ModelDial } from "./interactive.js";

export interface ModelShelfCard {
  readonly path: string;
  readonly source: "model" | "family";
  readonly empty: boolean;
  readonly text: string;
}

export interface ModelConfig {
  readonly modelId: string;
  readonly files: {
    readonly yamlPath: string;
    readonly serverSetupPath: string;
    readonly envSetupPaths: string[];
    readonly blockCount?: number;
    readonly maxContextLength?: number;
    readonly modelFile?: string;
  };
  readonly fields: ModelDial[];
  readonly notes?: ModelShelfCard;
  readonly instructions?: ModelShelfCard;
}

export interface SetResult {
  readonly file: string;
  readonly field: string;
  readonly before: unknown;
  readonly after: unknown;
  readonly restartRequired: boolean;
  readonly modelFile?: string;
  readonly modelLoaded: boolean;
}

export interface WatchRow {
  readonly id: string;
  readonly label: string;
  readonly tool: string;
  readonly rule: string;
  readonly mode: "inherit" | "off" | "on";
  readonly effective: boolean;
}

export interface ModelWatches {
  readonly modelId: string | null;
  readonly tcbPath?: string;
  readonly watches: readonly WatchRow[];
}

/** One row of GET /models/history (`events`). */
export interface ModelHistoryEvent {
  readonly ts: number;
  readonly kind: string;
  readonly tool: string;
  readonly toolCallId: string;
  readonly rule: string;
  readonly harness: string;
  readonly targetKey: string;
  readonly tier: string;
}

export interface ModelHistory {
  readonly modelId: string;
  readonly events: readonly ModelHistoryEvent[];
}

/** One row of GET /servers (ADR-0097 Phase 2). */
export interface ServerEntry {
  readonly id: string;
  readonly serverType: string;
  readonly modelFile: string;
  readonly port: number;
  readonly pid?: number;
  readonly startedAt: string;
  readonly healthy: boolean;
  readonly resolved: boolean;
  readonly duplicate?: boolean;
}

/** One pairing row from GET /status (`pairing.sessions`). */
export interface PairingSession {
  readonly modelId: string;
  readonly harness: string;
  readonly ide?: string;
  readonly projectRoot: string;
  readonly card?: boolean;
  readonly envelope?: string;
}

export interface BootResult {
  readonly id: string;
  readonly serverType: string;
  readonly modelFile: string;
  readonly port: number;
  readonly pid?: number;
  readonly startedAt: string;
}
