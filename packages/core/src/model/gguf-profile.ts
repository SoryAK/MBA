/**
 * GGUF header → draft model profile (ADR-0098, Q2).
 *
 * Pure mapping from parsed GGUF fields to the `MbaModelProfile` shape used by
 * adapter YAMLs. Only facts that are actually present in the header are
 * emitted; everything else (baseModel, imatrix, display name, client flags)
 * is left to the draft generator to mark as TODO.
 *
 * Deliberate exclusions:
 * - `quantize.imatrix.*` — the header stores the build machine's absolute
 *   paths, which are meaningless on the pulling machine, and the imatrix file
 *   is not part of the download.
 * - `quant` from `general.file_type` — that field is numeric and there is no
 *   maintained numeric→label table; the label is read from the filename
 *   instead (where it is always present in practice).
 */

import { createHash } from "node:crypto";
import type { MbaModelProfile } from "../mba/types.js";
import type { GgufMetadata } from "./gguf-metadata.js";

/**
 * Extract a quantization label from a GGUF filename, e.g.
 * `Qwen3.8-27B-Q6_K.gguf` → `Q6_K`, `model.f16.gguf` → `F16`.
 * Returns undefined when no label is present.
 */
export function quantFromFilename(fileName: string): string | undefined {
  const base = fileName.replace(/\.gguf$/i, "");
  const m = base.match(/[-_.](Q\d+[A-Z0-9_]*|F16|BF16|IQ\d+[A-Z0-9_]*)$/i);
  const label = m?.[1];
  return label ? label.toUpperCase() : undefined;
}

function str(fields: Record<string, unknown>, key: string): string | undefined {
  const v = fields[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function num(fields: Record<string, unknown>, key: string): number | undefined {
  const v = fields[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function bool(fields: Record<string, unknown>, key: string): boolean | undefined {
  const v = fields[key];
  return typeof v === "boolean" ? v : undefined;
}

/** sha256 of the chat template, first 16 hex chars (matches existing YAMLs). */
function chatTemplateDigest(fields: Record<string, unknown>): string | undefined {
  const t = fields["tokenizer.chat_template"];
  if (typeof t !== "string" || t.length === 0) return undefined;
  return createHash("sha256").update(t).digest("hex").slice(0, 16);
}

/**
 * Derive a draft `MbaModelProfile` from parsed GGUF metadata.
 *
 * @param meta        parsed GGUF header
 * @param fileName    the downloaded file's name (quant label source)
 * @param sha256      content sha256 of the weights file (fileFingerprint)
 */
export function deriveGgufProfile(
  meta: GgufMetadata,
  fileName: string,
  sha256: string,
): MbaModelProfile {
  const f = meta.fields;
  const arch = str(f, "general.architecture");

  const profile: MbaModelProfile = {
    architecture: arch,
    sizeLabel: str(f, "general.size_label"),
    quant: quantFromFilename(fileName),
    quantizedBy: str(f, "general.quantized_by"),
    license: str(f, "general.license"),
    gguf: {
      version: meta.version,
      tensorCount: Number(meta.tensorCount),
      kvCount: Number(meta.kvCount),
      fileFingerprint: sha256,
    },
  };

  // Build the sparse sub-objects first (the profile fields are readonly, so
  // the top-level object is assembled in one shot below).
  let params: MbaModelProfile["params"];
  if (arch) {
    const candidate: Record<string, number | undefined> = {
      blockCount: num(f, `${arch}.block_count`),
      maxContextLength: num(f, `${arch}.context_length`),
      embeddingLength: num(f, `${arch}.embedding_length`),
      feedForwardLength: num(f, `${arch}.feed_forward_length`),
      headCount: num(f, `${arch}.attention.head_count`),
      headCountKv: num(f, `${arch}.attention.head_count_kv`),
      keyLength: num(f, `${arch}.attention.key_length`),
      valueLength: num(f, `${arch}.attention.value_length`),
      ropeFreqBase: num(f, `${arch}.rope.freq_base`),
      expertCount: num(f, `${arch}.expert_count`),
      expertUsedCount: num(f, `${arch}.expert_used_count`),
      expertFeedForwardLength: num(f, `${arch}.expert_feed_forward_length`),
    };
    // Drop undefined keys so the draft stays sparse like hand-written YAMLs.
    for (const k of Object.keys(candidate)) {
      if (candidate[k] === undefined) delete candidate[k];
    }
    if (Object.keys(candidate).length > 0) params = candidate as MbaModelProfile["params"];
  }

  const tokenizerCandidate: Record<string, string | number | boolean | undefined> = {
    model: str(f, "tokenizer.ggml.model"),
    pre: str(f, "tokenizer.ggml.pre"),
    eosTokenId: num(f, "tokenizer.ggml.eos_token_id"),
    paddingTokenId: num(f, "tokenizer.ggml.padding_token_id"),
    addBosToken: bool(f, "tokenizer.ggml.add_bos_token"),
    chatTemplateDigest: chatTemplateDigest(f),
  };
  for (const k of Object.keys(tokenizerCandidate)) {
    if (tokenizerCandidate[k] === undefined) delete tokenizerCandidate[k];
  }
  const tokenizer =
    Object.keys(tokenizerCandidate).length > 0
      ? (tokenizerCandidate as MbaModelProfile["tokenizer"])
      : undefined;

  return {
    ...profile,
    ...(params ? { params } : {}),
    ...(tokenizer ? { tokenizer } : {}),
  };
}
