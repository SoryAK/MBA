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

async function parseSse(res: Response): Promise<Array<Record<string, unknown>>> {
  const text = await res.text();
  const events: Array<Record<string, unknown>> = [];
  for (const frame of text.split("\n\n")) {
    const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
    if (!dataLine) continue;
    events.push(JSON.parse(dataLine.slice(5).trim()) as Record<string, unknown>);
  }
  return events;
}

describe("POST /models/adopt", () => {
  it("streams a done event and returns the house", async () => {
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
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      const events = await parseSse(res);
      expect(events[events.length - 1]?.type).toBe("done");
      const result = events[events.length - 1]?.result as {
        id: string;
        sha256: string;
        placed: string;
        moved: boolean;
      };
      expect(result.id).toBe("local-model");
      expect(result.sha256).toBe(SHA256);
      expect(["hardlink", "copy"]).toContain(result.placed);
      expect(result.moved).toBe(false);
      expect(existsSync(join(adapterDir, "local-model", "local-model", "weights.gguf"))).toBe(true);
      expect(existsSync(source)).toBe(true);
    } finally {
      rmSync(paths.baseDir, { recursive: true, force: true });
      rmSync(adapterDir, { recursive: true, force: true });
      rmSync(srcDir, { recursive: true, force: true });
    }
  });

  it("returns 400 without path/id; missing source and conflict are SSE errors", async () => {
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
      expect(missing.status).toBe(200);
      const missingEvents = await parseSse(missing);
      expect(missingEvents[missingEvents.length - 1]?.type).toBe("error");
      expect(String(missingEvents[missingEvents.length - 1]?.message)).toMatch(/not found/i);

      const first = await app.request("/models/adopt", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: source, id: "dup" }),
      });
      expect((await parseSse(first)).at(-1)?.type).toBe("done");
      const second = await app.request("/models/adopt", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: source, id: "dup" }),
      });
      const secondEvents = await parseSse(second);
      expect(secondEvents[secondEvents.length - 1]?.type).toBe("error");
      expect(String(secondEvents[secondEvents.length - 1]?.message)).toMatch(/already exists/i);
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
      const events = await parseSse(res);
      const result = events[events.length - 1]?.result as { moved: boolean; placed: string };
      expect(events[events.length - 1]?.type).toBe("done");
      expect(result.moved).toBe(true);
      expect(existsSync(source)).toBe(false);
      expect(existsSync(join(adapterDir, "moved-model", "moved-model", "weights.gguf"))).toBe(true);
    } finally {
      rmSync(paths.baseDir, { recursive: true, force: true });
      rmSync(adapterDir, { recursive: true, force: true });
      rmSync(srcDir, { recursive: true, force: true });
    }
  });
});
