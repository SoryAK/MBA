/**
 * Model memory estimator (ADR-0103).
 *
 * Estimates the RAM/VRAM a `llama-server` recipe will need from the model's
 * GGUF metadata. This is a TypeScript port of the high-level formulas used by
 * llama.cpp's memory planner, accurate enough to clamp `ctxSize` and
 * `gpuLayers` to what the host machine can provide.
 *
 * Limitations of v1:
 * - Weight memory is approximated from the on-disk file size, not from per-tensor
 *   quantization. The file size is a lower bound for runtime weight memory; we add
 *   a margin for the decompression / compute tensors that are larger than their
 *   quantized storage.
 * - KV cache is computed from architecture metadata only.
 * - Compute buffer is a heuristic. It is not architecture-aware beyond
 *   `hiddenSize` and `contextSize`.
 *
 * When the estimator cannot read enough metadata, it returns `undefined` so the
 * caller can fall back to the simpler heuristic overlay.
 */

import { statSync } from "node:fs";
import { parseGgufMetadata } from "../model/gguf-metadata.js";

export interface MemoryEstimate {
  /** Total bytes required to run the recipe (RAM + VRAM). */
  readonly totalBytes: number;
  /** Bytes that must live in host RAM. */
  readonly ramBytes: number;
  /** Bytes that must live in GPU VRAM (0 if gpuLayers is 0). */
  readonly vramBytes: number;
  /** Breakdown for diagnostics. */
  readonly breakdown: {
    readonly weightsBytes: number;
    readonly kvCacheBytes: number;
    readonly computeBufferBytes: number;
    readonly overheadBytes: number;
  };
}

export interface GgufRecipeShape {
  /** Model weights file. */
  readonly modelPath: string;
  /** Requested context size in tokens. */
  readonly ctxSize: number;
  /** Layers to offload to GPU (0 = CPU only). */
  readonly gpuLayers: number;
  /** Total prompt batch size. */
  readonly batchSize?: number;
  /** Micro-batch size for prompt processing. */
  readonly ubatchSize?: number;
  /** KV cache type for K vectors. Defaults to f16. */
  readonly cacheTypeK?: string;
  /** KV cache type for V vectors. Defaults to f16. */
  readonly cacheTypeV?: string;
  /** Whether flash attention is enabled. Affects compute buffer. */
  readonly flashAttention?: boolean;
}

/** Architecture block extracted from GGUF metadata. */
interface GgufArchitecture {
  readonly blockCount: number;
  readonly hiddenSize: number;
  readonly headCount: number;
  readonly headCountKv: number;
  readonly vocabSize: number;
  readonly ffnDim: number;
  readonly fileBytes: number;
}

const BYTES_PER_PARAM_BY_CACHE_TYPE: Record<string, number> = {
  f32: 4,
  f16: 2,
  q8_0: 1,
  q4_0: 0.5,
  q4_1: 0.5,
  q5_0: 0.625,
  q5_1: 0.625,
  q2_K: 0.25,
  q3_K: 0.375,
  q4_K: 0.5,
  q5_K: 0.625,
  q6_K: 0.75,
  q8_K: 1,
};

function cacheElementSize(cacheType: string | undefined): number {
  const normalized = (cacheType ?? "f16").toLowerCase().replace(/[_-]/g, "");
  for (const [key, bytes] of Object.entries(BYTES_PER_PARAM_BY_CACHE_TYPE)) {
    if (key.replace(/[_-]/g, "") === normalized) return bytes;
  }
  return 2; // f16 default
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  return undefined;
}

function readMetadataNumber(
  fields: Record<string, unknown>,
  ...keys: string[]
): number | undefined {
  for (const key of keys) {
    const value = fields[key];
    const n = readNumber(value);
    if (n !== undefined) return n;
  }
  return undefined;
}

function readArchitectureMetadata(
  modelPath: string,
): GgufArchitecture | undefined {
  let meta: ReturnType<typeof parseGgufMetadata>;
  try {
    meta = parseGgufMetadata(modelPath);
  } catch {
    return undefined;
  }

  const { fields } = meta;
  const arch = String(fields["general.architecture"] ?? "llama");

  const blockCount = readMetadataNumber(
    fields,
    `${arch}.block_count`,
    "llama.block_count",
    "block_count",
  );
  const hiddenSize = readMetadataNumber(
    fields,
    `${arch}.embedding_length`,
    "llama.embedding_length",
    "embedding_length",
  );
  const headCount = readMetadataNumber(
    fields,
    `${arch}.attention.head_count`,
    "llama.attention.head_count",
    "attention.head_count",
  );
  const headCountKv = readMetadataNumber(
    fields,
    `${arch}.attention.head_count_kv`,
    "llama.attention.head_count_kv",
    "attention.head_count_kv",
  );
  const vocabSize = readMetadataNumber(
    fields,
    `${arch}.vocab_size`,
    "general.vocab_size",
    "vocab_size",
  );
  const ffnDim = readMetadataNumber(
    fields,
    `${arch}.feed_forward_length`,
    "llama.feed_forward_length",
    "feed_forward_length",
  );

  if (
    blockCount === undefined ||
    hiddenSize === undefined ||
    headCount === undefined ||
    headCountKv === undefined
  ) {
    return undefined;
  }

  let fileBytes: number;
  try {
    fileBytes = statSync(modelPath).size;
  } catch {
    return undefined;
  }

  return {
    blockCount,
    hiddenSize,
    headCount,
    headCountKv,
    vocabSize: vocabSize ?? 0,
    ffnDim: ffnDim ?? 0,
    fileBytes,
  };
}

/**
 * Estimate weight memory from the on-disk file size.
 *
 * The file is smaller than the runtime working set because:
 * - Some tensors are stored quantized but used at higher precision for compute.
 * - There are activation buffers beyond the weights.
 *
 * We add a margin to move from "file size" to "runtime weight memory". The
 * margin is intentionally conservative for v1; it will be refined by comparing
 * against real `llama-server` runs.
 */
function estimateWeightsBytes(arch: GgufArchitecture): number {
  const marginFactor = 1.15; // 15% overhead for compute tensors and alignment.
  return Math.round(arch.fileBytes * marginFactor);
}

/**
 * Estimate the KV cache memory.
 *
 * KV cache stores two vectors per layer per token:
 *   K: [blockCount, ctxSize, headCountKv, headDim]
 *   V: [blockCount, ctxSize, headCountKv, headDim]
 *
 * The head dimension is `hiddenSize / headCount`.
 */
function estimateKvCacheBytes(
  arch: GgufArchitecture,
  ctxSize: number,
  cacheTypeK: string,
  cacheTypeV: string,
): number {
  const headDim = arch.hiddenSize / arch.headCount;
  const bytesPerTokenK =
    arch.blockCount * arch.headCountKv * headDim * cacheElementSize(cacheTypeK);
  const bytesPerTokenV =
    arch.blockCount * arch.headCountKv * headDim * cacheElementSize(cacheTypeV);
  return Math.round((bytesPerTokenK + bytesPerTokenV) * ctxSize);
}

/**
 * Estimate the compute / activation buffer.
 *
 * This is a heuristic. The real buffer depends on the full graph and the
 * batch/ubatch sizes. v1 uses a simple function of `hiddenSize`, `ctxSize`,
 * and `batchSize`.
 */
function estimateComputeBufferBytes(
  arch: GgufArchitecture,
  ctxSize: number,
  batchSize: number,
  _ubatchSize: number,
  _flashAttention: boolean,
): number {
  // A single matmul workspace + activation scratch. The multiplier is a
  // conservative guess that will be tuned against real llama-server runs.
  const tokens = Math.max(ctxSize, batchSize);
  const base = arch.hiddenSize * tokens * 4; // f32 scratch
  const layerFactor = 4; // Allow concurrent layer activations.
  return Math.round(base * layerFactor);
}

/**
 * Estimate memory for a recipe. Returns undefined if the GGUF metadata cannot
 * be read or does not contain the required architecture fields.
 */
export function estimateRecipeMemory(
  recipe: GgufRecipeShape,
): MemoryEstimate | undefined {
  const arch = readArchitectureMetadata(recipe.modelPath);
  if (arch === undefined) return undefined;

  const ctxSize = Math.max(1, recipe.ctxSize);
  const gpuLayers = Math.max(0, Math.min(recipe.gpuLayers, arch.blockCount));
  const batchSize = Math.max(1, recipe.batchSize ?? 2048);
  const ubatchSize = Math.max(1, recipe.ubatchSize ?? 512);
  const cacheTypeK = recipe.cacheTypeK ?? "f16";
  const cacheTypeV = recipe.cacheTypeV ?? "f16";
  const flashAttention = recipe.flashAttention ?? false;

  const weightsBytes = estimateWeightsBytes(arch);
  const kvCacheBytes = estimateKvCacheBytes(arch, ctxSize, cacheTypeK, cacheTypeV);
  const computeBufferBytes = estimateComputeBufferBytes(
    arch,
    ctxSize,
    batchSize,
    ubatchSize,
    flashAttention,
  );
  // Fixed overhead for the process, mmap tables, etc.
  const overheadBytes = 256 * 1024 * 1024; // 256 MB

  const totalBytes = weightsBytes + kvCacheBytes + computeBufferBytes + overheadBytes;

  // Split between RAM and VRAM based on gpuLayers.
  let vramWeightsBytes = 0;
  let ramWeightsBytes = weightsBytes;
  if (gpuLayers > 0) {
    const offloadRatio = gpuLayers / arch.blockCount;
    vramWeightsBytes = Math.round(weightsBytes * offloadRatio);
    ramWeightsBytes = weightsBytes - vramWeightsBytes;
  }

  // v1: KV cache lives in VRAM if any GPU layers are used, otherwise in RAM.
  // Compute buffer is counted as RAM for CPU-only and VRAM for GPU offload.
  const vramBytes = vramWeightsBytes + (gpuLayers > 0 ? kvCacheBytes : 0);
  const ramBytes = ramWeightsBytes + (gpuLayers === 0 ? kvCacheBytes : 0) + computeBufferBytes + overheadBytes;

  return {
    totalBytes,
    ramBytes,
    vramBytes,
    breakdown: {
      weightsBytes,
      kvCacheBytes,
      computeBufferBytes,
      overheadBytes,
    },
  };
}

/**
 * Find the largest context size that fits the available RAM/VRAM, keeping all
 * other recipe fields fixed. Uses a simple binary search over the estimator.
 */
export function findMaxFittingCtxSize(
  recipe: GgufRecipeShape,
  availableRamBytes: number,
  availableVramBytes: number | undefined,
  maxCtxSize?: number,
): number | undefined {
  const upper = maxCtxSize ?? (recipe.ctxSize > 0 ? recipe.ctxSize * 2 : 131072);
  let low = 1;
  let high = upper;
  let best: number | undefined;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const estimate = estimateRecipeMemory({ ...recipe, ctxSize: mid });
    if (estimate === undefined) return undefined;

    const fitsRam = estimate.ramBytes <= availableRamBytes;
    const fitsVram =
      availableVramBytes === undefined || estimate.vramBytes <= availableVramBytes;

    if (fitsRam && fitsVram) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return best;
}
