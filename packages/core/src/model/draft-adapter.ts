/**
 * Draft adapter YAML generation (ADR-0098, Q4).
 *
 * Pure functions: profile + identity → YAML text. The draft is a valid
 * `ModelBehavioralAdapter` that the resolver can load immediately; fields
 * that cannot be derived from the GGUF header are emitted as `TODO` strings
 * so a human (or a later `mba` command) knows exactly what to fill in.
 *
 * Deliberately TODO in the draft:
 * - `metadata.name` / `identity.model.name` — display names are human choices
 * - `profile.baseModel` — the upstream repo id is not in the header
 * - `profile.imatrix` — build-machine paths, not part of the download
 * - `client.vision` / `client.toolCalling` — defaults are guesses, not facts
 */

import YAML from "yaml";
import type { MbaModelProfile } from "../mba/types.js";

export interface DraftAdapterInput {
  id: string;
  family: string;
  fileName: string;
  sha256: string;
  profile: MbaModelProfile;
}

/**
 * Build the model-tier adapter YAML (the `<id>/<id>.yaml` file).
 */
export function draftAdapterYaml(input: DraftAdapterInput): string {
  const { id, family, fileName, profile } = input;

  const doc = {
    apiVersion: "mba.c-yard.dev/v1alpha1",
    kind: "ModelBehavioralAdapter",
    metadata: {
      id,
      name: `TODO: display name for ${id}`,
      family,
    },
    identity: {
      model: {
        name: `TODO: model name for ${id}`,
        lineage: [family, id],
        file: `./${fileName}`,
        profile: {
          ...profile,
          baseModel: `TODO: upstream base model, e.g. org/${id}`,
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
  // YAML.stringify cannot emit comments, so the imatrix TODO is appended as a
  // trailing comment. The field itself is intentionally absent from the doc:
  // the header's imatrix paths are build-machine absolute paths and the
  // imatrix file is not part of the download.
  return (
    yaml +
    "\n# TODO: profile.imatrix — not derivable from the download. If this model\n" +
    "# was quantized with an imatrix, add:\n" +
    "#   imatrix:\n" +
    "#     file: <relative path to the imatrix gguf>\n" +
    "#     dataset: <calibration dataset name>\n"
  );
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
      name: `TODO: display name for the ${family} family`,
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
