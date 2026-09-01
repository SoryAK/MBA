import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createMbaServiceApp } from "./server.js";
import { defaultStorePaths } from "./config-store.js";

/**
 * Minimal valid GGUF v3 buffer (one string kv pair) so the downloaded file is
 * parseable by the real header parser. Mirrors model-pull.test.ts.
 */
function makeGgufBuffer(arch: string): Buffer {
  const key = Buffer.from(arch, "utf8");
  const val = Buffer.from("qwen35", "utf8");
  const buf = Buffer.alloc(
    4 + 4 + 8 + 8 + // header
      8 + key.length + 4 + 8 + val.length + // kv: key, type, string value
      8, // terminator (zero-length key)
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
  buf.writeUInt32LE(8, o); // GGML_TYPE_STRING
  o += 4;
  buf.writeBigUInt64LE(BigInt(val.length), o);
  o += 8;
  val.copy(buf, o);
  o += val.length;
  buf.writeBigUInt64LE(0n, o); // terminator
  return buf;
}

const GGUF = makeGgufBuffer("general.architecture");
const SHA256 = createHash("sha256").update(GGUF).digest("hex");

/** A fetch mock that serves the GGUF bytes with a Content-Length header. */
function weightsFetch(): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("weights.gguf")) {
      return new Response(GGUF, {
        status: 200,
        headers: { "content-length": String(GGUF.length), "accept-ranges": "bytes" },
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
}

/** Parse an SSE body into its `data:` JSON payloads, in order. */
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

describe("POST /models/pull (SSE progress stream)", () => {
  it("streams progress events then a done event, and scaffolds the model", async () => {
    const paths = defaultStorePaths(mkdtempSync(join(tmpdir(), "mba-svc-pull-")));
    const adapterDir = mkdtempSync(join(tmpdir(), "mba-svc-pull-adapters-"));
    const app = createMbaServiceApp({ paths, adapterDir, fetch: weightsFetch() });

    try {
      const res = await app.request("/models/pull", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "http://127.0.0.1/weights.gguf", id: "test-model", sha256: SHA256 }),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");

      const events = await parseSse(res);
      const types = events.map((e) => e.type);
      expect(types[types.length - 1]).toBe("done");
      expect(types.filter((t) => t === "progress").length).toBeGreaterThan(0);
      expect(types.filter((t) => t === "error")).toHaveLength(0);

      const done = events[events.length - 1] as { result: { id: string; modelDir: string } };
      expect(done.result.id).toBe("test-model");
      // The model was actually scaffolded in the adapter dir.
      expect(
        existsSync(join(adapterDir, "test-model", "test-model", "weights.gguf")),
      ).toBe(true);
      expect(
        readFileSync(
          join(adapterDir, "test-model", "test-model", "weights.gguf"),
        ),
      ).toEqual(GGUF);
    } finally {
      rmSync(paths.baseDir, { recursive: true, force: true });
      rmSync(adapterDir, { recursive: true, force: true });
    }
  });

  it("emits an error event (not a throw) on sha256 mismatch", async () => {
    const paths = defaultStorePaths(mkdtempSync(join(tmpdir(), "mba-svc-pull-")));
    const adapterDir = mkdtempSync(join(tmpdir(), "mba-svc-pull-adapters-"));
    const app = createMbaServiceApp({ paths, adapterDir, fetch: weightsFetch() });

    try {
      const res = await app.request("/models/pull", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url: "http://127.0.0.1/weights.gguf",
          id: "test-model",
          sha256: "0".repeat(64),
        }),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");

      const events = await parseSse(res);
      const last = events[events.length - 1];
      expect(last.type).toBe("error");
      expect(String(last.message)).toMatch(/sha256/i);
      // No scaffold left behind on failure.
      expect(existsSync(join(adapterDir, "test-model", "test-model", "weights.gguf"))).toBe(false);
    } finally {
      rmSync(paths.baseDir, { recursive: true, force: true });
      rmSync(adapterDir, { recursive: true, force: true });
    }
  });
});
