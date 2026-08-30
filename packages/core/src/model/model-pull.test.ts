import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import YAML from "yaml";
import { pullModel, sha256OfFile, type PullModelOptions } from "./model-pull.js";

/**
 * Build a minimal valid GGUF v3 buffer with one string kv pair, so the
 * download fixture is parseable by the real header parser.
 */
function makeGgufBuffer(arch: string): Buffer {
  // GGUF v3: magic(4) version(4) tensor_count(8) kv_count(8), then kv pairs
  // (key = u64 len + bytes, type u32, value), then a zero-length key.
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

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = (await import("node:http")).createServer((req, res) => {
    const range = req.headers.range;
    if (range) {
      const m = range.match(/bytes=(\d+)-/);
      const start = m ? Number(m[1]) : 0;
      res.writeHead(206, {
        "Content-Range": `bytes ${start}-${GGUF.length - 1}/${GGUF.length}`,
        "Content-Length": GGUF.length - start,
        "Accept-Ranges": "bytes",
      });
      res.end(GGUF.subarray(start));
      return;
    }
    res.writeHead(200, { "Content-Length": GGUF.length, "Accept-Ranges": "bytes" });
    res.end(GGUF);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/weights.gguf`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

function freshStore(): string {
  const dir = join(tmpdir(), `mba-pull-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function opts(storeRoot: string, over: Partial<PullModelOptions> = {}): PullModelOptions {
  return {
    url: baseUrl,
    id: "test-model",
    sha256: SHA256,
    storeRoot,
    ...over,
  };
}

describe("pullModel", () => {
  it("downloads fresh, verifies sha256, and scaffolds both tiers", async () => {
    const store = freshStore();
    try {
      const result = await pullModel(opts(store));
      expect(result.id).toBe("test-model");
      expect(result.family).toBe("test-model");
      expect(result.sha256).toBe(SHA256);

      const modelDir = join(store, "test-model", "test-model");
      const ggufPath = join(modelDir, "weights.gguf");
      expect(readFileSync(ggufPath)).toEqual(GGUF);
      expect(existsSync(join(modelDir, "weights.gguf.partial"))).toBe(false);

      // model tier
      const yaml = YAML.parse(readFileSync(join(modelDir, "test-model.yaml"), "utf8")) as any;
      expect(yaml.metadata.id).toBe("test-model");
      expect(yaml.identity.model.file).toBe("./weights.gguf");
      expect(yaml.identity.model.profile.gguf.fileFingerprint).toBe(SHA256);
      expect(yaml.identity.model.profile.architecture).toBe("qwen35");
      expect(existsSync(join(modelDir, "bcb.jsonl"))).toBe(true);
      expect(existsSync(join(modelDir, "tcb.jsonl"))).toBe(true);
      expect(existsSync(join(modelDir, "server_setup.json"))).toBe(true);

      // KV slot-save dirs for both fork variants (G3): llama-server requires
      // --slot-save-path to be an existing directory, so a fresh pull must be
      // boot-ready without any extra step.
      expect(existsSync(join(modelDir, "kv", "upstream", "slots"))).toBe(true);
      expect(existsSync(join(modelDir, "kv", "cachyllama", "slots"))).toBe(true);

      // family tier (created because absent)
      const familyDir = join(store, "test-model");
      const fam = YAML.parse(readFileSync(join(familyDir, "family.yaml"), "utf8")) as any;
      expect(fam.metadata.id).toBe("test-model-family");
      expect(fam.identity.model.lineage).toEqual(["test-model"]);
      expect(existsSync(join(familyDir, "structural.json"))).toBe(true);
    } finally {
      rmSync(store, { recursive: true, force: true });
    }
  });

  it("resumes a partial download via HTTP Range", async () => {
    const store = freshStore();
    try {
      const modelDir = join(store, "test-model", "test-model");
      mkdirSync(modelDir, { recursive: true });
      const partial = join(modelDir, "weights.gguf.partial");
      writeFileSync(partial, GGUF.subarray(0, 10));

      const result = await pullModel(opts(store));
      expect(result.resumed).toBe(true);
      expect(readFileSync(join(modelDir, "weights.gguf"))).toEqual(GGUF);
      expect(existsSync(partial)).toBe(false);
    } finally {
      rmSync(store, { recursive: true, force: true });
    }
  });

  it("refuses on sha256 mismatch and deletes the partial", async () => {
    const store = freshStore();
    try {
      const bad = "0".repeat(64);
      await expect(pullModel(opts(store, { sha256: bad }))).rejects.toThrow(/sha256/i);
      const modelDir = join(store, "test-model", "test-model");
      expect(existsSync(join(modelDir, "weights.gguf"))).toBe(false);
      expect(existsSync(join(modelDir, "weights.gguf.partial"))).toBe(false);
      // no scaffold on failure
      expect(existsSync(join(modelDir, "test-model.yaml"))).toBe(false);
      expect(existsSync(join(store, "test-model", "family.yaml"))).toBe(false);
    } finally {
      rmSync(store, { recursive: true, force: true });
    }
  });

  it("refuses to pull into an existing model folder", async () => {
    const store = freshStore();
    try {
      mkdirSync(join(store, "test-model", "test-model"), { recursive: true });
      await expect(pullModel(opts(store))).rejects.toThrow(/exists/i);
    } finally {
      rmSync(store, { recursive: true, force: true });
    }
  });

  it("reuses an existing family tier without overwriting family.yaml", async () => {
    const store = freshStore();
    try {
      const familyDir = join(store, "qwen");
      mkdirSync(familyDir, { recursive: true });
      const existing = "# hand-written\napiVersion: mba.c-yard.dev/v1alpha1\n";
      writeFileSync(join(familyDir, "family.yaml"), existing);

      const result = await pullModel(opts(store, { id: "qwen3.8-27b", family: "qwen" }));
      expect(result.family).toBe("qwen");
      expect(readFileSync(join(familyDir, "family.yaml"), "utf8")).toBe(existing);
      expect(existsSync(join(familyDir, "qwen3.8-27b", "qwen3.8-27b.yaml"))).toBe(true);
    } finally {
      rmSync(store, { recursive: true, force: true });
    }
  });

  it("honors an explicit --family slug", async () => {
    const store = freshStore();
    try {
      const result = await pullModel(opts(store, { id: "qwen3.8-27b", family: "qwen" }));
      expect(result.family).toBe("qwen");
      expect(existsSync(join(store, "qwen", "qwen3.8-27b", "weights.gguf"))).toBe(true);
    } finally {
      rmSync(store, { recursive: true, force: true });
    }
  });
});

describe("pullModel digest auto-resolution (ADR-0099)", () => {
  /**
   * Fake fetch that serves BOTH the HuggingFace API (repo info + tree) and
   * the weights download (the local GGUF fixture).
   */
  function hfAndWeightsFetch(): typeof fetch {
    const ref = "e".repeat(40);
    return (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      // Tree listing — served for the default revision (commit sha) and for
      // any branch named in a resolve URL.
      if (url.includes("/api/models/owner/repo/tree/")) {
        return Response.json([
          { type: "file", path: "weights.gguf", lfs: { oid: SHA256, size: GGUF.length } },
        ]);
      }
      if (url.includes("/api/models/owner/repo")) {
        return Response.json({ sha: ref });
      }
      // Weights download (same semantics as the local HTTP server above).
      const range = init?.headers && (init.headers as Record<string, string>).Range;
      if (range) {
        const m = range.match(/bytes=(\d+)-/);
        const start = m ? Number(m[1]) : 0;
        return new Response(GGUF.subarray(start), {
          status: 206,
          headers: { "Content-Range": `bytes ${start}-${GGUF.length - 1}/${GGUF.length}` },
        });
      }
      return new Response(GGUF, { status: 200 });
    }) as typeof fetch;
  }

  it("resolves owner/repo shorthand when --sha256 is omitted", async () => {
    const store = freshStore();
    try {
      const result = await pullModel({
        url: "owner/repo",
        id: "test-model",
        storeRoot: store,
        fetch: hfAndWeightsFetch(),
      });
      expect(result.sha256).toBe(SHA256);
      const modelDir = join(store, "test-model", "test-model");
      expect(readFileSync(join(modelDir, "weights.gguf"))).toEqual(GGUF);
      expect(existsSync(join(modelDir, "test-model.yaml"))).toBe(true);
    } finally {
      rmSync(store, { recursive: true, force: true });
    }
  });

  it("resolves a HuggingFace resolve URL when --sha256 is omitted", async () => {
    const store = freshStore();
    try {
      const result = await pullModel({
        url: "https://huggingface.co/owner/repo/resolve/main/weights.gguf",
        id: "test-model",
        storeRoot: store,
        fetch: hfAndWeightsFetch(),
      });
      expect(result.sha256).toBe(SHA256);
      expect(existsSync(join(store, "test-model", "test-model", "weights.gguf"))).toBe(true);
    } finally {
      rmSync(store, { recursive: true, force: true });
    }
  });

  it("an explicit --sha256 skips resolution and wins", async () => {
    const store = freshStore();
    try {
      // The fake HF API would 404 for this repo — proof that no resolution
      // happens when a digest is supplied.
      const result = await pullModel({
        url: "https://huggingface.co/nosuch/repo/resolve/main/weights.gguf",
        id: "test-model",
        sha256: SHA256,
        storeRoot: store,
        fetch: hfAndWeightsFetch(),
      });
      expect(result.sha256).toBe(SHA256);
    } finally {
      rmSync(store, { recursive: true, force: true });
    }
  });

  it("a shorthand with an explicit --sha256 resolves the URL but keeps the supplied digest", async () => {
    const store = freshStore();
    try {
      const supplied = "f".repeat(64);
      // The supplied digest does not match the fixture, so the pull fails at
      // verify — but the failure message proves the SUPPLIED digest was used
      // (not the repo's), and that the shorthand was resolved to a URL.
      await expect(
        pullModel({
          url: "owner/repo",
          id: "test-model",
          sha256: supplied,
          storeRoot: store,
          fetch: hfAndWeightsFetch(),
        }),
      ).rejects.toThrow(new RegExp(`expected ${supplied}`));
    } finally {
      rmSync(store, { recursive: true, force: true });
    }
  });

  it("a non-HuggingFace URL without --sha256 fails with a clear error", async () => {
    const store = freshStore();
    try {
      await expect(
        pullModel({
          url: "https://example.com/weights.gguf",
          id: "test-model",
          storeRoot: store,
          fetch: hfAndWeightsFetch(),
        }),
      ).rejects.toThrow(/pull requires --sha256/);
      // No store side effects from a failed resolution.
      expect(existsSync(join(store, "test-model"))).toBe(false);
    } finally {
      rmSync(store, { recursive: true, force: true });
    }
  });
});

describe("sha256OfFile", () => {
  it("streams the hash and matches a whole-buffer digest", async () => {
    const dir = freshStore();
    try {
      const path = join(dir, "chunked.gguf");
      // Write in chunks so the file is larger than any single read.
      const chunk = Buffer.alloc(64 * 1024, 7);
      for (let i = 0; i < 64; i++) appendFileSync(path, chunk);

      const expected = createHash("sha256")
        .update(Buffer.concat(Array.from({ length: 64 }, () => chunk)))
        .digest("hex");
      await expect(sha256OfFile(path)).resolves.toBe(expected);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
