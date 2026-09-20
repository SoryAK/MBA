/**
 * HTTP JSON the daemon returns. CLI imports these. MCP must not import
 * `@mba-ai/core` (ADR-0092); keep `packages/mcp-server` copies in lockstep.
 *
 * Bump `SERVICE_CONTRACT_VERSION` when a field is added, renamed, or dropped.
 */

export const SERVICE_CONTRACT_VERSION = 1 as const;

export type {
  StatusCatalogModel,
  StatusPairing,
  StatusPairingSession,
  StatusRegistry,
  StatusServerRow,
  StatusSnapshot,
} from "./status-snapshot.js";
export type {
  ModelConfig,
  ModelDial,
  ModelDialFile,
  ModelShelfCard,
} from "./model-config.js";
export type { ModelHistoryEvent } from "./model-history.js";
export type { EnsureModelResult } from "./model-switch.js";
export type { ModelWatches, WatchRow } from "./model-watches.js";
export type { UpstreamEntry } from "./upstream-registry.js";

import type { ModelDialFile } from "./model-config.js";
import type { ModelHistoryEvent } from "./model-history.js";
import type { StatusCatalogModel, StatusPairingSession, StatusServerRow } from "./status-snapshot.js";
import type { UpstreamEntry } from "./upstream-registry.js";

/** POST /models/config success body. */
export interface SetModelConfigResponse {
  readonly file: ModelDialFile;
  readonly field: string;
  readonly before: unknown;
  readonly after: unknown;
  readonly restartRequired: boolean;
  readonly modelFile?: string;
  readonly modelLoaded: boolean;
}

/** GET /models/history body. */
export interface ModelHistory {
  readonly modelId: string;
  readonly events: readonly ModelHistoryEvent[];
}

/** GET /models body. */
export interface ModelsListResponse {
  readonly models: readonly StatusCatalogModel[];
}

/** GET /servers body. */
export interface ServersListResponse {
  readonly servers: readonly StatusServerRow[];
}

/** One GET /servers row — same shape as the status snapshot. */
export type ServerEntry = StatusServerRow;

/** One pairing row from GET /status. */
export type PairingSession = StatusPairingSession;

/** POST /servers/boot JSON body (201). SSE `done.result` is the same. */
export type BootResult = UpstreamEntry;

/** CLI name for POST /models/config success. */
export type SetResult = SetModelConfigResponse;
