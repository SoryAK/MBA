/**
 * POST /models/config route tests (ADR-0096).
 *
 * The route is a thin door over the `model-config.ts` capability block:
 * validate the body, call the capability, map the structured result to a
 * status code, and report `modelLoaded` (probed from the upstream) so the
 * caller can decide about a restart. The route never restarts anything.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createMbaServiceApp } from "./server.js";
import { defaultStorePaths } from "./config-store.js";
import { writeRegistry } from "./upstream-registry.js";
import { machineInfoPath, writeMachineInfo } from "./machine-store.js";
import type { MachineInfo } from "./machine-info.js";

function writeConfigFixture(dir: string): void {
  const modelDir = join(dir, "qwen", "qwen3.8-27b");
  mkdirSync(modelDir, { recursive: true });
  writeFileSync(
    join(modelDir, "qwen3.8-27b.yaml"),
    [
      "apiVersion: mba.ai/v1alpha1",
      "kind: ModelBehavioralAdapter",
      "metadata:",
      "  id: qwen3.8-27b",
      "  name: Qwen3.8 27B",
      "  family: qwen",
      "identity:",
      "  model:",
      '    file: "./Qwen3.8-27B-Q6_K.gguf"',
      "    profile:",
      "      params:",
      "        blockCount: 65",
      "client:",
      "  url: http://127.0.0.1:8080/v1",
      "  toolCalling: true",
      "  vision: true",
      "bindings:",
      '  server_setup: "./server_setup.json"',
    ].join("\n"),
  );
  writeFileSync(
    join(modelDir, "server_setup.json"),
    JSON.stringify(
      { "llama.cpp": { ctxSize: 110000, gpuLayers: 100, flashAttn: "on" } },
      null,
      2,
    ),
  );
}

/**
 * Mock the upstream `GET /v1/models` probe. llama.cpp reports the model by
 * the exact path it was given via `-m` (NOT the MBA id) — so the "ids" here
 * are really the upstream-reported model identifiers, which in production are
 * absolute file paths.
 */
function modelsFetch(ids: string[]): typeof fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  ) as unknown as typeof fetch;
}

/** The absolute path the catalog resolves `identity.model.file` to for the fixture. */
function fixtureModelFile(adapterDir: string): string {
  return join(adapterDir, "qwen", "qwen3.8-27b", "Qwen3.8-27B-Q6_K.gguf");
}

function writeString(buf: Buffer, offset: number, value: string): number {
  const bytes = Buffer.from(value, "utf8");
  buf.writeBigUInt64LE(BigInt(bytes.length), offset);
  bytes.copy(buf, offset + 8);
  return 8 + bytes.length;
}

function writeUint32(buf: Buffer, offset: number, value: number): number {
  buf.writeUInt32LE(value, offset);
  return 4;
}

function writeUint64(buf: Buffer, offset: number, value: bigint): number {
  buf.writeBigUInt64LE(value, offset);
  return 8;
}

function writeKvUint32(buf: Buffer, offset: number, key: string, value: number): number {
  let written = 0;
  written += writeString(buf, offset + written, key);
  buf.writeUInt32LE(4, offset + written); // GGUF value type uint32
  written += 4;
  written += writeUint32(buf, offset + written, value);
  return written;
}

function createMinimalGgufFile(path: string, opts: { blockCount: number; hiddenSize: number; headCount: number; headCountKv: number; fileSizeBytes?: number }): void {
  const metadata: { key: string; value: number | string; type: "uint32" | "string" }[] = [
    { key: "general.architecture", value: "llama", type: "string" },
    { key: "llama.block_count", value: opts.blockCount, type: "uint32" },
    { key: "llama.embedding_length", value: opts.hiddenSize, type: "uint32" },
    { key: "llama.attention.head_count", value: opts.headCount, type: "uint32" },
    { key: "llama.attention.head_count_kv", value: opts.headCountKv, type: "uint32" },
  ];
  const buf = Buffer.alloc(4096);
  let offset = 0;
  buf.write("GGUF", offset, 4, "ascii");
  offset += 4;
  offset += writeUint32(buf, offset, 3);
  offset += writeUint64(buf, offset, 0n);
  offset += writeUint64(buf, offset, BigInt(metadata.length));
  for (const entry of metadata) {
    offset += writeString(buf, offset, entry.key);
    buf.writeUInt32LE(entry.type === "uint32" ? 4 : 8, offset);
    offset += 4;
    if (entry.type === "uint32") {
      offset += writeUint32(buf, offset, entry.value as number);
    } else {
      offset += writeString(buf, offset, entry.value as string);
    }
  }
  const fileSize = opts.fileSizeBytes ?? 1 * 1024 * 1024;
  const final = Buffer.alloc(fileSize);
  buf.copy(final, 0, 0, offset);
  writeFileSync(path, final);
}

function writeMachineHintFixture(adapterDir: string): string {
  const modelDir = join(adapterDir, "tiny", "tiny-model");
  mkdirSync(modelDir, { recursive: true });
  const modelPath = join(modelDir, "tiny.gguf");
  createMinimalGgufFile(modelPath, {
    blockCount: 8,
    hiddenSize: 512,
    headCount: 8,
    headCountKv: 2,
    fileSizeBytes: 100 * 1024 * 1024,
  });
  writeFileSync(
    join(modelDir, "tiny-model.yaml"),
    [
      "apiVersion: mba.ai/v1alpha1",
      "kind: ModelBehavioralAdapter",
      "metadata:",
      "  id: tiny-model",
      "identity:",
      "  model:",
      '    file: "./tiny.gguf"',
      "    profile:",
      "      params:",
      "        blockCount: 8",
      "        maxContextLength: 100000",
      "bindings: {}",
    ].join("\n"),
  );
  writeFileSync(
    join(modelDir, "server_setup.json"),
    JSON.stringify({ "llama.cpp": { ctxSize: 100000, gpuLayers: 8, threads: 8, parallel: 1 } }, null, 2),
  );
  return modelPath;
}

async function postConfig(
  app: ReturnType<typeof createMbaServiceApp>,
  body: unknown,
): Promise<Response> {
  return app.request("/models/config", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /models/config (ADR-0096)", () => {
  let paths: ReturnType<typeof defaultStorePaths>;
  let adapterDir: string;

  beforeEach(() => {
    paths = defaultStorePaths(mkdtempSync(join(tmpdir(), "mba-svc-mcfg-")));
    adapterDir = mkdtempSync(join(tmpdir(), "mba-svc-mcfg-adapters-"));
    writeConfigFixture(adapterDir);
  });

  it("writes a server_setup dial and reports before/after + restartRequired", async () => {
    const app = createMbaServiceApp({
      paths,
      adapterDir,
      upstreamUrl: "http://127.0.0.1:8080",
      // The upstream reports the model by its absolute file path (what llama.cpp
      // echoes from -m), not by the MBA id.
      fetch: modelsFetch([fixtureModelFile(adapterDir)]),
    });
    const res = await postConfig(app, {
      id: "qwen3.8-27b",
      file: "server_setup",
      field: "ctxSize",
      value: 120000,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      file: string;
      field: string;
      before: number;
      after: number;
      restartRequired: boolean;
      modelFile: string;
      modelLoaded: boolean;
    };
    expect(body).toEqual({
      file: "server_setup",
      field: "ctxSize",
      before: 110000,
      after: 120000,
      restartRequired: true,
      modelFile: fixtureModelFile(adapterDir),
      modelLoaded: true,
    });
  });

  it("reports modelLoaded false when the model is not on the live upstream", async () => {
    const app = createMbaServiceApp({
      paths,
      adapterDir,
      upstreamUrl: "http://127.0.0.1:8080",
      // Upstream is serving a different model (different path) than the one
      // being configured.
      fetch: modelsFetch([join(adapterDir, "qwen", "qwen3.8-27b", "OTHER.gguf")]),
    });
    const res = await postConfig(app, {
      id: "qwen3.8-27b",
      file: "client",
      field: "vision",
      value: false,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { restartRequired: boolean; modelLoaded: boolean };
    expect(body.restartRequired).toBe(false);
    expect(body.modelLoaded).toBe(false);
  });

  it("matches by basename when the probe path differs in prefix (symlink/normalization drift)", async () => {
    const app = createMbaServiceApp({
      paths,
      adapterDir,
      upstreamUrl: "http://127.0.0.1:8080",
      // Same file, reached via a different absolute path (e.g. a symlinked
      // model dir). Basename must still match.
      fetch: modelsFetch(["/elsewhere/linked/Qwen3.8-27B-Q6_K.gguf"]),
    });
    const res = await postConfig(app, {
      id: "qwen3.8-27b",
      file: "server_setup",
      field: "gpuLayers",
      value: 65,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { modelLoaded: boolean };
    expect(body.modelLoaded).toBe(true);
  });

  it("reports modelLoaded false when no upstream is configured", async () => {
    // No registry, no env — the YAML rung (client.url) is the only target;
    // a throwing fetch keeps the test hermetic (no real network).
    const app = createMbaServiceApp({
      paths,
      adapterDir,
      fetch: (vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown) as typeof fetch,
    });
    const res = await postConfig(app, {
      id: "qwen3.8-27b",
      file: "server_setup",
      field: "ctxSize",
      value: 90000,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { modelLoaded: boolean };
    expect(body.modelLoaded).toBe(false);
  });

  it("reports modelLoaded true from the upstream registry (no env, YAML rung unused)", async () => {
    // Registry points at 9999; the YAML client.url (8080) is a dead rung.
    // The registry must win — the probe only ever hits 9999.
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (!url.startsWith("http://127.0.0.1:9999")) {
        throw new Error(`unexpected probe target: ${url}`);
      }
      return new Response(
        JSON.stringify({ data: [{ id: fixtureModelFile(adapterDir) }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    writeRegistry(paths.upstreamsPath, [
      {
        id: "llama-cpp-9999",
        serverType: "llama.cpp",
        modelFile: fixtureModelFile(adapterDir),
        port: 9999,
        pid: 777,
        startedAt: "2026-08-24T00:00:00.000Z",
      },
    ]);
    const app = createMbaServiceApp({ paths, adapterDir, fetch: fetchMock });
    const res = await postConfig(app, {
      id: "qwen3.8-27b",
      file: "server_setup",
      field: "gpuLayers",
      value: 65,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { modelLoaded: boolean };
    expect(body.modelLoaded).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects an unknown model with 404", async () => {
    const app = createMbaServiceApp({ paths, adapterDir });
    const res = await postConfig(app, {
      id: "nope",
      file: "server_setup",
      field: "ctxSize",
      value: 1000,
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/unknown model/);
  });

  it("rejects an invalid field value with 400", async () => {
    const app = createMbaServiceApp({ paths, adapterDir });
    const res = await postConfig(app, {
      id: "qwen3.8-27b",
      file: "server_setup",
      field: "ctxSize",
      value: "big",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/integer/);
  });

  it("rejects a malformed body with 400", async () => {
    const app = createMbaServiceApp({ paths, adapterDir });
    const res = await postConfig(app, { id: "qwen3.8-27b" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/file|field|value/);
  });

  it("rejects a malformed JSON body with 400", async () => {
    const app = createMbaServiceApp({ paths, adapterDir });
    const res = await app.request("/models/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ not json",
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /models/config (ADR-0096)", () => {
  let paths: ReturnType<typeof defaultStorePaths>;
  let adapterDir: string;

  beforeEach(() => {
    paths = defaultStorePaths(mkdtempSync(join(tmpdir(), "mba-svc-mcfg-get-")));
    adapterDir = mkdtempSync(join(tmpdir(), "mba-svc-mcfg-get-adapters-"));
    writeConfigFixture(adapterDir);
  });

  it("returns every known dial with its current value", async () => {
    const app = createMbaServiceApp({ paths, adapterDir });
    const res = await app.request("/models/config?id=qwen3.8-27b");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      modelId: string;
      files: { yamlPath: string; serverSetupPath: string };
      fields: { field: string; file: string; current: unknown; restartRequired: boolean }[];
    };
    expect(body.modelId).toBe("qwen3.8-27b");
    expect(body.files.serverSetupPath).toContain("server_setup.json");
    const byField = new Map(body.fields.map((f) => [f.field, f]));
    expect(byField.get("ctxSize")?.current).toBe(110000);
    expect(byField.get("gpuLayers")?.current).toBe(100);
    expect(byField.get("flashAttn")?.current).toBe("on");
    expect(byField.get("threads")?.current).toBeNull();
    expect(byField.get("url")?.current).toBe("http://127.0.0.1:8080/v1");
    expect(byField.get("toolCalling")?.current).toBe(true);
    expect(byField.get("vision")?.current).toBe(true);
    expect(byField.get("contextSize")?.current).toBeNull();
    expect(byField.get("ctxSize")?.restartRequired).toBe(true);
    expect(byField.get("vision")?.restartRequired).toBe(false);
  });

  it("rejects a missing id with 400", async () => {
    const app = createMbaServiceApp({ paths, adapterDir });
    const res = await app.request("/models/config");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/id/);
  });

  it("rejects an unknown model with 404", async () => {
    const app = createMbaServiceApp({ paths, adapterDir });
    const res = await app.request("/models/config?id=nope");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/unknown model/);
  });

  it("includes machine-aware hints when a machine profile is persisted", async () => {
    writeMachineHintFixture(adapterDir);
    const machine: MachineInfo = {
      os: "linux",
      cpuCores: 4,
      totalRamBytes: 2 * 1024 * 1024 * 1024,
      gpus: [{ name: "Test GPU", vramBytes: 300 * 1024 * 1024 }],
    };
    writeMachineInfo(paths, machine);
    const app = createMbaServiceApp({ paths, adapterDir });
    const res = await app.request("/models/config?id=tiny-model");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      fields: { field: string; machineHint?: string }[];
    };
    const byField = new Map(body.fields.map((f) => [f.field, f]));
    expect(byField.get("threads")?.machineHint).toBe("≤ 4 cores");
    expect(byField.get("parallel")?.machineHint).toBe("≤ 4 cores");
    expect(byField.get("ctxSize")?.machineHint).toMatch(/^≤ \d+ \(RAM\)$/);
    expect(byField.get("gpuLayers")?.machineHint).toMatch(/^≤ \d+ \(VRAM\)$/);
  });

  it("omits machine-aware hints when no machine profile is persisted", async () => {
    writeMachineHintFixture(adapterDir);
    const app = createMbaServiceApp({ paths, adapterDir });
    const res = await app.request("/models/config?id=tiny-model");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      fields: { field: string; machineHint?: string }[];
    };
    for (const f of body.fields) {
      expect(f.machineHint).toBeUndefined();
    }
  });
});
