import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  probeLoadedModel,
  ensureModel,
  isLoadedPath,
  modelArg,
  resolveProbeTarget,
  type SwitchExecutor,
} from "./model-switch.js";
import type { CatalogEntry } from "./model-catalog.js";
import { type UpstreamEntry } from "./upstream-registry.js";

function entry(id: string, modelFile: string): CatalogEntry {
  return { id, name: id, family: undefined, modelFile, yamlPath: `${id}.yaml` };
}

describe("probeLoadedModel", () => {
  it("returns the loaded model id from /v1/models", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toBe("http://127.0.0.1:8080/v1/models");
      return new Response(
        JSON.stringify({ data: [{ id: "qwen3-coder-30b" }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const loaded = await probeLoadedModel("http://127.0.0.1:8080", fetchMock);
    expect(loaded).toBe("qwen3-coder-30b");
  });

  it("returns null when the upstream is unreachable", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const loaded = await probeLoadedModel("http://127.0.0.1:8080", fetchMock);
    expect(loaded).toBeNull();
  });

  it("returns null on a non-200 response", async () => {
    const fetchMock = vi.fn(async () => new Response("nope", { status: 500 }));
    const loaded = await probeLoadedModel("http://127.0.0.1:8080", fetchMock);
    expect(loaded).toBeNull();
  });
});

describe("isLoadedPath", () => {
  const modelFile = "/home/u/models/qwen3.8-27b/Qwen3.8-27B-Q6_K.gguf";

  it("matches on an exact absolute path", () => {
    expect(isLoadedPath(modelFile, modelFile)).toBe(true);
  });

  it("matches on basename when the prefix differs (symlink/normalization drift)", () => {
    expect(isLoadedPath("/elsewhere/linked/Qwen3.8-27B-Q6_K.gguf", modelFile)).toBe(true);
  });

  it("does not match a different file", () => {
    expect(isLoadedPath("/home/u/models/other/OTHER.gguf", modelFile)).toBe(false);
  });

  it("returns false when the probe is null (upstream down / no model)", () => {
    expect(isLoadedPath(null, modelFile)).toBe(false);
  });

  it("returns false when the catalog has no modelFile", () => {
    expect(isLoadedPath(modelFile, undefined)).toBe(false);
  });
});

describe("modelArg", () => {
  const id = "qwen3.8-27b";
  const file = "/home/u/models/qwen3.8-27b/Qwen3.8-27B-Q6_K.gguf";

  it("prefers the absolute GGUF path when known (deterministic boot, no find)", () => {
    expect(modelArg(id, file)).toBe(file);
  });

  it("falls back to the id when no modelFile is available", () => {
    expect(modelArg(id, undefined)).toBe(id);
  });

  it("falls back to the id when modelFile is an empty string", () => {
    expect(modelArg(id, "")).toBe(id);
  });
});

describe("ensureModel", () => {
  let root: string;
  const upstream = "http://127.0.0.1:8080";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mba-switch-"));
  });

  it("is a no-op when the requested model is already loaded", async () => {
    const executor: SwitchExecutor = vi.fn();
    // llama.cpp reports the model by the absolute path it was given via -m.
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: join(root, "m.gguf") }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const result = await ensureModel({
      catalog: [entry("qwen3-coder-30b", join(root, "m.gguf"))],
      requestedId: "qwen3-coder-30b",
      upstreamUrl: upstream,
      switchEnabled: true,
      executor,
      fetch: fetchMock,
    });
    expect(result).toEqual({ status: "loaded", id: "qwen3-coder-30b" });
    expect(executor).not.toHaveBeenCalled();
  });

  it("refuses with 'disabled' when the switch is off, without probing or executing", async () => {
    const executor: SwitchExecutor = vi.fn();
    const fetchMock = vi.fn();
    const result = await ensureModel({
      catalog: [entry("qwen3-coder-30b", join(root, "m.gguf"))],
      requestedId: "qwen3-coder-30b",
      upstreamUrl: upstream,
      switchEnabled: false,
      executor,
      fetch: fetchMock,
    });
    expect(result.status).toBe("disabled");
    expect(executor).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an unknown id with 'unknown' before any switch work", async () => {
    const executor: SwitchExecutor = vi.fn();
    const fetchMock = vi.fn();
    const result = await ensureModel({
      catalog: [entry("qwen3-coder-30b", join(root, "m.gguf"))],
      requestedId: "gpt-9",
      upstreamUrl: upstream,
      switchEnabled: true,
      executor,
      fetch: fetchMock,
    });
    expect(result).toEqual({ status: "unknown", id: "gpt-9" });
    expect(executor).not.toHaveBeenCalled();
  });

  it("runs the executor when the model is not loaded and the switch is on", async () => {
    const executor: SwitchExecutor = vi.fn(async () => undefined);
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: "other-model" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const result = await ensureModel({
      catalog: [entry("qwen3-coder-30b", join(root, "m.gguf"))],
      requestedId: "qwen3-coder-30b",
      upstreamUrl: upstream,
      switchEnabled: true,
      executor,
      fetch: fetchMock,
    });
    expect(result).toEqual({ status: "switched", id: "qwen3-coder-30b" });
    expect(executor).toHaveBeenCalledTimes(1);
    expect(executor).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "qwen3-coder-30b",
        modelFile: join(root, "m.gguf"),
        upstreamUrl: upstream,
      }),
    );
  });

  it("surfaces executor failure as 'failed'", async () => {
    const executor: SwitchExecutor = vi.fn(async () => {
      throw new Error("boot script exited 1");
    });
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const result = await ensureModel({
      catalog: [entry("qwen3-coder-30b", join(root, "m.gguf"))],
      requestedId: "qwen3-coder-30b",
      upstreamUrl: upstream,
      switchEnabled: true,
      executor,
      fetch: fetchMock,
    });
    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("unreachable");
    expect(result.error).toMatch(/boot script exited 1/);
  });
});

describe("resolveProbeTarget (registry → YAML client.url → env → null)", () => {
  const modelFile = "/home/u/models/qwen3.8-27b/Qwen3.8-27B-Q6_K.gguf";
  const regEntry: UpstreamEntry = {
    id: "llama-cpp-8080",
    serverType: "llama.cpp",
    modelFile,
    port: 8080,
    pid: 111,
    startedAt: "2026-08-24T10:00:00.000Z",
  };

  it("prefers the registry-resolved upstream for the model", () => {
    const target = resolveProbeTarget({
      modelFile,
      registry: [regEntry],
      yamlUrl: "http://127.0.0.1:9999/v1",
      envUrl: "http://127.0.0.1:7777",
    });
    expect(target).toBe("http://127.0.0.1:8080");
  });

  it("falls back to the YAML client.url when the registry has no match", () => {
    const target = resolveProbeTarget({
      modelFile,
      registry: [],
      yamlUrl: "http://127.0.0.1:9999/v1",
      envUrl: "http://127.0.0.1:7777",
    });
    expect(target).toBe("http://127.0.0.1:9999");
  });

  it("strips a trailing /v1 from the YAML client.url (probe appends /v1/models)", () => {
    const target = resolveProbeTarget({
      modelFile,
      registry: [],
      yamlUrl: "http://127.0.0.1:9999/v1/",
      envUrl: undefined,
    });
    expect(target).toBe("http://127.0.0.1:9999");
  });

  it("falls back to the env URL when neither registry nor YAML has a match", () => {
    const target = resolveProbeTarget({
      modelFile,
      registry: [],
      yamlUrl: undefined,
      envUrl: "http://127.0.0.1:7777",
    });
    expect(target).toBe("http://127.0.0.1:7777");
  });

  it("returns null when no rung has a target (model not loaded anywhere)", () => {
    const target = resolveProbeTarget({ modelFile, registry: [], yamlUrl: undefined, envUrl: undefined });
    expect(target).toBeNull();
  });

  it("ignores registry entries for OTHER models (per-model resolution)", () => {
    const other: UpstreamEntry = { ...regEntry, id: "other", modelFile: "/home/u/models/other.gguf", port: 9000 };
    const target = resolveProbeTarget({
      modelFile,
      registry: [other],
      yamlUrl: "http://127.0.0.1:9999/v1",
      envUrl: undefined,
    });
    expect(target).toBe("http://127.0.0.1:9999");
  });

  it("skips unhealthy registry entries and falls through to the YAML rung", () => {
    const target = resolveProbeTarget({
      modelFile,
      registry: [regEntry],
      healthyIds: new Set<string>(), // probe failed → entry is stale
      yamlUrl: "http://127.0.0.1:9999/v1",
      envUrl: undefined,
    });
    expect(target).toBe("http://127.0.0.1:9999");
  });
});
