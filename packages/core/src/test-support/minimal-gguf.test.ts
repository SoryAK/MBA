import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseGgufMetadata } from "../model/gguf-metadata.js";
import { writeMinimalGguf } from "./minimal-gguf.js";

describe("writeMinimalGguf", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("reports the requested size without allocating that much disk", () => {
    dir = mkdtempSync(join(tmpdir(), "mba-minimal-gguf-"));
    const path = join(dir, "tiny.gguf");
    const fileSizeBytes = 100 * 1024 * 1024;
    writeMinimalGguf(path, {
      blockCount: 8,
      hiddenSize: 512,
      headCount: 8,
      headCountKv: 2,
      fileSizeBytes,
    });
    const st = statSync(path);
    expect(st.size).toBe(fileSizeBytes);
    // Sparse hole: allocated blocks stay near the header, not 100 MB.
    expect(st.blocks * 512).toBeLessThan(1024 * 1024);
    const meta = parseGgufMetadata(path);
    expect(meta.fields["llama.block_count"]).toBe(8);
    expect(meta.fields["llama.attention.head_count_kv"]).toBe(2);
  });
});
