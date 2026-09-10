/**
 * Stage a model's winning `instructions.md` into a project folder.
 *
 * Catalog lookup + resolver (family then model) pick the card. The copy
 * lands in a harness-native envelope. Environment folders overlay dials,
 * not markdown. `notes.md` is never a source.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import YAML from "yaml";
import { resolveMbaConfig } from "../mba/resolver.js";
import type { EnvelopeBinding } from "../mba/envelope.js";
import { stageInstructions, readEnvelopeOwner, type StageInstructionsResult } from "../mba/stage-instructions.js";
import { defaultIdeForHarness, DEFAULT_RESOLVE_ENV } from "./env-context.js";
import { readModelCatalog } from "./model-catalog.js";
import {
  newestSession,
  sessionsSharingSlot,
  type ClientSession,
} from "./sessions.js";

export interface StageModelCardInput {
  readonly adapterDir: string;
  readonly modelId: string;
  readonly projectRoot: string;
  readonly harness: string;
  readonly ide?: string;
  readonly envelopes?: readonly EnvelopeBinding[];
  /** Other model ids already paired on this harness + project. */
  readonly slotPeers?: readonly string[];
}

export type StageModelCardResult =
  | (Extract<StageInstructionsResult, { ok: true }> & { readonly modelId: string })
  | (Extract<StageInstructionsResult, { ok: false }> | { readonly ok: false; readonly code: "unknown-model"; readonly error: string });

export function stageModelCard(input: StageModelCardInput): StageModelCardResult {
  const catalog = readModelCatalog(input.adapterDir);
  const entry = catalog.find((c) => c.id === input.modelId);
  if (!entry) {
    return { ok: false, code: "unknown-model", error: `unknown model: ${input.modelId}` };
  }

  let declaredName: string | undefined;
  let declaredFamily: string | undefined;
  try {
    const raw = YAML.parse(readFileSync(entry.yamlPath, "utf8")) as {
      identity?: { model?: { name?: string; family?: string } };
    };
    declaredName = raw.identity?.model?.name;
    declaredFamily = raw.identity?.model?.family;
  } catch {
    // Fall through to catalog name / family.
  }

  const ide = input.ide && input.ide.length > 0 ? input.ide : defaultIdeForHarness(input.harness);
  const resolved = resolveMbaConfig(dirname(input.adapterDir), {
    modelName: declaredName ?? entry.name,
    modelFamily: declaredFamily ?? entry.family,
    harness: input.harness,
    ide,
    serverRuntime: DEFAULT_RESOLVE_ENV.serverRuntime,
  });

  const staged = stageInstructions({
    projectRoot: input.projectRoot,
    sourcePath: resolved.instructionsPath,
    harness: input.harness,
    ide,
    envelopes: input.envelopes,
    sourceRoot: input.adapterDir,
    modelId: input.modelId,
    slotPeers: input.slotPeers,
  });
  if (!staged.ok) return staged;
  return { ...staged, modelId: input.modelId };
}

/**
 * After a revoke, each vacated (harness, project) slot either restages the
 * newest remaining peer's card or unstages if the slot is empty.
 */
export function restageSlotsAfterRevoke(input: {
  readonly adapterDir: string;
  readonly envelopes?: readonly EnvelopeBinding[];
  readonly remaining: readonly ClientSession[];
  readonly revoked: readonly ClientSession[];
}): void {
  const seen = new Set<string>();
  for (const vacated of input.revoked) {
    const key = `${vacated.harness}\0${resolve(vacated.projectRoot)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const onSlot = sessionsSharingSlot(input.remaining, vacated.harness, vacated.projectRoot);
    const newest = newestSession(onSlot);
    if (!newest) {
      stageInstructions({
        projectRoot: vacated.projectRoot,
        harness: vacated.harness,
        ide: vacated.ide,
        envelopes: input.envelopes,
      });
      continue;
    }
    stageModelCard({
      adapterDir: input.adapterDir,
      modelId: newest.modelId,
      projectRoot: newest.projectRoot,
      harness: newest.harness,
      ide: newest.ide,
      envelopes: input.envelopes,
      slotPeers: onSlot.filter((s) => s.modelId !== newest.modelId).map((s) => s.modelId),
    });
  }
}

export interface RestageSlotResult {
  readonly harness: string;
  readonly projectRoot: string;
  readonly action: string;
  readonly envelope?: string;
  readonly owner?: string;
  readonly replaced?: string;
}

/**
 * After a model switch, restage this model's card in every harness slot
 * it is already paired to. Same trigger as ensure — not a second command.
 */
export function restagePairedSlotsForModel(input: {
  readonly adapterDir: string;
  readonly modelId: string;
  readonly sessions: readonly ClientSession[];
  readonly envelopes?: readonly EnvelopeBinding[];
}): RestageSlotResult[] {
  const seen = new Set<string>();
  const out: RestageSlotResult[] = [];
  for (const row of input.sessions) {
    if (row.modelId !== input.modelId) continue;
    const key = `${row.harness}\0${resolve(row.projectRoot)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const previous = readEnvelopeOwner(row.projectRoot, row.harness, input.envelopes, row.ide);
    const peers = sessionsSharingSlot(input.sessions, row.harness, row.projectRoot)
      .map((s) => s.modelId)
      .filter((id) => id !== input.modelId);
    const staged = stageModelCard({
      adapterDir: input.adapterDir,
      modelId: input.modelId,
      projectRoot: row.projectRoot,
      harness: row.harness,
      ide: row.ide,
      envelopes: input.envelopes,
      slotPeers: peers,
    });
    const owner =
      readEnvelopeOwner(row.projectRoot, row.harness, input.envelopes, row.ide) ??
      (staged.ok && staged.action === "wrote" ? input.modelId : previous);
    out.push({
      harness: row.harness,
      projectRoot: resolve(row.projectRoot),
      action: staged.ok ? staged.action : staged.code,
      envelope: staged.ok ? staged.envelope : undefined,
      owner,
      ...(previous && previous !== input.modelId && staged.ok && staged.action === "wrote"
        ? { replaced: previous }
        : {}),
    });
  }
  return out;
}
