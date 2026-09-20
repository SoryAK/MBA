import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import { createMbaServiceApp } from "./server.js";
import { defaultStorePaths } from "./config-store.js";
import { writeRegistry } from "./upstream-registry.js";
import { defaultWatches } from "./model-watches.js";

function writeAdapter(dir: string, rel: string, id: string, file: string): void {
  const yamlFile = join(dir, rel);
  mkdirSync(join(yamlFile, ".."), { recursive: true });
  writeFileSync(
    yamlFile,
    [
      "apiVersion: mba.ai/v1alpha1",
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

describe("GET /status snapshot", () => {
  let paths: ReturnType<typeof defaultStorePaths>;
  let adapterDir: string;
  let modelFile: string;

  beforeEach(() => {
    paths = defaultStorePaths(mkdtempSync(join(tmpdir(), "mba-status-snap-")));
    adapterDir = mkdtempSync(join(tmpdir(), "mba-status-snap-adapters-"));
    const modelDir = mkdtempSync(join(tmpdir(), "mba-status-snap-models-"));
    modelFile = join(modelDir, "qwen3.8-27b.gguf");
    writeAdapter(adapterDir, "qwen/qwen3.8-27b/qwen3.8-27b.yaml", "qwen3.8-27b", modelFile);
  });

  it("matches GET /models, GET /servers, overlay, and default watches", async () => {
    writeRegistry(paths.upstreamsPath, [
      {
        id: "llama-cpp-8080",
        serverType: "llama.cpp",
        modelFile,
        port: 8080,
        startedAt: "2026-09-20T00:00:00.000Z",
      },
    ]);
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/health")) {
        return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
      }
      if (url.includes("/v1/models")) {
        return new Response(JSON.stringify({ data: [{ id: modelFile }] }), { status: 200 });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch;
    const app = createMbaServiceApp({ paths, adapterDir, fetch: fetchImpl });

    const [statusRes, modelsRes, serversRes, overlayRes, watchesRes] = await Promise.all([
      app.request("/status"),
      app.request("/models"),
      app.request("/servers"),
      app.request("/config/machine-overlay"),
      app.request("/models/watches?id=qwen3.8-27b"),
    ]);
    expect(statusRes.status).toBe(200);
    const status = (await statusRes.json()) as {
      models: unknown;
      servers: unknown;
      machineOverlay: unknown;
      watches: { modelId: string | null };
    };
    expect(status.models).toEqual((await modelsRes.json() as { models: unknown }).models);
    expect(status.servers).toEqual((await serversRes.json() as { servers: unknown }).servers);
    expect(status.machineOverlay).toEqual(await overlayRes.json());
    expect(status.watches).toEqual(await watchesRes.json());
    expect(status.watches.modelId).toBe("qwen3.8-27b");
  });

  it("uses seed watches when no model is loaded", async () => {
    const app = createMbaServiceApp({ paths, adapterDir });
    const res = await app.request("/status");
    const status = (await res.json()) as { watches: unknown; models: Array<{ loaded: boolean }> };
    expect(status.models.every((m) => !m.loaded)).toBe(true);
    expect(status.watches).toEqual(defaultWatches());
  });
});
