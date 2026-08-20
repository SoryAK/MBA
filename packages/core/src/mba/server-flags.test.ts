/**
 * Contract tests for the MBA server-boot flag recipe (Step 1 of the
 * per-model server config plan).
 *
 * The contract under test:
 *  - `LLAMA_CPP_DEFAULTS` mirrors scripts/llama-server-up.sh defaults.
 *  - `sanitizeLlamaCppServerFlags` resolves a raw (untrusted) recipe into a
 *    fully-populated, in-range flag set: omitted → default, out-of-range →
 *    clamped (reported), wrong type → dropped (reported), unknown keys →
 *    ignored (forward-compat).
 */
import { describe, expect, it } from "vitest";
import {
  FLASH_ATTN_VALUES,
  LLAMA_CPP_DEFAULTS,
  LLAMA_CPP_RANGES,
  sanitizeLlamaCppServerFlags,
  buildLlamaServerFlags,
  type LlamaCppNumericFlag,
} from "./server-flags.js";

describe("LLAMA_CPP_DEFAULTS", () => {
  it("mirrors the llama-server-up.sh defaults", () => {
    expect(LLAMA_CPP_DEFAULTS).toEqual({
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
    });
  });

  it("every default sits inside its own range", () => {
    for (const key of Object.keys(LLAMA_CPP_RANGES) as LlamaCppNumericFlag[]) {
      const range = LLAMA_CPP_RANGES[key];
      const value = LLAMA_CPP_DEFAULTS[key];
      expect(value, `default ${key} out of range`).toBeGreaterThanOrEqual(range.min);
      expect(value, `default ${key} out of range`).toBeLessThanOrEqual(range.max);
    }
  });
});

describe("sanitizeLlamaCppServerFlags", () => {
  it("returns all defaults for undefined input", () => {
    const { flags, dropped, clamped } = sanitizeLlamaCppServerFlags(undefined);
    expect(flags).toEqual(LLAMA_CPP_DEFAULTS);
    expect(dropped).toEqual([]);
    expect(clamped).toEqual([]);
  });

  it("returns all defaults for non-object input", () => {
    const { flags, dropped, clamped } = sanitizeLlamaCppServerFlags("oops");
    expect(flags).toEqual(LLAMA_CPP_DEFAULTS);
    expect(dropped).toEqual([]);
    expect(clamped).toEqual([]);
  });

  it("fills omitted fields from defaults", () => {
    const { flags, dropped, clamped } = sanitizeLlamaCppServerFlags({ ctxSize: 64000 });
    expect(flags.ctxSize).toBe(64000);
    expect(flags.gpuLayers).toBe(LLAMA_CPP_DEFAULTS.gpuLayers);
    expect(flags.flashAttn).toBe("on");
    expect(dropped).toEqual([]);
    expect(clamped).toEqual([]);
  });

  it("clamps out-of-range values and reports them", () => {
    const { flags, clamped } = sanitizeLlamaCppServerFlags({
      ctxSize: 99_999_999,
      threads: 0,
    });
    expect(flags.ctxSize).toBe(LLAMA_CPP_RANGES.ctxSize.max);
    expect(flags.threads).toBe(LLAMA_CPP_RANGES.threads.min);
    expect([...clamped].sort()).toEqual(["ctxSize", "threads"]);
  });

  it("truncates fractional numbers to integers", () => {
    const { flags, clamped } = sanitizeLlamaCppServerFlags({ ctxSize: 64000.9 });
    expect(flags.ctxSize).toBe(64000);
    expect(clamped).toEqual([]);
  });

  it("drops wrong-typed values and falls back to defaults", () => {
    const { flags, dropped } = sanitizeLlamaCppServerFlags({
      ctxSize: "big",
      flashAttn: "maybe",
      gpuLayers: null,
    });
    expect(flags.ctxSize).toBe(LLAMA_CPP_DEFAULTS.ctxSize);
    expect(flags.flashAttn).toBe("on");
    expect(flags.gpuLayers).toBe(LLAMA_CPP_DEFAULTS.gpuLayers);
    expect([...dropped].sort()).toEqual(["ctxSize", "flashAttn", "gpuLayers"]);
  });

  it("accepts only the whitelisted flashAttn values", () => {
    for (const value of FLASH_ATTN_VALUES) {
      expect(sanitizeLlamaCppServerFlags({ flashAttn: value }).flags.flashAttn).toBe(value);
    }
  });

  it("ignores unknown keys (forward-compat)", () => {
    const { flags, dropped, clamped } = sanitizeLlamaCppServerFlags({
      ctxSize: 32000,
      someFutureKnob: 42,
    });
    expect(flags.ctxSize).toBe(32000);
    expect(dropped).toEqual([]);
    expect(clamped).toEqual([]);
  });

  it("sanitizes specType (string, preserved as-is)", () => {
    const { flags } = sanitizeLlamaCppServerFlags({ specType: "draft-mtp" });
    expect(flags.specType).toBe("draft-mtp");
  });

  it("drops invalid specType (non-string)", () => {
    const { flags, dropped } = sanitizeLlamaCppServerFlags({ specType: 123 });
    expect(flags.specType).toBe("none");
    expect(dropped).toContain("specType");
  });

  it("sanitizes specDraftMax (numeric, in range)", () => {
    const { flags, clamped } = sanitizeLlamaCppServerFlags({ specDraftMax: 4 });
    expect(flags.specDraftMax).toBe(4);
    expect(clamped).not.toContain("specDraftMax");
  });

  it("clamps specDraftMax when out of range", () => {
    const { flags, clamped } = sanitizeLlamaCppServerFlags({ specDraftMax: 1000 });
    expect(flags.specDraftMax).toBeLessThanOrEqual(128);
    expect(clamped).toContain("specDraftMax");
  });
});

describe("buildLlamaServerFlags", () => {
  it("builds a complete flag array from a fully-populated recipe", () => {
    const flags = buildLlamaServerFlags(LLAMA_CPP_DEFAULTS);
    expect(flags).toContain("--ctx-size");
    expect(flags).toContain("100000");
    expect(flags).toContain("-ngl");
    expect(flags).toContain("100");
    expect(flags).toContain("--threads");
    expect(flags).toContain("8");
    expect(flags).toContain("--flash-attn");
    expect(flags).toContain("on");
  });

  it("omits spec flags when specType is 'none'", () => {
    const flags = buildLlamaServerFlags({
      ...LLAMA_CPP_DEFAULTS,
      specType: "none",
    });
    expect(flags).not.toContain("--spec-type");
    expect(flags).not.toContain("--spec-draft-n-max");
  });

  it("includes spec flags when specType is not 'none'", () => {
    const flags = buildLlamaServerFlags({
      ...LLAMA_CPP_DEFAULTS,
      specType: "draft-mtp",
      specDraftMax: 4,
    });
    expect(flags).toContain("--spec-type");
    expect(flags).toContain("draft-mtp");
    expect(flags).toContain("--spec-draft-n-max");
    expect(flags).toContain("4");
  });

  it("preserves order: standard flags, then spec flags", () => {
    const flags = buildLlamaServerFlags({
      ...LLAMA_CPP_DEFAULTS,
      specType: "draft-mtp",
      specDraftMax: 3,
    });
    const flashIdx = flags.indexOf("--flash-attn");
    const specIdx = flags.indexOf("--spec-type");
    expect(flashIdx).toBeLessThan(specIdx);
  });
});
