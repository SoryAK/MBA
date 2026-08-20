/**
 * Persistent server state tracking via .cyard-store/server-state.json
 *
 * The "sticky note" that tracks which model/flags are currently running.
 * Used in Step 6 by the bouncer to detect "flags changed → reboot needed".
 *
 * Responsibilities:
 *  - Load the last-known-good boot state from disk
 *  - Save the new boot state after successful boot
 *  - Compare requested flags vs persisted flags to detect mismatch
 *  - Resilient to missing/corrupt files (treated as "no prior state")
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Persisted server state. Written to .cyard-store/server-state.json after boot.
 */
export interface PersistedServerState {
  /** Full path to the .gguf model file */
  modelPath: string;
  /** CLI flag array (from buildLlamaServerFlags) */
  flags: string[];
  /** PID of the running llama-server process */
  pid: number;
  /** TCP port the server is listening on */
  port: number;
  /** Unix timestamp (ms) when the server booted */
  bootedAt: number;
}

/**
 * Load the last-known server state from .cyard-store/server-state.json
 *
 * Returns null if file doesn't exist or is invalid JSON.
 * Never throws; failures are silently treated as "no prior state".
 */
export function loadServerState(storeDir: string): PersistedServerState | null {
  const stateFile = `${storeDir}/server-state.json`;
  try {
    const content = readFileSync(stateFile, "utf-8");
    const parsed = JSON.parse(content);

    // Minimal validation: check required fields exist
    if (
      typeof parsed.modelPath === "string" &&
      Array.isArray(parsed.flags) &&
      typeof parsed.pid === "number" &&
      typeof parsed.port === "number" &&
      typeof parsed.bootedAt === "number"
    ) {
      return parsed as PersistedServerState;
    }
  } catch {
    // File missing, JSON corrupt, or validation failed → treat as no prior state
  }
  return null;
}

/**
 * Save the new server state to .cyard-store/server-state.json
 *
 * Creates the directory if it doesn't exist.
 * Writes atomically (buffered string, single writeFileSync call).
 *
 * @throws {Error} if directory creation or write fails
 */
export function saveServerState(storeDir: string, state: PersistedServerState): void {
  mkdirSync(storeDir, { recursive: true });
  const stateFile = `${storeDir}/server-state.json`;
  const content = JSON.stringify(state, null, 2);
  writeFileSync(stateFile, content, "utf-8");
}

/**
 * Check if the requested flags match the persisted state.
 *
 * @returns true if flags match (server is in sync), false if mismatch or no prior state
 */
export function isFlagsMismatch(
  requestedFlags: string[],
  persistedState: PersistedServerState | null,
): boolean {
  if (persistedState === null) return true; // No prior state = always out of sync

  // Flags are mismatch if lengths differ or any element differs
  if (requestedFlags.length !== persistedState.flags.length) return true;

  for (let i = 0; i < requestedFlags.length; i++) {
    if (requestedFlags[i] !== persistedState.flags[i]) return true;
  }

  return false; // Flags match
}

/**
 * Convenience: Load state, check for model/flag mismatch.
 *
 * @returns true if reboot needed (model changed or flags changed), false otherwise
 */
export function isRebootNeeded(
  storeDir: string,
  requestedModel: string,
  requestedFlags: string[],
): boolean {
  const prior = loadServerState(storeDir);

  // No prior state → always boot
  if (prior === null) return true;

  // Model changed → reboot
  if (prior.modelPath !== requestedModel) return true;

  // Flags changed → reboot
  if (isFlagsMismatch(requestedFlags, prior)) return true;

  return false;
}
