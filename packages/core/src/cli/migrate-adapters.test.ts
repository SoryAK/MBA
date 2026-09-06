import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateAdapters, LEGACY_API_VERSIONS } from "./migrate-adapters.js";

describe("migrateAdapters", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mba-migrate-adapters-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function write(rel: string, text: string): string {
    const file = join(root, rel);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, text, "utf8");
    return file;
  }

  it("reports no changes when the adapter tree is empty", () => {
    const result = migrateAdapters({ adapterDir: root, dryRun: false });
    expect(result.changed).toEqual([]);
    expect(result.unchanged).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it("does not touch files that already use the canonical apiVersion", () => {
    const file = write(
      "qwen/a.yaml",
      ["apiVersion: mba.ai/v1alpha1", "kind: ModelBehavioralAdapter", "metadata:", "  id: a"].join("\n"),
    );
    const result = migrateAdapters({ adapterDir: root, dryRun: false });
    expect(result.changed).toEqual([]);
    expect(result.unchanged).toEqual([file]);
    expect(result.errors).toEqual([]);
  });

  it("rewrites a legacy apiVersion line to the canonical value", () => {
    const file = write(
      "qwen/legacy.yaml",
      [
        "apiVersion: mba.ai/v1alpha1",
        "kind: ModelBehavioralAdapter",
        "metadata:",
        "  id: legacy",
      ].join("\n"),
    );
    const result = migrateAdapters({ adapterDir: root, dryRun: false });
    expect(result.changed).toEqual([file]);
    expect(result.unchanged).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(readFileSync(file, "utf8")).toContain("apiVersion: mba.ai/v1alpha1");
  });

  it("preserves the rest of the file exactly", () => {
    const original = [
      "apiVersion: mba.ai/v1alpha1",
      "kind: ModelBehavioralAdapter",
      "metadata:",
      "  id: legacy",
      "identity:",
      "  model:",
      "    file: ./model.gguf",
      "bindings: {}",
      "",
    ].join("\n");
    const file = write("qwen/legacy.yaml", original);
    migrateAdapters({ adapterDir: root, dryRun: false });
    expect(readFileSync(file, "utf8")).toBe(
      original.replace("mba.ai/v1alpha1", "mba.ai/v1alpha1"),
    );
  });

  it("does not write files in dry-run mode", () => {
    const original = [
      "apiVersion: mba.ai/v1alpha1",
      "kind: ModelBehavioralAdapter",
      "metadata:",
      "  id: legacy",
    ].join("\n");
    const file = write("qwen/legacy.yaml", original);
    const result = migrateAdapters({ adapterDir: root, dryRun: true });
    expect(result.changed).toEqual([file]);
    expect(readFileSync(file, "utf8")).toBe(original);
  });

  it("ignores non-yaml files", () => {
    write("notes.txt", "apiVersion: mba.ai/v1alpha1");
    const result = migrateAdapters({ adapterDir: root, dryRun: false });
    expect(result.changed).toEqual([]);
    expect(result.unchanged).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it("skips files whose apiVersion is unknown", () => {
    const file = write(
      "qwen/unknown.yaml",
      ["apiVersion: some.other/v1", "kind: ModelBehavioralAdapter", "metadata:", "  id: u"].join("\n"),
    );
    const result = migrateAdapters({ adapterDir: root, dryRun: false });
    expect(result.changed).toEqual([]);
    expect(result.unchanged).toEqual([file]);
  });

  it("exposes known legacy versions", () => {
    expect(LEGACY_API_VERSIONS).toContain("mba.ai/v1alpha1");
  });
});
