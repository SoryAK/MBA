/**
 * Context Management plane (ADR-0105).
 *
 * The engine (`applyCm` / `runCm`) is the only door that splices `messages[]`.
 */

export { applyCm, runCm } from "./engine.js";
export type { RunCmOptions } from "./engine.js";
export { pruneDuplicates, CGC_MARKER_PREFIX, trailingDuplicateRun } from "./cgc/prune-duplicates.js";
export { replace, replaceToolResult } from "./replace.js";
export { insert, insertSystem } from "./insert.js";
export { setMark } from "./set-mark.js";
export { sweep } from "./sweep.js";
export { compact } from "./compact.js";
export type {
  CmCut,
  CmCgcCut,
  CmGuardCut,
  CmIntent,
  CmEditContext,
  CmEditResult,
  CmEngineResult,
  CmMark,
  CmReplaceTarget,
  CmInsertRole,
  CmSweepWhat,
} from "./types.js";
export {
  CM_CUTS,
  CM_CGC_CUTS,
  CM_GUARD_CUTS,
  CM_MARKS,
  MBA_META_KEY,
  readMark,
  withMark,
} from "./types.js";
