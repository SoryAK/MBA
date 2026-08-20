/**
 * Server boot flag contract for MBA adapters.
 *
 * Single source of truth for the per-model "server recipe":
 *  - `LLAMA_CPP_DEFAULTS` — fallback values, mirroring scripts/llama-server-up.sh.
 *  - `LLAMA_CPP_RANGES` — the whitelist. The boot path refuses to emit a flag
 *    outside its range, so a bad or malicious adapter value can never become
 *    an out-of-bounds server argument.
 *  - `sanitizeLlamaCppServerFlags` — resolves a raw (untrusted) recipe into a
 *    fully-populated, in-range flag set.
 *
 * Pure module: no file access, no process spawn, no logging. Translating the
 * resolved flags into an actual command-line array is a separate concern.
 */
import type { LlamaCppServerFlags } from "./types.js";

/** Default llama.cpp boot flags. Mirror scripts/llama-server-up.sh defaults. */
export const LLAMA_CPP_DEFAULTS: Required<LlamaCppServerFlags> = {
  ctxSize: 100000,
  gpuLayers: 100,
  threads: 8,
  parallel: 1,
  cacheReuse: 150,
  cacheRam: 9500,
  reasoningBudget: 512,
  flashAttn: "on",
  warmupTokens: 350,
  specType: "none",
  specDraftMax: 2,
};

/**
 * Allowed ranges for each numeric llama.cpp flag. Integer-valued flags only;
 * `flashAttn` is validated against `FLASH_ATTN_VALUES` instead.
 * `specType` is validated against allowed strings instead.
 */
export const LLAMA_CPP_RANGES = {
  ctxSize: { min: 512, max: 1_000_000 },
  gpuLayers: { min: 0, max: 999 },
  threads: { min: 1, max: 512 },
  parallel: { min: 1, max: 64 },
  cacheReuse: { min: 0, max: 1_000_000 },
  cacheRam: { min: 0, max: 1_000_000 },
  reasoningBudget: { min: 0, max: 1_000_000 },
  warmupTokens: { min: 0, max: 100_000 },
  specDraftMax: { min: 1, max: 128 },
} as const;

export type LlamaCppNumericFlag = keyof typeof LLAMA_CPP_RANGES;

export const FLASH_ATTN_VALUES = ["on", "off"] as const;

export interface SanitizedLlamaCppFlags {
  /** Fully-populated, in-range flag set ready for the boot path. */
  readonly flags: Required<LlamaCppServerFlags>;
  /** Keys whose raw value had the wrong type and fell back to defaults. */
  readonly dropped: readonly string[];
  /** Keys whose raw value was out of range and got clamped. */
  readonly clamped: readonly string[];
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Validate + resolve a raw llama.cpp flag recipe into a fully-populated,
 * in-range flag set.
 *
 * Rules:
 *  - non-object input → all defaults, no reports.
 *  - omitted key → default.
 *  - wrong type (including null / NaN) → default, key reported in `dropped`.
 *  - out-of-range number → clamped to range, key reported in `clamped`.
 *  - fractional number → truncated (not reported; it is still in-range input).
 *  - unknown keys → ignored (forward-compat with future knobs).
 */
export function sanitizeLlamaCppServerFlags(
  raw: unknown,
): SanitizedLlamaCppFlags {
  const dropped: string[] = [];
  const clamped: string[] = [];
  const source =
    typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};

  const flags = { ...LLAMA_CPP_DEFAULTS };

  for (const key of Object.keys(LLAMA_CPP_RANGES) as LlamaCppNumericFlag[]) {
    const range = LLAMA_CPP_RANGES[key];
    const value = source[key];
    if (value === undefined) continue;
    if (!isFiniteNumber(value)) {
      dropped.push(key);
      continue;
    }
    const truncated = Math.trunc(value);
    if (truncated < range.min || truncated > range.max) {
      clamped.push(key);
      flags[key] = Math.max(range.min, Math.min(range.max, truncated));
    } else {
      flags[key] = truncated;
    }
  }

  const flashAttn = source["flashAttn"];
  if (flashAttn !== undefined) {
    if (typeof flashAttn === "string" && (FLASH_ATTN_VALUES as readonly string[]).includes(flashAttn)) {
      flags.flashAttn = flashAttn as "on" | "off";
    } else {
      dropped.push("flashAttn");
    }
  }

  const specType = source["specType"];
  if (specType !== undefined) {
    if (typeof specType === "string") {
      flags.specType = specType;
    } else {
      dropped.push("specType");
    }
  }

  return { flags, dropped, clamped };
}

/**
 * Translate a fully-populated llama.cpp flag recipe into CLI arguments.
 * Maps each recipe field to its corresponding --flag or -short form.
 * Conditional flags (e.g. speculative decoding) are only added when their guard is met.
 *
 * @example
 * buildLlamaServerFlags({
 *   ctxSize: 100000,
 *   gpuLayers: 100,
 *   specType: "draft-mtp",
 *   specDraftMax: 2,
 *   flashAttn: "on",
 *   ...
 * })
 * // →  ["--ctx-size", "100000", "-ngl", "100", "--flash-attn", "on", "--spec-type", "draft-mtp", ...]
 */
export function buildLlamaServerFlags(flags: Required<LlamaCppServerFlags>): string[] {
  const args: string[] = [];

  args.push("--ctx-size", String(flags.ctxSize));
  args.push("-ngl", String(flags.gpuLayers));
  args.push("--threads", String(flags.threads));
  args.push("--parallel", String(flags.parallel));
  args.push("--cache-reuse", String(flags.cacheReuse));
  args.push("--cache-ram", String(flags.cacheRam));
  args.push("--reasoning-budget", String(flags.reasoningBudget));
  args.push("--flash-attn", flags.flashAttn);

  // Only add spec flags if specType is not "none"
  if (flags.specType !== "none") {
    args.push("--spec-type", flags.specType);
    args.push("--spec-draft-n-max", String(flags.specDraftMax));
  }

  return args;
}
