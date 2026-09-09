import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  estimateRecipeMemory,
  findMaxFittingCtxSize,
  type GgufRecipeShape,
} from "./gguf-memory-estimator.js";

function writeString(buf: Buffer, offset: number, value: string): number {
  const bytes = Buffer.from(value, "utf8");
  buf.writeBigUInt64LE(BigInt(bytes.length), offset);
  bytes.copy(buf, offset + 8);
  return 8 + bytes.length;
}

function writeUint32(buf: Buffer, offset: number, value: number): number {
  buf.writeUInt32LE(value, offset);
  return 4;
}

function writeUint64(buf: Buffer, offset: number, value: bigint): number {
  buf.writeBigUInt64LE(value, offset);
  return 8;
}

function writeKvUint32(buf: Buffer, offset: number, key: string, value: number): number {
  let written = 0;
  written += writeString(buf, offset + written, key);
  buf.writeUInt32LE(4, offset + written); // GGUF value type uint32
  written += 4;
  written += writeUint32(buf, offset + written, value);
  return written;
}

function writeKvString(buf: Buffer, offset: number, key: string, value: string): number {
  let written = 0;
  written += writeString(buf, offset + written, key);
  buf.writeUInt32LE(8, offset + written); // GGUF value type string
  written += 4;
  written += writeString(buf, offset + written, value);
  return written;
}

interface MinimalGgufOptions {
  blockCount: number;
  hiddenSize: number;
  headCount: number;
  headCountKv: number;
  vocabSize?: number;
  ffnDim?: number;
  fileSizeBytes?: number;
}

function createMinimalGgufFile(dir: string, opts: MinimalGgufOptions): string {
  const metadata: { key: string; type: "uint32" | "string"; value: string | number }[] = [
    { key: "general.architecture", type: "string", value: "llama" },
    { key: "llama.block_count", type: "uint32", value: opts.blockCount },
    { key: "llama.embedding_length", type: "uint32", value: opts.hiddenSize },
    { key: "llama.attention.head_count", type: "uint32", value: opts.headCount },
    { key: "llama.attention.head_count_kv", type: "uint32", value: opts.headCountKv },
    ...(opts.vocabSize !== undefined ? [{ key: "llama.vocab_size", type: "uint32" as const, value: opts.vocabSize }] : []),
    ...(opts.ffnDim !== undefined ? [{ key: "llama.feed_forward_length", type: "uint32" as const, value: opts.ffnDim }] : []),
  ];

  // Allocate generously.
  const buf = Buffer.alloc(4096);
  let offset = 0;

  // Magic.
  buf.write("GGUF", offset, 4, "ascii");
  offset += 4;
  // Version.
  offset += writeUint32(buf, offset, 3);
  // Tensor count.
  offset += writeUint64(buf, offset, 0n);
  // KV count.
  offset += writeUint64(buf, offset, BigInt(metadata.length));

  for (const entry of metadata) {
    if (entry.type === "uint32") {
      offset += writeKvUint32(buf, offset, entry.key, entry.value as number);
    } else {
      offset += writeKvString(buf, offset, entry.key, entry.value as string);
    }
  }

  const fileSize = opts.fileSizeBytes ?? 1024 * 1024 * 1024; // 1 GB default dummy weight file.
  // Pad the file to the requested size so statSync returns the expected size.
  const path = join(dir, "model.gguf");
  const final = Buffer.alloc(fileSize);
  buf.copy(final, 0, 0, offset);
  writeFileSync(path, final);
  return path;
}

function recipe(path: string, overrides: Partial<GgufRecipeShape> = {}): GgufRecipeShape {
  return {
    modelPath: path,
    ctxSize: 4096,
    gpuLayers: 0,
    ...overrides,
  };
}

describe("estimateRecipeMemory", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mba-estimator-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns undefined when the file is not a valid GGUF", () => {
    const bad = join(dir, "not.gguf");
    writeFileSync(bad, "not a gguf file", "utf8");
    expect(estimateRecipeMemory(recipe(bad))).toBeUndefined();
  });

  it("returns undefined when required architecture fields are missing", () => {
    // Header only — missing head_count_kv. Do not pad to 1 GB; this case
    // never consults file size and that write times out on CI.
    const broken = join(dir, "broken.gguf");
    const brokenMeta = [
      { key: "general.architecture", type: "string" as const, value: "llama" },
      { key: "llama.block_count", type: "uint32" as const, value: 32 },
      { key: "llama.embedding_length", type: "uint32" as const, value: 4096 },
      { key: "llama.attention.head_count", type: "uint32" as const, value: 32 },
    ];
    const buf = Buffer.alloc(4096);
    let offset = 0;
    buf.write("GGUF", offset, 4, "ascii");
    offset += 4;
    offset += writeUint32(buf, offset, 3);
    offset += writeUint64(buf, offset, 0n);
    offset += writeUint64(buf, offset, BigInt(brokenMeta.length));
    for (const entry of brokenMeta) {
      if (entry.type === "uint32") {
        offset += writeKvUint32(buf, offset, entry.key, entry.value);
      } else {
        offset += writeKvString(buf, offset, entry.key, entry.value);
      }
    }
    writeFileSync(broken, buf.subarray(0, offset));

    expect(estimateRecipeMemory(recipe(broken))).toBeUndefined();
  });

  it("estimates CPU-only memory and reports weights > 0", () => {
    const fileSize = 1 * 1024 * 1024 * 1024; // 1 GB file
    const path = createMinimalGgufFile(dir, {
      blockCount: 32,
      hiddenSize: 4096,
      headCount: 32,
      headCountKv: 8,
      fileSizeBytes: fileSize,
    });
    const est = estimateRecipeMemory(recipe(path, { ctxSize: 4096, gpuLayers: 0 }));
    expect(est).toBeDefined();
    expect(est!.breakdown.weightsBytes).toBeGreaterThan(fileSize);
    expect(est!.vramBytes).toBe(0);
    expect(est!.ramBytes).toBe(est!.totalBytes);
  });

  it("increases KV cache memory as ctxSize grows", () => {
    const path = createMinimalGgufFile(dir, {
      blockCount: 32,
      hiddenSize: 4096,
      headCount: 32,
      headCountKv: 8,
      fileSizeBytes: 1 * 1024 * 1024 * 1024,
    });
    const a = estimateRecipeMemory(recipe(path, { ctxSize: 4096, gpuLayers: 0 }))!;
    const b = estimateRecipeMemory(recipe(path, { ctxSize: 8192, gpuLayers: 0 }))!;
    expect(b.breakdown.kvCacheBytes).toBeGreaterThan(a.breakdown.kvCacheBytes);
  });

  it("shifts weights to VRAM when gpuLayers is set", () => {
    const fileSize = 1 * 1024 * 1024 * 1024;
    const path = createMinimalGgufFile(dir, {
      blockCount: 32,
      hiddenSize: 4096,
      headCount: 32,
      headCountKv: 8,
      fileSizeBytes: fileSize,
    });
    const cpu = estimateRecipeMemory(recipe(path, { ctxSize: 4096, gpuLayers: 0 }))!;
    const gpu = estimateRecipeMemory(recipe(path, { ctxSize: 4096, gpuLayers: 16 }))!;
    expect(gpu.vramBytes).toBeGreaterThan(0);
    expect(gpu.ramBytes).toBeLessThan(cpu.ramBytes);
  });

  it("splits weights, KV cache, and compute buffer proportionally for partial offload", () => {
    const fileSize = 1 * 1024 * 1024 * 1024;
    const path = createMinimalGgufFile(dir, {
      blockCount: 32,
      hiddenSize: 4096,
      headCount: 32,
      headCountKv: 8,
      fileSizeBytes: fileSize,
    });
    const half = estimateRecipeMemory(recipe(path, { ctxSize: 4096, gpuLayers: 16 }))!;
    // 16 / 32 = 50% offloaded
    expect(half.split.vramWeightsBytes).toBeGreaterThan(0);
    expect(half.split.ramWeightsBytes).toBeGreaterThan(0);
    expect(half.split.vramWeightsBytes + half.split.ramWeightsBytes).toBe(half.breakdown.weightsBytes);
    expect(half.split.vramKvCacheBytes + half.split.ramKvCacheBytes).toBe(half.breakdown.kvCacheBytes);
    expect(half.split.vramComputeBufferBytes + half.split.ramComputeBufferBytes).toBe(
      half.breakdown.computeBufferBytes,
    );
  });

  it("puts all memory in RAM when gpuLayers is 0", () => {
    const fileSize = 1 * 1024 * 1024 * 1024;
    const path = createMinimalGgufFile(dir, {
      blockCount: 32,
      hiddenSize: 4096,
      headCount: 32,
      headCountKv: 8,
      fileSizeBytes: fileSize,
    });
    const est = estimateRecipeMemory(recipe(path, { ctxSize: 4096, gpuLayers: 0 }))!;
    expect(est.vramBytes).toBe(0);
    expect(est.split.vramWeightsBytes).toBe(0);
    expect(est.split.vramKvCacheBytes).toBe(0);
    expect(est.split.vramComputeBufferBytes).toBe(0);
    expect(est.split.ramOverheadBytes).toBe(est.breakdown.overheadBytes);
  });

  it("caps gpuLayers at the block count", () => {
    const path = createMinimalGgufFile(dir, {
      blockCount: 32,
      hiddenSize: 4096,
      headCount: 32,
      headCountKv: 8,
      fileSizeBytes: 1 * 1024 * 1024 * 1024,
    });
    const full = estimateRecipeMemory(recipe(path, { ctxSize: 4096, gpuLayers: 32 }))!;
    const over = estimateRecipeMemory(recipe(path, { ctxSize: 4096, gpuLayers: 100 }))!;
    expect(over.vramBytes).toBe(full.vramBytes);
  });

  it("uses cacheTypeK / cacheTypeV when provided", () => {
    const path = createMinimalGgufFile(dir, {
      blockCount: 32,
      hiddenSize: 4096,
      headCount: 32,
      headCountKv: 8,
      fileSizeBytes: 1 * 1024 * 1024 * 1024,
    });
    const f16 = estimateRecipeMemory(recipe(path, { ctxSize: 4096, gpuLayers: 0, cacheTypeK: "f16" }))!;
    const q8 = estimateRecipeMemory(recipe(path, { ctxSize: 4096, gpuLayers: 0, cacheTypeK: "q8_0" }))!;
    expect(q8.breakdown.kvCacheBytes).toBeLessThan(f16.breakdown.kvCacheBytes);
  });
});

describe("findMaxFittingCtxSize", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mba-estimator-maxctx-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("finds the largest context size that fits RAM", () => {
    const path = createMinimalGgufFile(dir, {
      blockCount: 8,
      hiddenSize: 512,
      headCount: 8,
      headCountKv: 2,
      fileSizeBytes: 100 * 1024 * 1024, // 100 MB weights
    });
    const max = findMaxFittingCtxSize(
      recipe(path, { ctxSize: 4096, gpuLayers: 0 }),
      500 * 1024 * 1024, // 500 MB RAM
      undefined,
      65536,
    );
    expect(max).toBeDefined();
    expect(max).toBeGreaterThan(0);
    // With 500 MB budget, a non-trivial context should fit but not exceed it.
    expect(estimateRecipeMemory(recipe(path, { ctxSize: max!, gpuLayers: 0 }))!.totalBytes).toBeLessThanOrEqual(
      500 * 1024 * 1024,
    );
  });

  it("returns undefined when the estimator cannot read the model", () => {
    const bad = join(dir, "missing.gguf");
    expect(findMaxFittingCtxSize(recipe(bad), 1e9, undefined)).toBeUndefined();
  });
});
