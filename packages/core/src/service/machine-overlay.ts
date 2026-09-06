/**
 * Machine-aware clamping overlay (ADR-0103).
 *
 * After the 4-rung recipe merge and built-in sanitizer, this layer further
 * reduces `ctxSize`, `gpuLayers`, `threads`, and `parallel` to what the detected
 * host machine can actually provide. It is intentionally conservative: it only
 * *reduces* dials, never increases them, and it never adds a GPU layer count if
 * the recipe left `gpuLayers` undefined.
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
  type GgufRecipeShape,
} from "./gguf-memory-estimator.js";

export interface MachineOverlayResult {
  /** Clamped flags (a shallow merge with the input). */
  readonly flags: ResolvedLlamaFlags;
  /** Human-readable lines explaining every clamp. */
  readonly annotations: readonly string[];
  /**
   * Whether the clamped recipe still fits in the machine. If false, the model
   * cannot run on this machine even at the lowest useful dials.
   */
  readonly fits: boolean;
}

type Writable<T> = { -readonly [P in keyof T]: T[P] };

type ClampedFlags = Writable<Partial<ResolvedLlamaFlags>>;

const RAM_HEADROOM = 0.85; // Leave 15% for OS / other apps.
const VRAM_HEADROOM = 0.9; // Leave 10% for display / driver overhead.

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
    return { flags: { ...flags }, annotations, fits: true };
  }

  const availableRam = Math.floor(machine.totalRamBytes * RAM_HEADROOM);
  const firstGpu = machine.gpus && machine.gpus.length > 0 ? machine.gpus[0] : undefined;
  const availableVram =
    firstGpu !== undefined && firstGpu.vramBytes !== undefined
      ? Math.floor(firstGpu.vramBytes * VRAM_HEADROOM)
      : undefined;

  // --- gpuLayers ---
  if (flags.gpuLayers !== undefined && flags.gpuLayers > 0 && availableVram === undefined) {
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

  // --- ctxSize via memory estimator ---
  const recipeShape = flagsToRecipeShape(modelFile, flags);
  const estimate = estimateRecipeMemory(recipeShape);
  if (estimate === undefined) {
    annotations.push("could not estimate memory from GGUF metadata; ctxSize not clamped");
  } else if (estimate.ramBytes > availableRam || (availableVram !== undefined && estimate.vramBytes > availableVram)) {
    const maxCtx = findMaxFittingCtxSize(
      { ...recipeShape, gpuLayers: clamped.gpuLayers ?? flags.gpuLayers ?? 0 },
      availableRam,
      availableVram,
      flags.ctxSize,
    );
    if (maxCtx === undefined || maxCtx < 1) {
      annotations.push("model does not fit in available RAM/VRAM even with ctxSize=1");
      return { flags: { ...flags, ...clamped }, annotations, fits: false };
    }
    if (flags.ctxSize === undefined || maxCtx < flags.ctxSize) {
      const original = flags.ctxSize ?? "default";
      clamped.ctxSize = maxCtx;
      annotations.push(`ctxSize clamped from ${original} to ${maxCtx} to fit RAM/VRAM`);
    }
  }

  return {
    flags: { ...flags, ...clamped },
    annotations,
    fits: true,
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
    cacheTypeK: "f16",
    cacheTypeV: "f16",
    flashAttention: flags.flashAttn === "on",
  };
}
