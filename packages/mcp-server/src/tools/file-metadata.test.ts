import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileMetadataHandler } from "./file-metadata.js";

describe("mba_file_metadata", () => {
  const root = mkdtempSync(join(tmpdir(), "mba-mcp-test-"));
  mkdirSync(join(root, "nested"), { recursive: true });
  writeFileSync(join(root, "three.txt"), "line1\nline2\nline3");
  writeFileSync(join(root, "nested", "two.txt"), "a\nb");
  writeFileSync(join(root, "binary.db"), Buffer.from([0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33, 0x00]));

  const handle = createFileMetadataHandler(root);

  it("returns totalLines for a file", () => {
    const result = handle({ filePath: "three.txt" });
    expect(result.exists).toBe(true);
    expect(result.totalLines).toBe(3);
    expect(result.isDirectory).toBe(false);
  });

  it("resolves relative paths from workspace root", () => {
    const result = handle({ filePath: "nested/two.txt" });
    expect(result.exists).toBe(true);
    expect(result.totalLines).toBe(2);
  });

  it("rejects paths outside workspace", () => {
    const result = handle({ filePath: "/etc/passwd" });
    expect(result.exists).toBe(false);
    expect(result.error).toBe("filePath is outside the workspace");
  });

  it("reports missing files", () => {
    const result = handle({ filePath: "missing.txt" });
    expect(result.exists).toBe(false);
    expect(result.totalLines).toBeNull();
  });

  it("rejects empty filePath", () => {
    const result = handle({ filePath: "" });
    expect(result.exists).toBe(false);
    expect(result.error).toBe("filePath is required");
  });

  it("flags binary files and hints the right tool", () => {
    const result = handle({ filePath: "binary.db" });
    expect(result.exists).toBe(true);
    expect(result.isBinary).toBe(true);
    expect(result.totalLines).toBeNull();
    expect(result.hint).toMatch(/binary\.db is a binary file/);
  });
});
