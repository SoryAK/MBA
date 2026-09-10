import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createMbaServiceApp } from "./server.js";
import { defaultStorePaths } from "./config-store.js";

function makeGgufBuffer(arch: string): Buffer {
  const key = Buffer.from(arch, "utf8");
  const val = Buffer.from("qwen35", "utf8");
  const buf = Buffer.alloc(
    4 + 4 + 8 + 8 + 8 + key.length + 4 + 8 + val.length + 8,
  );
  let o = 0;
  buf.write("GGUF", o, "ascii");
  o += 4;
  buf.writeUInt32LE(3, o);
  o += 4;
  buf.writeBigUInt64LE(1n, o);
  o += 8;
  buf.writeBigUInt64LE(1n, o);
  o += 8;
  buf.writeBigUInt64LE(BigInt(key.length), o);
  o += 8;
  key.copy(buf, o);
  o += key.length;
  buf.writeUInt32LE(8, o);
  o += 4;
  buf.writeBigUInt64LE(BigInt(val.length), o);
  o += 8;
  val.copy(buf, o);
  o += val.length;
  buf.writeBigUInt64LE(0n, o);
  return buf;
}

const GGUF = makeGgufBuffer("general.architecture");
const SHA256 = createHash("sha256").update(GGUF).digest("hex");

describe("POST /models/adopt", () => {
  it("copies a local GGUF into the adapter dir and returns the house", async () => {
    const paths = defaultStorePaths(mkdtempSync(join(tmpdir(), "mba-svc-adopt-")));
    const adapterDir = mkdtempSync(join(tmpdir(), "mba-svc-adopt-adapters-"));
    const srcDir = mkdtempSync(join(tmpdir(), "mba-svc-adopt-src-"));
    const app = createMbaServiceApp({ paths, adapterDir });
    const source = join(srcDir, "weights.gguf");
    writeFileSync(source, GGUF);

    try {
      const res = await app.request("/models/adopt", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: source, id: "local-model" }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { id: string; sha256: string; placed: string; moved: boolean };
      expect(body.id).toBe("local-model");
      expect(body.sha256).toBe(SHA256);
      expect(["hardlink", "copy"]).toContain(body.placed);
      expect(body.moved).toBe(false);
      expect(existsSync(join(adapterDir, "local-model", "local-model", "weights.gguf"))).toBe(true);
      expect(existsSync(source)).toBe(true);
    } finally {
      rmSync(paths.baseDir, { recursive: true, force: true });
      rmSync(adapterDir, { recursive: true, force: true });
      rmSync(srcDir, { recursive: true, force: true });
    }
  });

  it("returns 400 without path/id, 404 when the source is missing, 409 on conflict", async () => {
    const paths = defaultStorePaths(mkdtempSync(join(tmpdir(), "mba-svc-adopt-")));
    const adapterDir = mkdtempSync(join(tmpdir(), "mba-svc-adopt-adapters-"));
    const srcDir = mkdtempSync(join(tmpdir(), "mba-svc-adopt-src-"));
    const app = createMbaServiceApp({ paths, adapterDir });
    const source = join(srcDir, "weights.gguf");
    writeFileSync(source, GGUF);

    try {
      const bad = await app.request("/models/adopt", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: source }),
      });
      expect(bad.status).toBe(400);

      const missing = await app.request("/models/adopt", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: join(srcDir, "nope.gguf"), id: "gone" }),
      });
      expect(missing.status).toBe(404);

      const first = await app.request("/models/adopt", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: source, id: "dup" }),
      });
      expect(first.status).toBe(200);
      const second = await app.request("/models/adopt", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: source, id: "dup" }),
      });
      expect(second.status).toBe(409);
    } finally {
      rmSync(paths.baseDir, { recursive: true, force: true });
      rmSync(adapterDir, { recursive: true, force: true });
      rmSync(srcDir, { recursive: true, force: true });
    }
  });

  it("unlinks the source when move is true", async () => {
    const paths = defaultStorePaths(mkdtempSync(join(tmpdir(), "mba-svc-adopt-")));
    const adapterDir = mkdtempSync(join(tmpdir(), "mba-svc-adopt-adapters-"));
    const srcDir = mkdtempSync(join(tmpdir(), "mba-svc-adopt-src-"));
    const app = createMbaServiceApp({ paths, adapterDir });
    const source = join(srcDir, "weights.gguf");
    writeFileSync(source, GGUF);

    try {
      const res = await app.request("/models/adopt", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: source, id: "moved-model", move: true }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { moved: boolean; placed: string };
      expect(body.moved).toBe(true);
      expect(existsSync(source)).toBe(false);
      expect(existsSync(join(adapterDir, "moved-model", "moved-model", "weights.gguf"))).toBe(true);
    } finally {
      rmSync(paths.baseDir, { recursive: true, force: true });
      rmSync(adapterDir, { recursive: true, force: true });
      rmSync(srcDir, { recursive: true, force: true });
    }
  });
});
