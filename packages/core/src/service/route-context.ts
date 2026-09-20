/**
 * Shared handle for the HTTP route groups. `server.ts` is the composition
 * root; each group receives this and registers its doors on the same app.
 */

import type { DatabaseSync } from "node:sqlite";
import type { ToolCircuitBreakerConfig } from "../bcb/types.js";
import type { LifecycleSeams } from "../mba/index.js";
import type { MachineOverlayMode, MbaStorePaths } from "./config-store.js";
import type { MachineInfo } from "./machine-info.js";
import type { SwitchExecutor } from "./model-switch.js";

export interface MbaServiceAppOptions {
  readonly paths?: MbaStorePaths;
  /** Adapter tree root (default: OS-aware model store, see service/paths.ts). */
  readonly adapterDir?: string;
  /** Upstream llama-server base URL (e.g. `http://127.0.0.1:8080`). */
  readonly upstreamUrl?: string;
  /** Proxy health-probe cache TTL in ms (default 5000). */
  readonly healthTtlMs?: number;
  /** Arm model switching (ADR-0093: OFF by default). */
  readonly switchEnabled?: boolean;
  /** Switch executor — injectable for tests; default boots in-daemon via the server plane. */
  readonly switchExecutor?: SwitchExecutor;
  /** Injectable fetch for the upstream probe (tests). */
  readonly fetch?: typeof fetch;
  /**
   * Shared lifecycle seams (spawn/fetch/kill) and the daemon's one G1
   * ProcessSupervisor. Boot, stop, and shutdown must use the same supervisor.
   */
  readonly lifecycleSeams?: LifecycleSeams;
  /**
   * TCB config getter (ADR-0101 Step 2). Injectable for tests. When omitted,
   * the daemon reads the global TCB config on every request (so a
   * `/set_rules` mutation is picked up without a restart).
   */
  readonly tcbConfig?: () => ToolCircuitBreakerConfig;
  /**
   * Kill-state DB handle (ADR-0101 Step 2). Injectable for tests. When
   * omitted, the daemon opens `bcb-kill-state.db` under its baseDir.
   */
  readonly bcbDb?: DatabaseSync;
  /**
   * Per-model history DB. Injectable for tests. When omitted, the daemon
   * opens `mba-model-history.db` under its baseDir.
   */
  readonly historyDb?: DatabaseSync;
  /** Detected/persisted machine profile for recipe clamping (ADR-0103). */
  readonly machineInfo?: MachineInfo;
  /**
   * Machine-overlay enforcement mode getter. When omitted, the daemon reads
   * the global config on every boot so a `/config/machine-overlay` mutation
   * is picked up without a restart.
   */
  readonly machineOverlay?: () => MachineOverlayMode;
}

export interface ServiceRouteContext {
  readonly paths: MbaStorePaths;
  readonly opts: MbaServiceAppOptions;
  readonly startedAt: number;
  readonly machineOverlay: () => MachineOverlayMode;
  readonly historyDb: DatabaseSync;
}

export function registryCorruptJson(error: string): { code: "registry-corrupt"; error: string } {
  return {
    code: "registry-corrupt",
    error: `upstream registry is corrupt — ${error}`,
  };
}
