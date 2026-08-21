import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import { readModelCatalog } from "./model-catalog.js";

function writeAdapter(
  dir: string,
  rel: string,
  opts: { id: string; name?: string; family?: string; file?: string },
): string {
  const file = join(dir, rel);
  mkdirSync(join(file, ".."), { recursive: true });
  const yaml = [
    "apiVersion: mba.c-yard.dev/v1alpha1",
    "kind: ModelBehavioralAdapter",
    "metadata:",
    `  id: ${opts.id}`,
    opts.name ? `  name: "${opts.name}"` : null,
    opts.family ? `  family: ${opts.family}` : null,
    "identity:",
    "  model:",
    opts.file ? `    file: "${opts.file}"` : null,
    "bindings: {}",
  ]
    .filter((l) => l !== null)
    .join("\n");
  writeFileSync(file, yaml);
  return file;
}

describe("readModelCatalog", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mba-catalog-"));
  });

  it("returns [] for a missing adapter dir", () => {
    expect(readModelCatalog(join(root, "does-not-exist"))).toEqual([]);
  });

  it("returns [] for an empty adapter dir", () => {
    mkdirSync(root, { recursive: true });
    expect(readModelCatalog(root)).toEqual([]);
  });

  it("lists leaf adapters that declare a weights file, with absolute modelFile", () => {
    writeAdapter(root, "qwen/qwen3-coder/qwen3-coder-30b/qwen3-coder-30b.yaml", {
      id: "qwen3-coder-30b",
      name: "Qwen3 Coder 30B",
      family: "qwen3-coder",
      file: "./Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf",
    });
    const entries = readModelCatalog(root);
    expect(entries).toEqual([
      {
        id: "qwen3-coder-30b",
        name: "Qwen3 Coder 30B",
        family: "qwen3-coder",
        modelFile: join(
          root,
          "qwen/qwen3-coder/qwen3-coder-30b/Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf",
        ),
      },
    ]);
  });

  it("skips lineage-level adapters without a weights file", () => {
    writeAdapter(root, "qwen/qwen3-coder/family.yaml", {
      id: "qwen3-coder-family",
      family: "qwen3-coder",
    });
    writeAdapter(root, "qwen/qwen3-coder/qwen3-coder-30b/qwen3-coder-30b.yaml", {
      id: "qwen3-coder-30b",
      file: "./model.gguf",
    });
    const entries = readModelCatalog(root);
    expect(entries.map((e) => e.id)).toEqual(["qwen3-coder-30b"]);
  });

  it("falls back to id when name is absent", () => {
    writeAdapter(root, "a/b/b.yaml", { id: "b", file: "./b.gguf" });
    const entries = readModelCatalog(root);
    expect(entries[0]?.name).toBe("b");
  });

  it("throws on a YAML file that is not a valid adapter", () => {
    writeFileSync(join(root, "bad.yaml"), "apiVersion: something-else\nkind: Nope\n");
    expect(() => readModelCatalog(root)).toThrow(/invalid MBA adapter shape/);
  });
});
