/**
 * Draft adapter YAML generation (ADR-0098, Q4).
 *
 * Pure functions: profile + identity → YAML text. The draft is a valid
 * `ModelBehavioralAdapter` that the resolver can load immediately; fields
 * that cannot be derived from the GGUF header are emitted as `TODO` strings
 * so a human (or a later `mba` command) knows exactly what to fill in.
 *
 * Deliberately TODO in the draft:
 * - `profile.imatrix` — build-machine paths, not part of the download
 * - `client.vision` / `client.toolCalling` — defaults are guesses, not facts
 *
 * `metadata.name` / `identity.model.name` are derived from the GGUF header's
 * `general.name` when available (passed via `ggufName`); otherwise they fall
 * back to the model id. A trailing comment notes the derivation so a human
 * knows they can override it.
 *
 * `profile.baseModel` is derived from the download source when it is a
 * HuggingFace URL or repo shorthand (passed via `baseModel`); otherwise it
 * falls back to a placeholder prompting the user to fill it in.
 */

import YAML from "yaml";
import type { MbaModelProfile } from "../mba/types.js";

export interface DraftAdapterInput {
  id: string;
  family: string;
  fileName: string;
  sha256: string;
  profile: MbaModelProfile;
  /**
   * Display name from the GGUF header (`general.name`). When present, used
   * for both `metadata.name` and `identity.model.name`; otherwise the id is
   * used as the fallback.
   */
  ggufName?: string;
  /**
   * Upstream base model repo id (e.g. `owner/repo`). When present, used for
   * `profile.baseModel`; otherwise a placeholder is emitted.
   */
  baseModel?: string;
}

/**
 * Build the model-tier adapter YAML (the `<id>/<id>.yaml` file).
 */
export function draftAdapterYaml(input: DraftAdapterInput): string {
  const { id, family, fileName, profile, ggufName, baseModel } = input;
  const displayName = ggufName && ggufName.length > 0 ? ggufName : id;
  const baseModelValue =
    baseModel && baseModel.length > 0
      ? baseModel
      : "[ input base models here once determined ]";

  const doc = {
    apiVersion: "mba.c-yard.dev/v1alpha1",
    kind: "ModelBehavioralAdapter",
    metadata: {
      id,
      name: displayName,
      family,
    },
    identity: {
      model: {
        name: displayName,
        lineage: [family, id],
        file: `./${fileName}`,
        profile: {
          ...profile,
          baseModel: baseModelValue,
        },
      },
    },
    client: {
      url: "http://127.0.0.1:8080/v1",
      toolCalling: true,
      vision: false,
    },
    bindings: {
      bcb: "./bcb.jsonl",
      tcb: "./tcb.jsonl",
      server_setup: "./server_setup.json",
    },
  };

  const yaml = YAML.stringify(doc, { lineWidth: 0 });
  // YAML.stringify cannot emit comments, so trailing comments are appended.
  // The imatrix field is intentionally absent from the doc: the header's
  // imatrix paths are build-machine absolute paths and the imatrix file is
  // not part of the download.
  let out = yaml;
  if (ggufName && ggufName.length > 0) {
    out +=
      "\n# metadata.name / identity.model.name derived from the GGUF header\n" +
      "# (general.name). Override if you want a different display name.\n";
  }
  if (baseModel && baseModel.length > 0) {
    out +=
      "\n# profile.baseModel derived from the download source. Override if\n" +
      "# the upstream repo differs from the download host.\n";
  }
  out +=
    "\n# TODO: profile.imatrix — not derivable from the download. If this model\n" +
    "# was quantized with an imatrix, add:\n" +
    "#   imatrix:\n" +
    "#     file: <relative path to the imatrix gguf>\n" +
    "#     dataset: <calibration dataset name>\n";
  return out;
}

/**
 * Title-case a family slug for use as a display name, e.g.
 * `qwen` → `Qwen`, `llama-3` → `Llama 3`.
 */
function familyDisplayName(family: string): string {
  return family
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * Build the family-tier adapter YAML (the `<family>/family.yaml` file).
 * Only written when the family folder has no family.yaml yet.
 */
export function draftFamilyYaml(input: { family: string }): string {
  const { family } = input;

  const doc = {
    apiVersion: "mba.c-yard.dev/v1alpha1",
    kind: "ModelBehavioralAdapter",
    metadata: {
      id: `${family}-family`,
      name: familyDisplayName(family),
      family,
    },
    identity: {
      model: {
        family,
        lineage: [family],
      },
    },
    bindings: {
      bcb: "./bcb.jsonl",
      tcb: "./tcb.jsonl",
      structural: "./structural.json",
      server_setup: "./server_setup.json",
    },
  };

  return YAML.stringify(doc, { lineWidth: 0 });
}
