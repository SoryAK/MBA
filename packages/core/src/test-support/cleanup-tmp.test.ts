import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isMbaTestTempName, removeMbaTestTempDirs } from "./cleanup-tmp.js";

describe("removeMbaTestTempDirs", () => {
  it("matches mba- and bcb- fixture names only", () => {
    expect(isMbaTestTempName("mba-proxy-abc")).toBe(true);
    expect(isMbaTestTempName("bcb-escalate-xyz")).toBe(true);
    expect(isMbaTestTempName("other-tmp")).toBe(false);
  });

  it("deletes matching dirs under a given root and leaves others", () => {
    const root = mkdtempSync(join(tmpdir(), "mba-cleanup-harness-"));
    try {
      const leak = mkdtempSync(join(root, "mba-proxy-"));
      writeFileSync(join(leak, "x"), "x");
      const keep = mkdtempSync(join(root, "other-"));
      writeFileSync(join(keep, "y"), "y");
      const removed = removeMbaTestTempDirs(root);
      expect(removed).toEqual([leak]);
      expect(existsSync(leak)).toBe(false);
      expect(existsSync(keep)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
