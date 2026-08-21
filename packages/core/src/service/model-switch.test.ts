import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { probeLoadedModel, ensureModel, type SwitchExecutor } from "./model-switch.js";
import type { CatalogEntry } from "./model-catalog.js";

function entry(id: string, modelFile: string): CatalogEntry {
  return { id, name: id, family: undefined, modelFile };
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

describe("ensureModel", () => {
  let root: string;
  const upstream = "http://127.0.0.1:8080";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mba-switch-"));
  });

  it("is a no-op when the requested model is already loaded", async () => {
    const executor: SwitchExecutor = vi.fn();
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: "qwen3-coder-30b" }] }), {
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
