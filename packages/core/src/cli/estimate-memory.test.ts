import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdEstimateMemory, parseEstimateMemoryArgs, runEstimateMemory } from "./estimate-memory.js";
import { defaultStorePaths } from "../service/config-store.js";
import { writeMachineInfo } from "../service/machine-store.js";
import type { MachineInfo } from "../service/machine-info.js";
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
  writeMinimalGguf(path, opts);
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

  it("budgets a UMA recipe against host RAM without adding the carve-out", () => {
    const path = createMinimalGgufFile(dir, {
      blockCount: 8,
      hiddenSize: 512,
      headCount: 8,
      headCountKv: 2,
      fileSizeBytes: 100 * 1024 * 1024,
    });
    const paths = defaultStorePaths(dir);
    const hostRam = 500 * 1024 * 1024;
    const nameOnly: MachineInfo = {
      os: "linux",
      cpuCores: 4,
      totalRamBytes: hostRam,
      gpus: [{ name: "AMD APU" }],
    };
    writeMachineInfo(paths, nameOnly);
    const withoutCarveOut = runEstimateMemory({
      modelPath: path,
      ctxSize: 100000,
      gpuLayers: 8,
      paths,
    });

    writeMachineInfo(paths, {
      ...nameOnly,
      gpus: [
        {
          name: "AMD APU",
          vramBytes: 64 * 1024 * 1024 * 1024,
          vramSource: "uma",
        },
      ],
    });
    const withCarveOut = runEstimateMemory({
      modelPath: path,
      ctxSize: 100000,
      gpuLayers: 8,
      paths,
    });

    expect(withCarveOut.estimate.vramBytes).toBeGreaterThan(0);
    expect(withoutCarveOut.machineFits?.availableVramBytes).toBeUndefined();
    expect(withCarveOut.machineFits?.availableVramBytes).toBeUndefined();
    expect(withCarveOut.machineFits?.fits).toBe(false);
    expect(withCarveOut.machineFits?.maxCtxSize).toBe(withoutCarveOut.machineFits?.maxCtxSize);
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
