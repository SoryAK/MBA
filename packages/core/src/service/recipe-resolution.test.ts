import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveRecipe } from "./recipe-resolution.js";
import type { MachineInfo } from "./machine-info.js";
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

function writeMinimalAdapter(adapterDir: string, id: string, modelFile: string): void {
  const dir = join(adapterDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${id}.yaml`),
    [
      "apiVersion: mba.ai/v1alpha1",
      "kind: ModelBehavioralAdapter",
      "metadata:",
      `  id: ${id}`,
      "identity:",
      "  model:",
      `    name: ${id}`,
      `    file: "${modelFile}"`,
      "bindings: {}",
    ].join("\n"),
  );
  writeFileSync(
    join(dir, "server_setup.json"),
    JSON.stringify({ "llama.cpp": { ctxSize: 100000 } }),
  );
}

const SMALL_MACHINE: MachineInfo = {
  os: "linux",
  cpuCores: 4,
  totalRamBytes: 500 * 1024 * 1024, // 500 MB — fits a smaller ctxSize, but not 100k.
};

describe("resolveRecipe machine overlay modes", () => {
  let tmp: string;
  let adapterDir: string;
  let modelFile: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "mba-recipe-resolution-"));
    adapterDir = join(tmp, "adapters");
    modelFile = createMinimalGgufFile(tmp, {
      blockCount: 8,
      hiddenSize: 512,
      headCount: 8,
      headCountKv: 2,
      fileSizeBytes: 1 * 1024 * 1024,
    });
    writeMinimalAdapter(adapterDir, "test", modelFile);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("clamps ctxSize in enforce mode", () => {
    const recipe = resolveRecipe(
      modelFile,
      adapterDir,
      { harness: "copilot", ide: "vscode", serverRuntime: "llamacpp" },
      { machineInfo: SMALL_MACHINE, machineOverlay: "enforce" },
    );
    expect(recipe.flags.ctxSize).toBeLessThan(100000);
    expect(recipe.annotations.length).toBeGreaterThan(0);
    expect(recipe.fitsMachine).toBe(true);
  });

  it("keeps the original ctxSize in warn mode but still reports annotations", () => {
    const recipe = resolveRecipe(
      modelFile,
      adapterDir,
      { harness: "copilot", ide: "vscode", serverRuntime: "llamacpp" },
      { machineInfo: SMALL_MACHINE, machineOverlay: "warn" },
    );
    expect(recipe.flags.ctxSize).toBe(100000);
    expect(recipe.annotations.length).toBeGreaterThan(0);
    expect(recipe.fitsMachine).toBe(false);
  });

  it("skips the overlay entirely in off mode", () => {
    const recipe = resolveRecipe(
      modelFile,
      adapterDir,
      { harness: "copilot", ide: "vscode", serverRuntime: "llamacpp" },
      { machineInfo: SMALL_MACHINE, machineOverlay: "off" },
    );
    expect(recipe.flags.ctxSize).toBe(100000);
    expect(recipe.annotations).toEqual([]);
    expect(recipe.fitsMachine).toBe(true);
  });

  it("defaults to enforce mode when no overlay option is provided", () => {
    const recipe = resolveRecipe(
      modelFile,
      adapterDir,
      { harness: "copilot", ide: "vscode", serverRuntime: "llamacpp" },
      { machineInfo: SMALL_MACHINE },
    );
    expect(recipe.flags.ctxSize).toBeLessThan(100000);
    expect(recipe.annotations.length).toBeGreaterThan(0);
  });

  it("does nothing when no machine info is provided", () => {
    const recipe = resolveRecipe(modelFile, adapterDir, {
      harness: "copilot",
      ide: "vscode",
      serverRuntime: "llamacpp",
    });
    expect(recipe.flags.ctxSize).toBe(100000);
    expect(recipe.annotations).toEqual([]);
    expect(recipe.fitsMachine).toBe(true);
  });
});
