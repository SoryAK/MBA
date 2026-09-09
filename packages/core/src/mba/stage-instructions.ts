/**
 * Copy a store `instructions.md` into the project as a harness envelope.
 *
 * The harness injects that file with its existing pipe. MBA does not splice
 * `messages[]`. Empty cards are not staged. `notes.md` is never a source.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import {
  envelopeRelativePath,
  isMbaStaged,
  wrapStagedCard,
  type EnvelopeBinding,
} from "./envelope.js";

export type StageAction = "wrote" | "removed" | "skipped";

export type StageSkipReason = "empty" | "no-card";

export interface StageInstructionsInput {
  /** Project folder the harness already knows. */
  readonly projectRoot: string;
  /** Absolute path of the winning store card. Omitted / missing → skip. */
  readonly sourcePath?: string;
  /** Client harness (filename key). */
  readonly harness: string;
  /** IDE when known; reserved for env matching. */
  readonly ide?: string;
  /** Operator-defined envelopes (name + path), looked up after the shipped set. */
  readonly envelopes?: readonly EnvelopeBinding[];
  /**
   * When set, the source must sit under this directory (the adapter tree).
   * Stops a binding of `../../outside.md` from being copied into the project.
   */
  readonly sourceRoot?: string;
}

export type StageInstructionsResult =
  | {
      readonly ok: true;
      readonly action: StageAction;
      readonly reason?: StageSkipReason;
      readonly envelope: string;
      readonly dest: string;
      readonly source?: string;
    }
  | {
      readonly ok: false;
      readonly code: "unknown-harness" | "invalid-project" | "conflict" | "source-escape";
      readonly error: string;
    };

export function isPathInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}

function atomicWriteText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, path);
}

function parentIsFile(dest: string, projectRoot: string): string | undefined {
  let dir = dirname(dest);
  while (dir !== projectRoot && isPathInside(projectRoot, dir)) {
    const st = statSync(dir, { throwIfNoEntry: false });
    if (st && st.isFile()) {
      return `${dir} exists and is a file; cannot stage under it`;
    }
    dir = dirname(dir);
  }
  return undefined;
}

/**
 * Stage (or unstage) the winning instructions card into the harness slot.
 * Never reads or writes `notes.md`.
 */
export function stageInstructions(input: StageInstructionsInput): StageInstructionsResult {
  const envelope = envelopeRelativePath(input.harness, input.ide, input.envelopes);
  if (!envelope) {
    return { ok: false, code: "unknown-harness", error: `unknown harness '${input.harness}'` };
  }

  if (typeof input.projectRoot !== "string" || input.projectRoot.length === 0) {
    return { ok: false, code: "invalid-project", error: "projectRoot is required" };
  }
  const projectRoot = resolve(input.projectRoot);
  const projectStat = statSync(projectRoot, { throwIfNoEntry: false });
  if (!projectStat || !projectStat.isDirectory()) {
    return { ok: false, code: "invalid-project", error: `projectRoot is not a directory: ${projectRoot}` };
  }

  const dest = resolve(projectRoot, envelope);
  if (!isPathInside(projectRoot, dest)) {
    return { ok: false, code: "invalid-project", error: "envelope path escaped the project folder" };
  }

  const blocked = parentIsFile(dest, projectRoot);
  if (blocked) {
    return { ok: false, code: "conflict", error: blocked };
  }

  const destStat = statSync(dest, { throwIfNoEntry: false });
  if (destStat?.isFile()) {
    const existing = readFileSync(dest, "utf8");
    if (!isMbaStaged(existing)) {
      return {
        ok: false,
        code: "conflict",
        error: `${envelope} already exists and is not an MBA-staged file`,
      };
    }
  } else if (destStat && !destStat.isFile()) {
    return { ok: false, code: "conflict", error: `${envelope} exists and is not a file` };
  }

  const sourcePath = input.sourcePath;
  if (!sourcePath) {
    return unstageIfOurs(dest, envelope, "no-card");
  }

  const sourceAbs = resolve(sourcePath);
  if (input.sourceRoot) {
    const root = resolve(input.sourceRoot);
    if (sourceAbs !== root && !isPathInside(root, sourceAbs)) {
      return { ok: false, code: "source-escape", error: "instructions path is outside the adapter tree" };
    }
  }

  const sourceStat = statSync(sourceAbs, { throwIfNoEntry: false });
  if (!sourceStat || !sourceStat.isFile()) {
    return unstageIfOurs(dest, envelope, "no-card");
  }

  const body = readFileSync(sourceAbs, "utf8");
  if (body.trim().length === 0) {
    return unstageIfOurs(dest, envelope, "empty", sourceAbs);
  }

  atomicWriteText(dest, wrapStagedCard(input.harness, body));
  return { ok: true, action: "wrote", envelope, dest, source: sourceAbs };
}

function unstageIfOurs(
  dest: string,
  envelope: string,
  reason: StageSkipReason,
  source?: string,
): StageInstructionsResult {
  const st = statSync(dest, { throwIfNoEntry: false });
  if (st?.isFile() && isMbaStaged(readFileSync(dest, "utf8"))) {
    rmSync(dest);
    return { ok: true, action: "removed", reason, envelope, dest, source };
  }
  return { ok: true, action: "skipped", reason, envelope, dest, source };
}
