import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LLAMA_CPP_DEFAULTS, type ResolvedLlamaFlags } from "../mba/index.js";
import type { MachineInfo } from "./machine-info.js";
import { applyMachineOverlay } from "./machine-overlay.js";
import { writeMinimalGguf } from "../test-support/minimal-gguf.js";

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
  const path = join(dir, "model.gguf");
  writeMinimalGguf(path, {
    ...opts,
    fileSizeBytes: opts.fileSizeBytes ?? 1024 * 1024 * 1024,
  });
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

  it("keeps gpuLayers on a named GPU that has no VRAM figure (unified memory)", () => {
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
      gpus: [{ name: "AMD Strix Halo" }],
    });
    const result = applyMachineOverlay(baseFlags({ gpuLayers: 10, ctxSize: 2048 }), model, m);
    expect(result.flags.gpuLayers).toBe(10);
    expect(result.annotations).not.toContain("gpuLayers clamped to 0 (no GPU detected)");
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

  it("on unified memory clamps ctxSize against host RAM total, not gpuLayers", () => {
    const model = createMinimalGgufFile(dir, {
      blockCount: 8,
      hiddenSize: 512,
      headCount: 8,
      headCountKv: 2,
      fileSizeBytes: 1 * 1024 * 1024,
    });
    const m = machine({
      cpuCores: 4,
      totalRamBytes: 500 * 1024 * 1024,
      gpus: [{ name: "AMD Strix Halo" }],
    });
    const result = applyMachineOverlay(baseFlags({ ctxSize: 65536, gpuLayers: 8 }), model, m);
    expect(result.flags.gpuLayers).toBe(8);
    expect(result.flags.ctxSize).toBeDefined();
    expect(result.flags.ctxSize).toBeLessThan(65536);
    expect(result.annotations.some((a) => a.startsWith("ctxSize clamped"))).toBe(true);
    expect(result.clampedFits).toBe(true);
  });

  it("on UMA carve-out keeps layers and still budgets ctxSize against host RAM", () => {
    const model = createMinimalGgufFile(dir, {
      blockCount: 8,
      hiddenSize: 512,
      headCount: 8,
      headCountKv: 2,
      fileSizeBytes: 1 * 1024 * 1024,
    });
    const ramOnly = machine({
      cpuCores: 4,
      totalRamBytes: 500 * 1024 * 1024,
      gpus: [{ name: "AMD Strix Halo" }],
    });
    const withCarveOut = machine({
      cpuCores: 4,
      totalRamBytes: 500 * 1024 * 1024,
      gpus: [
        {
          name: "AMD Strix Halo",
          vramBytes: 8 * 1024 * 1024 * 1024,
          vramSource: "uma",
        },
      ],
    });
    const flags = baseFlags({ ctxSize: 65536, gpuLayers: 8 });
    const starved = applyMachineOverlay(flags, model, ramOnly);
    const uma = applyMachineOverlay(flags, model, withCarveOut);
    expect(starved.flags.gpuLayers).toBe(8);
    expect(starved.flags.ctxSize).toBeLessThan(65536);
    expect(uma.flags.gpuLayers).toBe(8);
    expect(uma.flags.ctxSize).toBe(starved.flags.ctxSize);
    expect(uma.annotations).not.toContain("gpuLayers clamped to 0 (no GPU detected)");
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
