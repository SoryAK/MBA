/**
 * Machine-aware clamping overlay (ADR-0103).
 *
 * After the 4-rung recipe merge and built-in sanitizer, this layer further
 * reduces `ctxSize`, `gpuLayers`, `threads`, and `parallel` to what the detected
 * host machine can actually provide. It is intentionally conservative: it only
 * *reduces* dials, never increases them, and it never adds a GPU layer count if
 * the recipe left `gpuLayers` undefined.
 *
 * GPU memory: **none** (empty `gpus` → layers 0), **discrete** (`vramBytes`
 * without `vramSource: "uma"` → clamp layers to that VRAM), **unified**
 * (named GPU, including Linux APU `vramSource: "uma"`) → keep layers; fit
 * `totalBytes` against host RAM only. A UMA figure is recorded, not added
 * to the budget — BIOS caps (e.g. 96 GB of 128 GB) are firmware, not MBA.
 *
 * The overlay is a separate step so the same recipe resolution chain can be run
 * with or without machine info (e.g., the `resolve-server-recipe` CLI does not
 * need to read `machine.json`).
 */

import { existsSync } from "node:fs";
import type { ResolvedLlamaFlags } from "../mba/index.js";
import type { MachineInfo } from "./machine-info.js";
import {
  estimateRecipeMemory,
  findMaxFittingCtxSize,
  findMaxFittingGpuLayers,
  type GgufRecipeShape,
} from "./gguf-memory-estimator.js";
import { parseGgufMetadata } from "../model/gguf-metadata.js";

export interface MachineOverlayResult {
  /** Clamped flags (a shallow merge with the input). */
  readonly flags: ResolvedLlamaFlags;
  /** Human-readable lines explaining every clamp. */
  readonly annotations: readonly string[];
  /** Whether the original, unclamped recipe fits the machine. */
  readonly originalFits: boolean;
  /** Whether the returned clamped recipe fits the machine. */
  readonly clampedFits: boolean;
}

type Writable<T> = { -readonly [P in keyof T]: T[P] };

type ClampedFlags = Writable<Partial<ResolvedLlamaFlags>>;

const RAM_HEADROOM = 0.85; // Leave 15% for OS / other apps.
const VRAM_HEADROOM = 0.9; // Leave 10% for display / driver overhead.

function recipeFits(
  estimate: ReturnType<typeof estimateRecipeMemory>,
  availableRam: number,
  availableVram: number | undefined,
  unified: boolean,
): boolean {
  if (estimate === undefined) return false;
  if (unified) {
    // APU / unified: keep layers, budget the whole recipe against host RAM.
    // Do not add a BIOS UMA carve-out — that cap is firmware, not overlay policy.
    return estimate.totalBytes <= availableRam;
  }
  const fitsRam = estimate.ramBytes <= availableRam;
  // If the recipe needs any VRAM but the machine has no usable GPU, it does
  // not fit, even when the RAM-only check passes.
  if (estimate.vramBytes > 0 && availableVram === undefined) return false;
  const fitsVram = availableVram === undefined || estimate.vramBytes <= availableVram;
  return fitsRam && fitsVram;
}

/**
 * Discrete VRAM (nvidia-smi / `vramBytes` without uma) vs APU / name-only.
 * A UMA carve-out is still unified: keep layers, do not clamp to that figure.
 */
export function gpuMemoryKind(machine: MachineInfo): "none" | "discrete" | "unified" {
  const gpus = machine.gpus ?? [];
  if (gpus.length === 0) return "none";
  const hasDiscrete = gpus.some(
    (g) => g.vramSource !== "uma" && g.vramBytes !== undefined && g.vramBytes > 0,
  );
  if (hasDiscrete) return "discrete";
  return "unified";
}

function modelBlockCount(modelFile: string): number | undefined {
  try {
    const meta = parseGgufMetadata(modelFile);
    const arch = meta.fields["general.architecture"];
    if (typeof arch !== "string" || arch.length === 0) return undefined;
    const n = meta.fields[`${arch}.block_count`];
    return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Clamp a llama.cpp recipe to the host machine. Missing fields are left
 * missing; the caller (sanitizer) applies defaults later.
 */
export function applyMachineOverlay(
  flags: ResolvedLlamaFlags,
  modelFile: string,
  machine: MachineInfo,
): MachineOverlayResult {
  const annotations: string[] = [];
  const clamped: ClampedFlags = {};

  if (!existsSync(modelFile)) {
    annotations.push(`model file not found at ${modelFile}; overlay skipped`);
    return { flags: { ...flags }, annotations, originalFits: true, clampedFits: true };
  }

  const kind = gpuMemoryKind(machine);
  const unified = kind === "unified";
  const availableRam = Math.floor(machine.totalRamBytes * RAM_HEADROOM);
  const gpuWithVram =
    kind === "discrete" && machine.gpus
      ? machine.gpus.find((g) => g.vramBytes !== undefined && g.vramBytes > 0)
      : undefined;
  const availableVram =
    gpuWithVram !== undefined && gpuWithVram.vramBytes !== undefined
      ? Math.floor(gpuWithVram.vramBytes * VRAM_HEADROOM)
      : undefined;

  // --- gpuLayers ---
  // Named GPU without a VRAM figure is unified memory, not "no GPU".
  if (flags.gpuLayers !== undefined && flags.gpuLayers > 0 && kind === "none") {
    clamped.gpuLayers = 0;
    annotations.push(`gpuLayers clamped to 0 (no GPU detected)`);
  }

  // --- threads ---
  if (flags.threads !== undefined && flags.threads > machine.cpuCores) {
    clamped.threads = machine.cpuCores;
    annotations.push(`threads clamped from ${flags.threads} to ${machine.cpuCores} (CPU cores)`);
  }

  // --- parallel ---
  if (flags.parallel !== undefined && flags.parallel > machine.cpuCores) {
    clamped.parallel = machine.cpuCores;
    annotations.push(`parallel clamped from ${flags.parallel} to ${machine.cpuCores} (CPU cores)`);
  }

  // --- gpuLayers / ctxSize via memory estimator ---
  // Apply non-memory clamps first, then fit VRAM (layers) before RAM (context).
  // Shrinking ctx cannot fix weights that already overflow VRAM at -ngl 100.
  const originalRecipeShape = flagsToRecipeShape(modelFile, flags);
  const originalEstimate = estimateRecipeMemory(originalRecipeShape);
  const originalFits = recipeFits(originalEstimate, availableRam, availableVram, unified);

  const afterCpu: ResolvedLlamaFlags = { ...flags, ...clamped };
  const afterCpuShape = flagsToRecipeShape(modelFile, afterCpu);
  const afterCpuEstimate = estimateRecipeMemory(afterCpuShape);

  if (originalEstimate === undefined || afterCpuEstimate === undefined) {
    annotations.push("could not estimate memory from GGUF metadata; ctxSize/gpuLayers not clamped");
  } else {
    if (
      availableVram !== undefined &&
      afterCpu.gpuLayers !== undefined &&
      afterCpu.gpuLayers > 0 &&
      !recipeFits(afterCpuEstimate, availableRam, availableVram, unified)
    ) {
      const blocks = modelBlockCount(modelFile);
      const ceiling = blocks !== undefined ? Math.min(afterCpu.gpuLayers, blocks) : afterCpu.gpuLayers;
      const maxNgl = findMaxFittingGpuLayers(afterCpuShape, availableRam, availableVram, ceiling);
      if (maxNgl === undefined) {
        annotations.push("could not estimate GPU layers from GGUF metadata; gpuLayers not clamped");
      } else if (maxNgl < afterCpu.gpuLayers) {
        clamped.gpuLayers = maxNgl;
        annotations.push(
          `gpuLayers clamped from ${afterCpu.gpuLayers} to ${maxNgl} to fit VRAM`,
        );
      }
    }

    const afterNgl: ResolvedLlamaFlags = { ...flags, ...clamped };
    const afterNglShape = flagsToRecipeShape(modelFile, afterNgl);
    const afterNglEstimate = estimateRecipeMemory(afterNglShape);
    if (afterNglEstimate !== undefined && !recipeFits(afterNglEstimate, availableRam, availableVram, unified)) {
      const maxCtx = findMaxFittingCtxSize(afterNglShape, availableRam, availableVram, flags.ctxSize, {
        unified,
      });
      if (maxCtx === undefined || maxCtx < 1) {
        annotations.push("model does not fit in available RAM/VRAM even with ctxSize=1");
      } else if (flags.ctxSize === undefined || maxCtx < flags.ctxSize) {
        const original = flags.ctxSize ?? "default";
        clamped.ctxSize = maxCtx;
        annotations.push(`ctxSize clamped from ${original} to ${maxCtx} to fit RAM/VRAM`);
      }
    }
  }

  const clampedFlags: ResolvedLlamaFlags = { ...flags, ...clamped };
  const clampedEstimate = estimateRecipeMemory(flagsToRecipeShape(modelFile, clampedFlags));
  const clampedFits = recipeFits(clampedEstimate, availableRam, availableVram, unified);

  return {
    flags: clampedFlags,
    annotations,
    originalFits,
    clampedFits,
  };
}

/**
 * Convert a LlamaCppServerFlags object into the estimator's recipe shape. This
 * is a best-effort mapping; values that are not in the estimator's vocabulary
 * (e.g., `--flash-attn`) are ignored.
 */
function flagsToRecipeShape(
  modelPath: string,
  flags: ResolvedLlamaFlags,
): GgufRecipeShape {
  return {
    modelPath,
    ctxSize: flags.ctxSize,
    gpuLayers: flags.gpuLayers,
    batchSize: 2048,
    ubatchSize: 512,
    cacheTypeK: "q8_0",
    cacheTypeV: "q8_0",
    flashAttention: flags.flashAttn === "on",
  };
}
