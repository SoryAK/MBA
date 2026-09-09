/**
 * Stage a model's winning `instructions.md` into a project folder.
 *
 * Catalog lookup + resolver (family then model) pick the card. The copy
 * lands in a harness-native envelope. Environment folders overlay dials,
 * not markdown. `notes.md` is never a source.
 */

import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import YAML from "yaml";
import { resolveMbaConfig } from "../mba/resolver.js";
import type { EnvelopeBinding } from "../mba/envelope.js";
import { stageInstructions, type StageInstructionsResult } from "../mba/stage-instructions.js";
import { defaultIdeForHarness, DEFAULT_RESOLVE_ENV } from "./env-context.js";
import { readModelCatalog } from "./model-catalog.js";

export interface StageModelCardInput {
  readonly adapterDir: string;
  readonly modelId: string;
  readonly projectRoot: string;
  readonly harness: string;
  readonly ide?: string;
  readonly envelopes?: readonly EnvelopeBinding[];
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
  });
  if (!staged.ok) return staged;
  return { ...staged, modelId: input.modelId };
}
