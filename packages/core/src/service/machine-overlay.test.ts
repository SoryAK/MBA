import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LLAMA_CPP_DEFAULTS, type ResolvedLlamaFlags } from "../mba/index.js";
import type { MachineInfo } from "./machine-info.js";
import { applyMachineOverlay } from "./machine-overlay.js";

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
    if (entry.type === "uint32") {
      offset += writeString(buf, offset, entry.key);
      buf.writeUInt32LE(4, offset);
      offset += 4;
      offset += writeUint32(buf, offset, entry.value as number);
    } else {
      offset += writeString(buf, offset, entry.key);
      buf.writeUInt32LE(8, offset);
      offset += 4;
      offset += writeString(buf, offset, entry.value as string);
    }
  }
  const fileSize = opts.fileSizeBytes ?? 1024 * 1024 * 1024;
  const final = Buffer.alloc(fileSize);
  buf.copy(final, 0, 0, offset);
  const path = join(dir, "model.gguf");
  writeFileSync(path, final);
  return path;
}

function machine(
  overrides: Partial<MachineInfo> & { totalRamBytes: number; cpuCores: number },
): MachineInfo {
  return {
    os: "linux",
    cpuCores: overrides.cpuCores,
    totalRamBytes: overrides.totalRamBytes,
    gpus: overrides.gpus,
  };
}

function baseFlags(overrides: Partial<ResolvedLlamaFlags> = {}): ResolvedLlamaFlags {
  return { ...LLAMA_CPP_DEFAULTS, ...overrides };
}

describe("applyMachineOverlay", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mba-overlay-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("does not change flags that already fit", () => {
    const model = createMinimalGgufFile(dir, {
      blockCount: 8,
      hiddenSize: 512,
      headCount: 8,
      headCountKv: 2,
      fileSizeBytes: 100 * 1024 * 1024,
    });
    const m = machine({ cpuCores: 8, totalRamBytes: 16 * 1024 * 1024 * 1024 });
    const flags = baseFlags({ ctxSize: 2048, threads: 4, gpuLayers: 0 });
    const result = applyMachineOverlay(flags, model, m);
    expect(result.clampedFits).toBe(true);
    expect(result.originalFits).toBe(true);
    expect(result.annotations).toEqual([]);
    expect(result.flags).toEqual(flags);
  });

  it("clamps threads to CPU core count", () => {
    const model = createMinimalGgufFile(dir, {
      blockCount: 8,
      hiddenSize: 512,
      headCount: 8,
      headCountKv: 2,
      fileSizeBytes: 10 * 1024 * 1024,
    });
    const m = machine({ cpuCores: 4, totalRamBytes: 16 * 1024 * 1024 * 1024 });
    const result = applyMachineOverlay(baseFlags({ threads: 16 }), model, m);
    expect(result.flags.threads).toBe(4);
    expect(result.annotations).toContain("threads clamped from 16 to 4 (CPU cores)");
  });

  it("clamps parallel to CPU core count", () => {
    const model = createMinimalGgufFile(dir, {
      blockCount: 8,
      hiddenSize: 512,
      headCount: 8,
      headCountKv: 2,
      fileSizeBytes: 10 * 1024 * 1024,
    });
    const m = machine({ cpuCores: 6, totalRamBytes: 16 * 1024 * 1024 * 1024 });
    const result = applyMachineOverlay(baseFlags({ parallel: 20 }), model, m);
    expect(result.flags.parallel).toBe(6);
    expect(result.annotations).toContain("parallel clamped from 20 to 6 (CPU cores)");
  });

  it("clamps gpuLayers to 0 when no GPU is detected", () => {
    const model = createMinimalGgufFile(dir, {
      blockCount: 8,
      hiddenSize: 512,
      headCount: 8,
      headCountKv: 2,
      fileSizeBytes: 10 * 1024 * 1024,
    });
    const m = machine({ cpuCores: 8, totalRamBytes: 16 * 1024 * 1024 * 1024, gpus: [] });
    const result = applyMachineOverlay(baseFlags({ gpuLayers: 10 }), model, m);
    expect(result.flags.gpuLayers).toBe(0);
    expect(result.annotations).toContain("gpuLayers clamped to 0 (no GPU detected)");
  });

  it("does not clamp gpuLayers when a GPU with VRAM is detected", () => {
    const model = createMinimalGgufFile(dir, {
      blockCount: 8,
      hiddenSize: 512,
      headCount: 8,
      headCountKv: 2,
      fileSizeBytes: 10 * 1024 * 1024,
    });
    const m = machine({
      cpuCores: 8,
      totalRamBytes: 16 * 1024 * 1024 * 1024,
      gpus: [{ name: "Example GPU", vramBytes: 12 * 1024 * 1024 * 1024 }],
    });
    const result = applyMachineOverlay(baseFlags({ gpuLayers: 10 }), model, m);
    expect(result.flags.gpuLayers).toBe(10);
    expect(result.annotations).not.toContain("gpuLayers clamped to 0 (no GPU detected)");
  });

  it("uses a later GPU with VRAM even if the first GPU lacks VRAM", () => {
    const model = createMinimalGgufFile(dir, {
      blockCount: 8,
      hiddenSize: 512,
      headCount: 8,
      headCountKv: 2,
      fileSizeBytes: 10 * 1024 * 1024,
    });
    const m = machine({
      cpuCores: 8,
      totalRamBytes: 16 * 1024 * 1024 * 1024,
      gpus: [
        { name: "AMD Integrated" }, // no vramBytes
        { name: "Example GPU", vramBytes: 12 * 1024 * 1024 * 1024 },
      ],
    });
    const result = applyMachineOverlay(baseFlags({ gpuLayers: 10 }), model, m);
    expect(result.flags.gpuLayers).toBe(10);
    expect(result.annotations).not.toContain("gpuLayers clamped to 0 (no GPU detected)");
  });

  it("clamps gpuLayers down when weights overflow VRAM but RAM can hold the rest", () => {
    const model = createMinimalGgufFile(dir, {
      blockCount: 32,
      hiddenSize: 512,
      headCount: 8,
      headCountKv: 2,
      fileSizeBytes: 80 * 1024 * 1024,
    });
    const m = machine({
      cpuCores: 8,
      totalRamBytes: 16 * 1024 * 1024 * 1024,
      gpus: [{ name: "Small GPU", vramBytes: 20 * 1024 * 1024 }],
    });
    const result = applyMachineOverlay(baseFlags({ ctxSize: 2048, gpuLayers: 32 }), model, m);
    expect(result.flags.gpuLayers).toBeDefined();
    expect(result.flags.gpuLayers!).toBeLessThan(32);
    expect(result.annotations.some((a) => a.startsWith("gpuLayers clamped from 32"))).toBe(true);
    expect(result.clampedFits).toBe(true);
    expect(result.originalFits).toBe(false);
  });

  it("clamps ctxSize to fit RAM", () => {
    // Small model whose base fits in 300 MB but a 64k context would overflow.
    const model = createMinimalGgufFile(dir, {
      blockCount: 8,
      hiddenSize: 512,
      headCount: 8,
      headCountKv: 2,
      fileSizeBytes: 1 * 1024 * 1024,
    });
    const m = machine({ cpuCores: 4, totalRamBytes: 500 * 1024 * 1024 });
    const result = applyMachineOverlay(baseFlags({ ctxSize: 65536, gpuLayers: 0 }), model, m);
    expect(result.clampedFits).toBe(true);
    expect(result.originalFits).toBe(false);
    expect(result.flags.ctxSize).toBeDefined();
    expect(result.flags.ctxSize).toBeLessThan(65536);
    expect(result.annotations.some((a) => a.startsWith("ctxSize clamped"))).toBe(true);
  });

  it("returns fits:false when the model cannot fit even at ctxSize=1", () => {
    const model = createMinimalGgufFile(dir, {
      blockCount: 32,
      hiddenSize: 4096,
      headCount: 32,
      headCountKv: 8,
      fileSizeBytes: 1 * 1024 * 1024 * 1024,
    });
    const m = machine({ cpuCores: 4, totalRamBytes: 100 * 1024 * 1024 });
    const result = applyMachineOverlay(baseFlags({ ctxSize: 4096, gpuLayers: 0 }), model, m);
    expect(result.clampedFits).toBe(false);
    expect(result.originalFits).toBe(false);
  });

  it("annotates and skips when the model file is missing", () => {
    const m = machine({ cpuCores: 4, totalRamBytes: 16 * 1024 * 1024 * 1024 });
    const flags = baseFlags({ ctxSize: 4096 });
    const result = applyMachineOverlay(flags, "/nonexistent/model.gguf", m);
    expect(result.flags).toEqual(flags);
    expect(result.annotations).toEqual(["model file not found at /nonexistent/model.gguf; overlay skipped"]);
    expect(result.clampedFits).toBe(true);
    expect(result.originalFits).toBe(true);
  });
});
