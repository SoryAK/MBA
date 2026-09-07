/**
 * Context Management plane (ADR-0105).
 *
 * The engine (`applyCm` / `runCm`) is the only door that splices `messages[]`.
 * Cut functions below are implementation; callers should use the engine.
 */

export { applyCm, runCm } from "./engine.js";
export type { RunCmOptions } from "./engine.js";
export { pruneDuplicates, CGC_MARKER_PREFIX, trailingDuplicateRun } from "./cgc/prune-duplicates.js";
export { replaceToolResult } from "./replace-tool-result.js";
export { insertSystem } from "./insert-system.js";
export type {
  CmCut,
  CmCgcCut,
  CmGuardCut,
  CmIntent,
  CmEditContext,
  CmEditResult,
  CmEngineResult,
  CmInsertSystemContext,
  CmReplaceToolResultContext,
} from "./types.js";
export { CM_CUTS, CM_CGC_CUTS, CM_GUARD_CUTS } from "./types.js";
