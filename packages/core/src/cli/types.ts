/**
 * CLI mirrors of the service surfaces. Kept here so command modules share
 * one shape and do not re-declare GET /models/config or GET /servers.
 */

import type { ModelDial } from "./interactive.js";

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

export interface BootResult {
  readonly id: string;
  readonly serverType: string;
  readonly modelFile: string;
  readonly port: number;
  readonly pid?: number;
  readonly startedAt: string;
}
