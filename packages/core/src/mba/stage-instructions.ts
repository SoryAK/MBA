/**
 * Copy a store `instructions.md` into the project as a harness envelope.
 *
 * The harness injects that file with its existing pipe. MBA does not splice
 * `messages[]`. Empty cards are not staged. `notes.md` is never a source.
 */

import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  envelopeRelativePath,
  isMbaStaged,
  stagedModelId,
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
  /** Model id written into the staged card so the file shows which model is loaded. */
  readonly modelId?: string;
  /**
   * Other models already paired on this harness + project. An empty card
   * must not pull down a sibling's playbook — pairing is many keys, the
   * envelope is one slot.
   */
  readonly slotPeers?: readonly string[];
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

/** Who currently owns the harness envelope for this project slot, if anyone. */
export function readEnvelopeOwner(
  projectRoot: string,
  harness: string,
  extras: readonly EnvelopeBinding[] = [],
  ide?: string,
): string | undefined {
  const envelope = envelopeRelativePath(harness, ide, extras);
  if (!envelope) return undefined;
  const dest = resolve(projectRoot, envelope);
  const st = statSync(dest, { throwIfNoEntry: false });
  if (!st?.isFile()) return undefined;
  try {
    const text = readFileSync(dest, "utf8");
    if (!isMbaStaged(text)) return undefined;
    return stagedModelId(text);
  } catch {
    return undefined;
  }
}

function atomicWriteText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, path);
}

/**
 * Directory slots stack if two MBA cards sit side by side. When switching
 * models, drop other MBA-staged siblings and leave the operator's files alone.
 * Project-root slots (CLAUDE.local.md) are a single filename; do not sweep.
 */
function sweepStaleMbaSiblings(projectRoot: string, keepDest: string): void {
  const dir = dirname(keepDest);
  if (resolve(dir) === resolve(projectRoot)) return;
  if (!isPathInside(projectRoot, dir)) return;
  const st = statSync(dir, { throwIfNoEntry: false });
  if (!st?.isDirectory()) return;
  const keep = resolve(keepDest);
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (resolve(path) === keep) continue;
    const file = statSync(path, { throwIfNoEntry: false });
    if (!file?.isFile()) continue;
    try {
      if (isMbaStaged(readFileSync(path, "utf8"))) rmSync(path);
    } catch {
      // Unreadable leftover — leave it.
    }
  }
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
  const envelope = envelopeRelativePath(input.harness, input.ide, input.envelopes, input.modelId);
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
  const preservePeerCard = shouldPreservePeerCard(input);
  if (!sourcePath) {
    return unstageIfOurs(projectRoot, dest, envelope, "no-card", undefined, preservePeerCard);
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
    return unstageIfOurs(projectRoot, dest, envelope, "no-card", undefined, preservePeerCard);
  }

  const body = readFileSync(sourceAbs, "utf8");
  if (body.trim().length === 0) {
    return unstageIfOurs(projectRoot, dest, envelope, "empty", sourceAbs, preservePeerCard);
  }

  atomicWriteText(dest, wrapStagedCard(input.harness, body, input.modelId));
  sweepStaleMbaSiblings(projectRoot, dest);
  return { ok: true, action: "wrote", envelope, dest, source: sourceAbs };
}

function shouldPreservePeerCard(input: StageInstructionsInput): boolean {
  const self = input.modelId;
  if (!self) return false;
  return (input.slotPeers ?? []).some((id) => id !== self);
}

function unstageIfOurs(
  projectRoot: string,
  dest: string,
  envelope: string,
  reason: StageSkipReason,
  source?: string,
  preservePeerCard = false,
): StageInstructionsResult {
  const st = statSync(dest, { throwIfNoEntry: false });
  const ours = Boolean(st?.isFile() && isMbaStaged(readFileSync(dest, "utf8")));
  if (ours && preservePeerCard) {
    return { ok: true, action: "skipped", reason, envelope, dest, source };
  }
  let action: StageAction = "skipped";
  if (ours) {
    rmSync(dest);
    action = "removed";
  }
  sweepStaleMbaSiblings(projectRoot, dest);
  return { ok: true, action, reason, envelope, dest, source };
}
