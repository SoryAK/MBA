import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  estimateRecipeMemory,
  findMaxFittingCtxSize,
  type GgufRecipeShape,
} from "../service/gguf-memory-estimator.js";
import { defaultStorePaths, type MbaStorePaths } from "../service/config-store.js";
import { readMachineInfo } from "../service/machine-store.js";

interface EstimateMemoryOptions {
  readonly modelPath: string;
  readonly ctxSize?: number;
  readonly gpuLayers?: number;
  readonly batchSize?: number;
  readonly ubatchSize?: number;
  readonly cacheTypeK?: string;
  readonly cacheTypeV?: string;
  readonly flashAttention?: boolean;
  readonly paths?: MbaStorePaths;
}

interface EstimateMemoryResult {
  readonly estimate: NonNullable<ReturnType<typeof estimateRecipeMemory>>;
  readonly recipe: GgufRecipeShape;
  readonly machineFits?: {
    readonly availableRamBytes: number;
    readonly availableVramBytes?: number;
    readonly fits: boolean;
    readonly maxCtxSize?: number;
  };
}

/** Human-readable byte count (B / KiB / MiB / GiB / TiB). */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = n;
  let i = -1;
  do {
    value /= 1024;
    i++;
  } while (value >= 1024 && i < units.length - 1);
  return `${value.toFixed(1)} ${units[i]}`;
}

function parseCliNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.floor(n);
}

export function buildEstimateMemoryRecipe(
  modelPath: string,
  overrides: Partial<GgufRecipeShape>,
): GgufRecipeShape {
  return {
    modelPath,
    ctxSize: overrides.ctxSize ?? 4096,
    gpuLayers: overrides.gpuLayers ?? 0,
    batchSize: overrides.batchSize ?? 2048,
    ubatchSize: overrides.ubatchSize ?? 512,
    cacheTypeK: overrides.cacheTypeK ?? "f16",
    cacheTypeV: overrides.cacheTypeV ?? "f16",
    flashAttention: overrides.flashAttention ?? false,
  };
}

export function runEstimateMemory(opts: EstimateMemoryOptions): EstimateMemoryResult {
  if (!existsSync(opts.modelPath)) {
    throw new Error(`model file not found: ${opts.modelPath}`);
  }

  const recipe = buildEstimateMemoryRecipe(opts.modelPath, opts);
  const estimate = estimateRecipeMemory(recipe);
  if (estimate === undefined) {
    throw new Error(
      "could not estimate memory — the file is missing required GGUF architecture metadata",
    );
  }

  let machineFits: EstimateMemoryResult["machineFits"] | undefined;
  const paths = opts.paths ?? defaultStorePaths();
  const profile = readMachineInfo(paths);
  if (profile !== undefined) {
      const RAM_HEADROOM = 0.85;
      const VRAM_HEADROOM = 0.9;
      const availableRamBytes = Math.floor(profile.totalRamBytes * RAM_HEADROOM);
      const gpuWithVram =
        profile.gpus && profile.gpus.length > 0
          ? profile.gpus.find((g) => g.vramBytes !== undefined && g.vramBytes > 0)
          : undefined;
      const availableVramBytes =
        gpuWithVram?.vramBytes !== undefined
          ? Math.floor(gpuWithVram.vramBytes * VRAM_HEADROOM)
          : undefined;
      const fits =
        estimate.ramBytes <= availableRamBytes &&
        (availableVramBytes === undefined || estimate.vramBytes <= availableVramBytes);
      machineFits = {
        availableRamBytes,
        availableVramBytes,
        fits,
        maxCtxSize: fits
          ? undefined
          : findMaxFittingCtxSize(recipe, availableRamBytes, availableVramBytes, recipe.ctxSize),
      };
    }

  return { estimate, recipe, machineFits };
}

export function parseEstimateMemoryArgs(args: readonly string[]): EstimateMemoryOptions {
  let modelPath: string | undefined;
  let ctxSize: number | undefined;
  let gpuLayers: number | undefined;
  let batchSize: number | undefined;
  let ubatchSize: number | undefined;
  let cacheTypeK: string | undefined;
  let cacheTypeV: string | undefined;
  let flashAttention = false;

  for (let i = 0; i < args.length; i++) {
    const takeArg = (name: string): string => {
      const value = args[++i];
      if (value === undefined) throw new Error(`${name} requires a value`);
      return value;
    };

    const a = args[i];
    if (a === undefined) continue;
    if (a === "--ctx-size" || a === "-c") {
      ctxSize = parseCliNumber(takeArg("--ctx-size"));
    } else if (a === "--gpu-layers" || a === "-ngl") {
      gpuLayers = parseCliNumber(takeArg("--gpu-layers"));
    } else if (a === "--batch-size" || a === "-b") {
      batchSize = parseCliNumber(takeArg("--batch-size"));
    } else if (a === "--ubatch-size" || a === "-ub") {
      ubatchSize = parseCliNumber(takeArg("--ubatch-size"));
    } else if (a === "--cache-type-k") {
      cacheTypeK = takeArg("--cache-type-k");
    } else if (a === "--cache-type-v") {
      cacheTypeV = takeArg("--cache-type-v");
    } else if (a === "--flash-attn") {
      flashAttention = true;
    } else if (a.startsWith("-")) {
      throw new Error(`unknown flag: ${a}`);
    } else if (modelPath === undefined) {
      modelPath = a;
    } else {
      throw new Error(`unexpected positional argument: ${a}`);
    }
  }

  if (!modelPath) {
    throw new Error("usage: mba estimate-memory <model.gguf> [flags]");
  }

  return {
    modelPath: resolve(modelPath),
    ctxSize,
    gpuLayers,
    batchSize,
    ubatchSize,
    cacheTypeK,
    cacheTypeV,
    flashAttention,
  };
}

export function printEstimateMemory(result: EstimateMemoryResult): void {
  const { estimate, recipe, machineFits } = result;

  process.stdout.write(`[mba] estimate for ${recipe.modelPath}\n`);
  process.stdout.write(`[mba] recipe: ctxSize=${recipe.ctxSize}, gpuLayers=${recipe.gpuLayers}, batchSize=${recipe.batchSize}, ubatchSize=${recipe.ubatchSize}, cacheTypeK=${recipe.cacheTypeK}, cacheTypeV=${recipe.cacheTypeV}, flashAttention=${recipe.flashAttention}\n\n`);

  process.stdout.write(`Total:  ${formatBytes(estimate.totalBytes)}\n`);
  process.stdout.write(`RAM:    ${formatBytes(estimate.ramBytes)}\n`);
  process.stdout.write(`VRAM:   ${formatBytes(estimate.vramBytes)}\n\n`);

  process.stdout.write(`Breakdown:\n`);
  process.stdout.write(`  weights:       ${formatBytes(estimate.breakdown.weightsBytes)}\n`);
  process.stdout.write(`  KV cache:      ${formatBytes(estimate.breakdown.kvCacheBytes)}\n`);
  process.stdout.write(`  compute:       ${formatBytes(estimate.breakdown.computeBufferBytes)}\n`);
  process.stdout.write(`  overhead:      ${formatBytes(estimate.breakdown.overheadBytes)}\n\n`);

  process.stdout.write(`RAM/VRAM split:\n`);
  process.stdout.write(`  RAM weights:   ${formatBytes(estimate.split.ramWeightsBytes)}\n`);
  process.stdout.write(`  RAM KV:        ${formatBytes(estimate.split.ramKvCacheBytes)}\n`);
  process.stdout.write(`  RAM compute:   ${formatBytes(estimate.split.ramComputeBufferBytes)}\n`);
  process.stdout.write(`  RAM overhead:  ${formatBytes(estimate.split.ramOverheadBytes)}\n`);
  process.stdout.write(`  VRAM weights:  ${formatBytes(estimate.split.vramWeightsBytes)}\n`);
  process.stdout.write(`  VRAM KV:       ${formatBytes(estimate.split.vramKvCacheBytes)}\n`);
  process.stdout.write(`  VRAM compute:  ${formatBytes(estimate.split.vramComputeBufferBytes)}\n\n`);

  if (machineFits !== undefined) {
    process.stdout.write(`Against persisted machine profile:\n`);
    process.stdout.write(`  available RAM: ${formatBytes(machineFits.availableRamBytes)}\n`);
    if (machineFits.availableVramBytes !== undefined) {
      process.stdout.write(`  available VRAM: ${formatBytes(machineFits.availableVramBytes)}\n`);
    } else {
      process.stdout.write(`  available VRAM: none detected\n`);
    }
    process.stdout.write(`  fits: ${machineFits.fits ? "yes" : "no"}\n`);
    if (machineFits.maxCtxSize !== undefined) {
      process.stdout.write(`  largest ctxSize that fits: ${machineFits.maxCtxSize}\n`);
    }
  }
}

/**
 * `mba estimate-memory <model.gguf>` — local-only memory estimate.
 *
 * Reads the model's GGUF metadata and prints a RAM/VRAM estimate. Optionally
 * compares it against the persisted machine profile and reports the largest
 * context size that fits.
 */
export function cmdEstimateMemory(args: readonly string[]): void {
  const opts = parseEstimateMemoryArgs(args);
  const paths = defaultStorePaths();
  const result = runEstimateMemory({ ...opts, paths });
  printEstimateMemory(result);
}
