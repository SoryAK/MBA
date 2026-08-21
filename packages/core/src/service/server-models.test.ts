import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createMbaServiceApp } from "./server.js";
import { defaultStorePaths } from "./config-store.js";

function writeAdapter(dir: string, rel: string, id: string, file: string): void {
  const yamlFile = join(dir, rel);
  mkdirSync(join(yamlFile, ".."), { recursive: true });
  writeFileSync(
    yamlFile,
    [
      "apiVersion: mba.c-yard.dev/v1alpha1",
      "kind: ModelBehavioralAdapter",
      "metadata:",
      `  id: ${id}`,
      "identity:",
      "  model:",
      `    file: "${file}"`,
      "bindings: {}",
    ].join("\n"),
  );
}

function modelsFetch(ids: string[]): typeof fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  ) as unknown as typeof fetch;
}

describe("mba service model plane (ADR-0093 Phase 1)", () => {
  let paths: ReturnType<typeof defaultStorePaths>;
  let adapterDir: string;

  beforeEach(() => {
    paths = defaultStorePaths(mkdtempSync(join(tmpdir(), "mba-svc-models-")));
    adapterDir = mkdtempSync(join(tmpdir(), "mba-svc-adapters-"));
    writeAdapter(adapterDir, "qwen/qwen3-coder/qwen3-coder-30b/qwen3-coder-30b.yaml", "qwen3-coder-30b", "./m.gguf");
    writeAdapter(adapterDir, "llama/llama3/llama3-8b/llama3-8b.yaml", "llama3-8b", "./l.gguf");
  });

  it("GET /models lists the catalog with live loaded state", async () => {
    const app = createMbaServiceApp({
      paths,
      adapterDir,
      upstreamUrl: "http://127.0.0.1:8080",
      fetch: modelsFetch(["qwen3-coder-30b"]),
    });
    const res = await app.request("/models");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      models: Array<{ id: string; name: string; family?: string; modelFile?: string; loaded: boolean }>;
    };
    expect(body.models).toHaveLength(2);
    const qwen = body.models.find((m) => m.id === "qwen3-coder-30b");
    expect(qwen?.loaded).toBe(true);
    const llama = body.models.find((m) => m.id === "llama3-8b");
    expect(llama?.loaded).toBe(false);
  });

  it("GET /models marks nothing loaded when the upstream is unreachable", async () => {
    const app = createMbaServiceApp({
      paths,
      adapterDir,
      upstreamUrl: "http://127.0.0.1:8080",
      fetch: (vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown) as typeof fetch,
    });
    const res = await app.request("/models");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { models: Array<{ loaded: boolean }> };
    expect(body.models.every((m) => m.loaded === false)).toBe(true);
  });

  it("POST /models/ensure is disabled by default (409)", async () => {
    const app = createMbaServiceApp({ paths, adapterDir, upstreamUrl: "http://127.0.0.1:8080" });
    const res = await app.request("/models/ensure", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "qwen3-coder-30b" }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/disabled/i);
  });

  it("POST /models/ensure is a no-op when the model is already loaded", async () => {
    const executor = vi.fn();
    const app = createMbaServiceApp({
      paths,
      adapterDir,
      upstreamUrl: "http://127.0.0.1:8080",
      switchEnabled: true,
      switchExecutor: executor,
      fetch: modelsFetch(["qwen3-coder-30b"]),
    });
    const res = await app.request("/models/ensure", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "qwen3-coder-30b" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; id: string };
    expect(body).toEqual({ status: "loaded", id: "qwen3-coder-30b" });
    expect(executor).not.toHaveBeenCalled();
  });

  it("POST /models/ensure runs the executor when armed and the model is not loaded", async () => {
    const executor = vi.fn(async () => undefined);
    const app = createMbaServiceApp({
      paths,
      adapterDir,
      upstreamUrl: "http://127.0.0.1:8080",
      switchEnabled: true,
      switchExecutor: executor,
      fetch: modelsFetch(["llama3-8b"]),
    });
    const res = await app.request("/models/ensure", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "qwen3-coder-30b" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; id: string };
    expect(body).toEqual({ status: "switched", id: "qwen3-coder-30b" });
    expect(executor).toHaveBeenCalledTimes(1);
  });

  it("POST /models/ensure rejects an unknown id with 404", async () => {
    const app = createMbaServiceApp({
      paths,
      adapterDir,
      upstreamUrl: "http://127.0.0.1:8080",
      switchEnabled: true,
      switchExecutor: vi.fn(),
      fetch: modelsFetch([]),
    });
    const res = await app.request("/models/ensure", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "gpt-9" }),
    });
    expect(res.status).toBe(404);
  });

  it("POST /models/ensure rejects a malformed body with 400", async () => {
    const app = createMbaServiceApp({ paths, adapterDir, upstreamUrl: "http://127.0.0.1:8080" });
    const res = await app.request("/models/ensure", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nope: true }),
    });
    expect(res.status).toBe(400);
  });
});
