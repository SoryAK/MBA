import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  catalogSkipFromModelFiles,
  defaultFindRoots,
  fuzzyScore,
  isAlreadyInHub,
  rankGgufs,
  scanGgufs,
  type FoundGguf,
} from "./gguf-scan.js";
import { deriveModelId } from "./model-id.js";

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "mba-gguf-scan-"));
}

function stub(path: string, fileName: string): FoundGguf {
  return { path, fileName, bytes: 1 };
}

describe("deriveModelId", () => {
  it("slugs a GGUF filename", () => {
    expect(deriveModelId("DeepSeek-R1-Q4_K_M.gguf")).toBe("deepseek-r1-q4-k-m");
    expect(deriveModelId("owner/Repo_Name")).toBe("owner-repo-name");
    expect(deriveModelId("...")).toBe("model");
  });
});

describe("fuzzyScore", () => {
  it("matches subsequences and rejects misses", () => {
    expect(fuzzyScore("DeepSeek-R1-Q4_K_M.gguf", "dpsk")).toBeGreaterThan(0);
    expect(fuzzyScore("DeepSeek-R1-Q4_K_M.gguf", "zzz")).toBe(0);
    expect(fuzzyScore("anything", "")).toBe(1);
  });

  it("ranks a tighter filename above a weak parent hit", () => {
    const files: FoundGguf[] = [
      stub("/models/other/noise.gguf", "noise.gguf"),
      stub("/models/cache/DeepSeek-R1-Q4_K_M.gguf", "DeepSeek-R1-Q4_K_M.gguf"),
    ];
    expect(rankGgufs(files, "deepseek").map((f) => f.fileName)).toEqual([
      "DeepSeek-R1-Q4_K_M.gguf",
    ]);
  });
});

describe("scanGgufs", () => {
  it("finds nested GGUFs and skips node_modules", () => {
    const root = freshDir();
    try {
      mkdirSync(join(root, "nested"), { recursive: true });
      mkdirSync(join(root, "node_modules"), { recursive: true });
      writeFileSync(join(root, "a.gguf"), "gguf");
      writeFileSync(join(root, "nested", "b.gguf"), "gguf");
      writeFileSync(join(root, "node_modules", "skip.gguf"), "gguf");
      writeFileSync(join(root, "readme.txt"), "no");
      const found = scanGgufs(root).map((f) => f.fileName).sort();
      expect(found).toEqual(["a.gguf", "b.gguf"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("respects maxDepth", () => {
    const root = freshDir();
    try {
      const deep = join(root, "d1", "d2", "d3");
      mkdirSync(deep, { recursive: true });
      writeFileSync(join(deep, "far.gguf"), "gguf");
      expect(scanGgufs(root, { maxDepth: 2 }).map((f) => f.fileName)).toEqual([]);
      expect(scanGgufs(root, { maxDepth: 3 }).map((f) => f.fileName)).toEqual(["far.gguf"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("follows a symlink file but not a symlink directory", () => {
    const root = freshDir();
    try {
      const realDir = join(root, "real");
      mkdirSync(realDir);
      writeFileSync(join(realDir, "inside.gguf"), "gguf");
      writeFileSync(join(root, "target.gguf"), "gguf");
      symlinkSync(join(root, "target.gguf"), join(root, "link.gguf"));
      symlinkSync(realDir, join(root, "linked-dir"));
      const names = scanGgufs(root).map((f) => f.fileName).sort();
      expect(names).toContain("target.gguf");
      expect(names).toContain("link.gguf");
      expect(names).toContain("inside.gguf");
      expect(names.filter((n) => n === "inside.gguf")).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips cataloged paths and hardlinked inodes", () => {
    const root = freshDir();
    try {
      const a = join(root, "a.gguf");
      const b = join(root, "b.gguf");
      writeFileSync(a, "gguf");
      writeFileSync(b, "other");
      const skip = catalogSkipFromModelFiles([a]);
      expect(isAlreadyInHub(a, skip)).toBe(true);
      expect(isAlreadyInHub(b, skip)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("omits missing default find roots", () => {
    const home = freshDir();
    try {
      expect(defaultFindRoots(home)).toEqual([]);
      mkdirSync(join(home, "models"));
      expect(defaultFindRoots(home)).toEqual([join(home, "models")]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
