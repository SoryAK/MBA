/**
 * Per-model dial config capability block (ADR-0096).
 *
 * Tests for `model-config.ts`: locating a model's config files, reading
 * current dial values, and validated single-field writes (atomic, with
 * before/after reporting and the restartRequired flag).
 */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import {
  findModelFiles,
  readModelDials,
  setModelDial,
  SERVER_SETUP_FIELDS,
  CLIENT_FIELDS,
  type ModelDialError,
} from "./model-config.js";

/** Write a minimal but realistic adapter tree fixture. */
function writeFixture(root: string): void {
  const modelDir = join(root, "qwen", "qwen3.8-27b");
  mkdirSync(modelDir, { recursive: true });
  writeFileSync(
    join(modelDir, "qwen3.8-27b.yaml"),
    [
      "apiVersion: mba.c-yard.dev/v1alpha1",
      "kind: ModelBehavioralAdapter",
      "metadata:",
      "  id: qwen3.8-27b",
      '  name: "Qwen3.8 27B"',
      "  family: qwen",
      "identity:",
      "  model:",
      '    file: "./Qwen3.8-27B-Q6_K.gguf"',
      "    profile:",
      "      params:",
      "        blockCount: 65",
      "        maxContextLength: 262144",
      "client:",
      "  url: http://127.0.0.1:8080/v1",
      "  toolCalling: true",
      "  vision: true",
      "bindings:",
      '  server_setup: "./server_setup.json"',
    ].join("\n"),
  );
  writeFileSync(
    join(modelDir, "server_setup.json"),
    JSON.stringify(
      {
        "llama.cpp": {
          ctxSize: 110000,
          gpuLayers: 100,
          threads: 8,
          parallel: 1,
          flashAttn: "on",
        },
      },
      null,
      2,
    ),
  );
}

describe("findModelFiles", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mba-model-config-"));
    writeFixture(root);
  });

  it("locates the yaml, server_setup.json (via binding), and env overrides", () => {
    const files = findModelFiles(root, "qwen3.8-27b");
    expect(files).not.toBeNull();
    expect(files?.yamlPath).toBe(join(root, "qwen", "qwen3.8-27b", "qwen3.8-27b.yaml"));
    expect(files?.serverSetupPath).toBe(
      join(root, "qwen", "qwen3.8-27b", "server_setup.json"),
    );
    expect(files?.envSetupPaths).toEqual([]);
  });

  it("returns null for an unknown model id", () => {
    expect(findModelFiles(root, "nope")).toBeNull();
  });

  it("returns null for a missing adapter dir", () => {
    expect(findModelFiles(join(root, "does-not-exist"), "qwen3.8-27b")).toBeNull();
  });
});

describe("readModelDials", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mba-model-config-"));
    writeFixture(root);
  });

  it("reads current values for server_setup and client fields", () => {
    const dials = readModelDials(root, "qwen3.8-27b");
    expect(dials).not.toBeNull();
    const byField = new Map(dials!.fields.map((f) => [f.field, f]));
    expect(byField.get("ctxSize")?.current).toBe(110000);
    expect(byField.get("gpuLayers")?.current).toBe(100);
    expect(byField.get("url")?.current).toBe("http://127.0.0.1:8080/v1");
    expect(byField.get("toolCalling")?.current).toBe(true);
  });

  it("marks all server_setup fields restartRequired and client fields not", () => {
    const dials = readModelDials(root, "qwen3.8-27b");
    for (const f of dials!.fields) {
      if (f.file === "server_setup") expect(f.restartRequired).toBe(true);
      if (f.file === "client") expect(f.restartRequired).toBe(false);
    }
  });

  it("reports null current for fields absent from the file", () => {
    const dials = readModelDials(root, "qwen3.8-27b");
    const byField = new Map(dials!.fields.map((f) => [f.field, f]));
    // warmupTokens is a known dial but absent from the fixture.
    expect(byField.get("warmupTokens")?.current).toBeNull();
  });

  it("attaches a constraint hint to every dial", () => {
    const dials = readModelDials(root, "qwen3.8-27b");
    const byField = new Map(dials!.fields.map((f) => [f.field, f]));
    // Profile ceilings drive the range hints.
    expect(byField.get("ctxSize")?.hint).toBe("≤ 262144");
    // gpuLayers allows blockCount + 1 (= all layers on GPU), so the hint
    // must match the validator's upper bound.
    expect(byField.get("gpuLayers")?.hint).toBe("1–66");
    // Enum and bool kinds list their allowed values.
    expect(byField.get("flashAttn")?.hint).toBe("on|off");
    expect(byField.get("toolCalling")?.hint).toBe("true|false");
    // Positive integers hint at the lower bound; plain ints get none.
    expect(byField.get("threads")?.hint).toBe("> 0");
    expect(byField.get("cacheRam")?.hint).toBeUndefined();
    // Free-form strings get no hint.
    expect(byField.get("url")?.hint).toBeUndefined();
    expect(byField.get("specType")?.hint).toBeUndefined();
  });

  it("omits the ctxSize ceiling hint when the profile has no maxContextLength", () => {
    // Rewrite the fixture YAML without maxContextLength.
    const yamlPath = join(root, "qwen", "qwen3.8-27b", "qwen3.8-27b.yaml");
    const text = readFileSync(yamlPath, "utf8").replace(
      "        maxContextLength: 262144\n",
      "",
    );
    writeFileSync(yamlPath, text);
    const dials = readModelDials(root, "qwen3.8-27b");
    const byField = new Map(dials!.fields.map((f) => [f.field, f]));
    expect(byField.get("ctxSize")?.hint).toBeUndefined();
    // gpuLayers still bounded by blockCount (+1 for all-on-GPU).
    expect(byField.get("gpuLayers")?.hint).toBe("1–66");
  });

  it("returns null for an unknown model id", () => {
    expect(readModelDials(root, "nope")).toBeNull();
  });
});

describe("setModelDial", () => {
  let root: string;
  let modelDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mba-model-config-"));
    writeFixture(root);
    modelDir = join(root, "qwen", "qwen3.8-27b");
  });

  it("writes a server_setup field atomically and reports before/after", () => {
    const result = setModelDial(root, "qwen3.8-27b", "server_setup", "ctxSize", 120000);
    expect(result).toEqual({
      ok: true,
      file: "server_setup",
      field: "ctxSize",
      before: 110000,
      after: 120000,
      restartRequired: true,
      modelFile: join(root, "qwen", "qwen3.8-27b", "Qwen3.8-27B-Q6_K.gguf"),
    });
    const onDisk = JSON.parse(
      readFileSync(join(modelDir, "server_setup.json"), "utf8"),
    ) as { "llama.cpp": Record<string, unknown> };
    expect(onDisk["llama.cpp"].ctxSize).toBe(120000);
    // Sibling fields untouched.
    expect(onDisk["llama.cpp"].gpuLayers).toBe(100);
  });

  it("writes a client field into the YAML, preserving other keys", () => {
    const result = setModelDial(root, "qwen3.8-27b", "client", "vision", false);
    expect(result).toEqual({
      ok: true,
      file: "client",
      field: "vision",
      before: true,
      after: false,
      restartRequired: false,
      modelFile: join(root, "qwen", "qwen3.8-27b", "Qwen3.8-27B-Q6_K.gguf"),
    });
    const yamlText = readFileSync(join(modelDir, "qwen3.8-27b.yaml"), "utf8");
    expect(yamlText).toContain("vision: false");
    // The rest of the document survived the round-trip.
    expect(yamlText).toContain("id: qwen3.8-27b");
    expect(yamlText).toContain("blockCount: 65");
    expect(yamlText).toContain('server_setup: "./server_setup.json"');
  });

  it("rejects a non-integer ctxSize", () => {
    const err = setModelDial(root, "qwen3.8-27b", "server_setup", "ctxSize", "big");
    expect(err.ok).toBe(false);
    if (!err.ok) expect(err.error).toMatch(/integer/);
  });

  it("rejects a negative ctxSize", () => {
    const err = setModelDial(root, "qwen3.8-27b", "server_setup", "ctxSize", -5);
    expect(err.ok).toBe(false);
  });

  it("rejects gpuLayers above the profile blockCount + 1", () => {
    // Fixture profile has blockCount 65 → max 66.
    const err = setModelDial(root, "qwen3.8-27b", "server_setup", "gpuLayers", 67);
    expect(err.ok).toBe(false);
    if (!err.ok) expect(err.error).toMatch(/66/);
  });

  it("accepts gpuLayers at the blockCount + 1 boundary", () => {
    const result = setModelDial(root, "qwen3.8-27b", "server_setup", "gpuLayers", 66);
    expect(result.ok).toBe(true);
  });

  it("rejects an unknown field", () => {
    const err = setModelDial(root, "qwen3.8-27b", "server_setup", "bogus", 1);
    expect(err.ok).toBe(false);
    if (!err.ok) expect(err.error).toMatch(/unknown field/);
  });

  it("rejects a field from the wrong file", () => {
    const err = setModelDial(root, "qwen3.8-27b", "client", "ctxSize", 1000);
    expect(err.ok).toBe(false);
    if (!err.ok) expect(err.error).toMatch(/not a client field/);
  });

  it("rejects an invalid flashAttn enum value", () => {
    const err = setModelDial(root, "qwen3.8-27b", "server_setup", "flashAttn", "maybe");
    expect(err.ok).toBe(false);
    if (!err.ok) expect(err.error).toMatch(/on|off/);
  });

  it("rejects a non-boolean client field", () => {
    const err = setModelDial(root, "qwen3.8-27b", "client", "toolCalling", "yes");
    expect(err.ok).toBe(false);
    if (!err.ok) expect(err.error).toMatch(/boolean/);
  });

  it("fails cleanly for an unknown model id", () => {
    const err = setModelDial(root, "nope", "server_setup", "ctxSize", 1000);
    expect(err.ok).toBe(false);
    if (!err.ok) expect(err.error).toMatch(/unknown model/);
  });

  it("fails cleanly when server_setup.json is missing", () => {
    writeFileSync(join(modelDir, "server_setup.json"), "");
    // Corrupt JSON is a real problem — surface it, don't clobber it.
    const err = setModelDial(root, "qwen3.8-27b", "server_setup", "ctxSize", 1000);
    expect(err.ok).toBe(false);
    if (!err.ok) expect(err.error).toMatch(/parse/i);
  });
});

describe("field spec tables", () => {
  it("covers the known llama.cpp dials, all restartRequired", () => {
    const names = SERVER_SETUP_FIELDS.map((f) => f.field);
    for (const expected of [
      "ctxSize",
      "gpuLayers",
      "threads",
      "parallel",
      "cacheReuse",
      "cacheRam",
      "specType",
      "specDraftMax",
      "reasoningBudget",
      "flashAttn",
      "warmupTokens",
    ]) {
      expect(names).toContain(expected);
    }
    for (const f of SERVER_SETUP_FIELDS) {
      expect(f.restartRequired).toBe(true);
      expect(f.file).toBe("server_setup");
    }
  });

  it("covers the client block fields, none restartRequired", () => {
    const names = CLIENT_FIELDS.map((f) => f.field);
    for (const expected of ["url", "contextSize", "maxOutputTokens", "toolCalling", "vision"]) {
      expect(names).toContain(expected);
    }
    for (const f of CLIENT_FIELDS) {
      expect(f.restartRequired).toBe(false);
      expect(f.file).toBe("client");
    }
  });
});
