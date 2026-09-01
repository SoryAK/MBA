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
export const LLAMA_CPP_DEFAULTS: ResolvedLlamaFlags = {
  ctxSize: 100000,
  gpuLayers: 100,
  threads: 8,
  parallel: 1,
  cacheReuse: 150,
  cacheRam: 9500,
  reasoningBudget: 512,
  reasoningPreserve: true,
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

/**
 * The llama.cpp flags MBA manages itself (emitted by `buildLlamaServerFlags`).
 * Single source of truth for the `extraArgs` conflict guard (ADR-0100): a user
 * who puts one of these in `extraArgs` is fighting a typed field, so the boot
 * is rejected rather than letting two values race for the same flag.
 */
export const MANAGED_LLAMA_FLAGS: ReadonlySet<string> = new Set([
  "ctx-size",
  "ngl",
  "threads",
  "jinja",
  "parallel",
  "cache-reuse",
  "cache-ram",
  "reasoning-budget",
  "reasoning-preserve",
  "flash-attn",
  "ctk",
  "ctv",
  "spec-type",
  "spec-draft-n-max",
]);

/** Thrown when `extraArgs` collides with a flag MBA already manages. */
export class LlamaFlagConflictError extends Error {}

/** A fully-populated flag set: every managed field present, `extraArgs` optional. */
type ResolvedLlamaFlags = Required<Omit<LlamaCppServerFlags, "extraArgs">> & {
  readonly extraArgs?: Record<string, string | number | boolean>;
};

/** Mutable form of {@link ResolvedLlamaFlags} for the sanitize accumulator. */
type MutableResolvedLlamaFlags = {
  -readonly [K in keyof ResolvedLlamaFlags]: ResolvedLlamaFlags[K];
};

export interface SanitizedLlamaCppFlags {
  /** Fully-populated, in-range flag set ready for the boot path. */
  readonly flags: ResolvedLlamaFlags;
  /** Keys whose raw value had the wrong type and fell back to defaults. */
  readonly dropped: readonly string[];
  /** Keys whose raw value was out of range and got clamped. */
  readonly clamped: readonly string[];
  /**
   * `extraArgs` keys that collide with a flag MBA manages (ADR-0100). Reported,
   * not thrown — `buildLlamaServerFlags` is the enforcement point that rejects
   * the boot. Empty when there is no conflict.
   */
  readonly conflicts: readonly string[];
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
  const conflicts: string[] = [];
  const source =
    typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};

  const flags: MutableResolvedLlamaFlags = { ...LLAMA_CPP_DEFAULTS };

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

  const reasoningPreserve = source["reasoningPreserve"];
  if (reasoningPreserve !== undefined) {
    if (typeof reasoningPreserve === "boolean") {
      flags.reasoningPreserve = reasoningPreserve;
    } else {
      dropped.push("reasoningPreserve");
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

  // extraArgs (ADR-0100): an open-ended map of llama.cpp flags MBA does not
  // manage. Shape-only validation here (the `--help` cross-check is a
  // fast-follow); a managed-flag collision is REPORTED, not thrown — the boot
  // path (`buildLlamaServerFlags`) is the enforcement point.
  const extraRaw = source["extraArgs"];
  if (extraRaw !== undefined) {
    if (typeof extraRaw === "object" && extraRaw !== null && !Array.isArray(extraRaw)) {
      const extra: Record<string, string | number | boolean> = {};
      for (const [key, value] of Object.entries(extraRaw as Record<string, unknown>)) {
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
          extra[key] = value;
        } else {
          dropped.push(`extraArgs.${key}`);
        }
      }
      flags.extraArgs = extra;
      for (const key of Object.keys(extra)) {
        if (MANAGED_LLAMA_FLAGS.has(key)) conflicts.push(key);
      }
    } else {
      dropped.push("extraArgs");
    }
  }

  return { flags, dropped, clamped, conflicts };
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
export function buildLlamaServerFlags(flags: ResolvedLlamaFlags): string[] {
  // Reject a recipe whose extraArgs collides with a flag MBA manages (ADR-0100).
  // Failing here — before the process is spawned — keeps the boot error precise
  // instead of letting llama-server die on a duplicate flag.
  const conflicts = flags.extraArgs
    ? Object.keys(flags.extraArgs).filter((k) => MANAGED_LLAMA_FLAGS.has(k))
    : [];
  if (conflicts.length > 0) {
    throw new LlamaFlagConflictError(
      `extraArgs collides with a flag MBA manages: ${conflicts.join(", ")} — ` +
        `set it via the matching typed field instead (e.g. ctxSize, gpuLayers, flashAttn)`,
    );
  }

  const args: string[] = [];

  args.push("--ctx-size", String(flags.ctxSize));
  args.push("-ngl", String(flags.gpuLayers));
  args.push("--threads", String(flags.threads));
  // --jinja: always on (boot script parity) — enables chat-template rendering.
  args.push("--jinja");
  args.push("--parallel", String(flags.parallel));
  args.push("--cache-reuse", String(flags.cacheReuse));
  args.push("--cache-ram", String(flags.cacheRam));
  args.push("--reasoning-budget", String(flags.reasoningBudget));
  // --reasoning-preserve: on by default (boot script default), omitted when disabled.
  if (flags.reasoningPreserve) {
    args.push("--reasoning-preserve");
  }
  args.push("--flash-attn", flags.flashAttn);
  // KV cache quantization: always q8_0 (boot script parity).
  args.push("-ctk", "q8_0");
  args.push("-ctv", "q8_0");

  // Only add spec flags if specType is not "none"
  if (flags.specType !== "none") {
    args.push("--spec-type", flags.specType);
    args.push("--spec-draft-n-max", String(flags.specDraftMax));
  }

  // Open-ended extraArgs (ADR-0100): appended AFTER the managed flags. A
  // boolean true emits a bare flag; false omits it; string/number emit
  // `--key value`. Conflicts were already rejected above.
  if (flags.extraArgs) {
    for (const [key, value] of Object.entries(flags.extraArgs)) {
      if (value === false) continue;
      if (value === true) {
        args.push(`--${key}`);
      } else {
        args.push(`--${key}`, String(value));
      }
    }
  }

  return args;
}
