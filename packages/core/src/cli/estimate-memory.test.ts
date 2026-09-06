import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdEstimateMemory, parseEstimateMemoryArgs, runEstimateMemory } from "./estimate-memory.js";
import { defaultStorePaths } from "../service/config-store.js";
import { writeMachineInfo } from "../service/machine-store.js";
import type { MachineInfo } from "../service/machine-info.js";

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

function createMinimalGgufFile(
  dir: string,
  opts: {
    blockCount: number;
    hiddenSize: number;
    headCount: number;
    headCountKv: number;
    fileSizeBytes?: number;
  },
): string {
  const metadata: { key: string; type: "uint32" | "string"; value: string | number }[] = [
    { key: "general.architecture", type: "string", value: "llama" },
    { key: "llama.block_count", type: "uint32", value: opts.blockCount },
    { key: "llama.embedding_length", type: "uint32", value: opts.hiddenSize },
    { key: "llama.attention.head_count", type: "uint32", value: opts.headCount },
    { key: "llama.attention.head_count_kv", type: "uint32", value: opts.headCountKv },
  ];
  const buf = Buffer.alloc(4096);
  let offset = 0;
  buf.write("GGUF", offset, 4, "ascii");
  offset += 4;
  offset += writeUint32(buf, offset, 3);
  offset += writeUint64(buf, offset, 0n);
  offset += writeUint64(buf, offset, BigInt(metadata.length));
  for (const entry of metadata) {
    offset += writeString(buf, offset, entry.key);
    buf.writeUInt32LE(entry.type === "uint32" ? 4 : 8, offset);
    offset += 4;
    if (entry.type === "uint32") {
      offset += writeUint32(buf, offset, entry.value as number);
    } else {
      offset += writeString(buf, offset, entry.value as string);
    }
  }
  const fileSize = opts.fileSizeBytes ?? 1 * 1024 * 1024;
  const final = Buffer.alloc(fileSize);
  buf.copy(final, 0, 0, offset);
  const path = join(dir, "model.gguf");
  writeFileSync(path, final);
  return path;
}

describe("estimate-memory CLI", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mba-estimate-memory-cli-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("parses recipe flags from CLI args", () => {
    const opts = parseEstimateMemoryArgs([
      "model.gguf",
      "--ctx-size",
      "8192",
      "--gpu-layers",
      "24",
      "--batch-size",
      "1024",
      "--ubatch-size",
      "256",
      "--cache-type-k",
      "q8_0",
      "--cache-type-v",
      "q4_0",
      "--flash-attn",
    ]);
    expect(opts.modelPath).toBe(join(process.cwd(), "model.gguf"));
    expect(opts.ctxSize).toBe(8192);
    expect(opts.gpuLayers).toBe(24);
    expect(opts.batchSize).toBe(1024);
    expect(opts.ubatchSize).toBe(256);
    expect(opts.cacheTypeK).toBe("q8_0");
    expect(opts.cacheTypeV).toBe("q4_0");
    expect(opts.flashAttention).toBe(true);
  });

  it("throws when a flag value is missing", () => {
    expect(() => parseEstimateMemoryArgs(["model.gguf", "--ctx-size"])).toThrow(
      "--ctx-size requires a value",
    );
  });

  it("throws when the model file does not exist", () => {
    expect(() => runEstimateMemory({ modelPath: join(dir, "missing.gguf") })).toThrow(
      "model file not found",
    );
  });

  it("estimates CPU-only memory and reports split", () => {
    const path = createMinimalGgufFile(dir, {
      blockCount: 8,
      hiddenSize: 512,
      headCount: 8,
      headCountKv: 2,
      fileSizeBytes: 100 * 1024 * 1024,
    });
    const result = runEstimateMemory({ modelPath: path });
    expect(result.estimate.vramBytes).toBe(0);
    expect(result.estimate.ramBytes).toBe(result.estimate.totalBytes);
    expect(result.estimate.split.ramWeightsBytes).toBeGreaterThan(0);
    expect(result.estimate.split.vramWeightsBytes).toBe(0);
  });

  it("reports whether the recipe fits the persisted machine profile", () => {
    const path = createMinimalGgufFile(dir, {
      blockCount: 8,
      hiddenSize: 512,
      headCount: 8,
      headCountKv: 2,
      fileSizeBytes: 100 * 1024 * 1024,
    });
    const profile: MachineInfo = {
      os: "linux",
      cpuCores: 4,
      totalRamBytes: 500 * 1024 * 1024,
    };
    const paths = defaultStorePaths(dir);
    writeMachineInfo(paths, profile);
    const result = runEstimateMemory({ modelPath: path, ctxSize: 100000, paths });
    expect(result.machineFits).toBeDefined();
    expect(result.machineFits!.fits).toBe(false);
    expect(result.machineFits!.maxCtxSize).toBeDefined();
    expect(result.machineFits!.maxCtxSize).toBeLessThan(100000);
  });

  it("prints the estimate without crashing", () => {
    const path = createMinimalGgufFile(dir, {
      blockCount: 8,
      hiddenSize: 512,
      headCount: 8,
      headCountKv: 2,
      fileSizeBytes: 100 * 1024 * 1024,
    });
    const originalWrite = process.stdout.write;
    process.stdout.write = () => true;
    try {
      expect(() => cmdEstimateMemory([path])).not.toThrow();
    } finally {
      process.stdout.write = originalWrite;
    }
  });
});
