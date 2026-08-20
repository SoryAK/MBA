import { describe, it, expect } from "vitest";
import type { LoadedAdapter } from "../adapter/loader.js";
import { createResolveConfigHandler } from "./resolve-config.js";
import { createSetRulesHandler } from "./set-rules.js";
import { createServerStatusHandler } from "./server-status.js";
import { createModelRegistryHandler } from "./model-registry.js";

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const adapters: LoadedAdapter[] = [
  {
    path: "/x/qwen3.yaml",
    adapter: {
      apiVersion: "mba.c-yard.dev/v1alpha1",
      kind: "ModelBehavioralAdapter",
      metadata: { id: "qwen3-8b", name: "Qwen3 8B", family: "qwen3" },
      identity: {
        model: {
          family: "qwen3",
          name: "Qwen3-8B",
          file: "qwen3-8b.gguf",
        },
      },
      bindings: { bcb: "bcb/qwen3.yaml", structural: "structural/qwen3.yaml" },
    },
  },
  {
    path: "/x/llama.yaml",
    adapter: {
      apiVersion: "mba.c-yard.dev/v1alpha1",
      kind: "ModelBehavioralAdapter",
      metadata: { id: "llama3-8b" },
      identity: { model: { family: "llama3" } },
      bindings: {},
    },
  },
];

describe("mba_model_registry", () => {
  const handle = createModelRegistryHandler(adapters);

  it("lists every adapter with its light fields", () => {
    const out = handle();
    expect(out.count).toBe(2);
    expect(out.models[0]!).toMatchObject({
      id: "qwen3-8b",
      name: "Qwen3 8B",
      family: "qwen3",
      modelFamily: "qwen3",
      modelName: "Qwen3-8B",
      modelFile: "qwen3-8b.gguf",
    });
    expect(out.models[0]!.bindings.bcb).toBe("bcb/qwen3.yaml");
    expect(out.models[0]!.bindings.tcb).toBeUndefined();
  });

  it("tolerates adapters with sparse metadata", () => {
    const out = handle();
    expect(out.models[1]!).toMatchObject({ id: "llama3-8b", modelFamily: "llama3" });
    expect(out.models[1]!.name).toBeUndefined();
    expect(out.models[1]!.bindings).toEqual({});
  });

  it("returns an empty listing when no adapters are loaded", () => {
    expect(createModelRegistryHandler([])()).toEqual({ count: 0, models: [] });
  });
});

describe("mba_resolve_config", () => {
  it("returns the service body on success", async () => {
    const handle = createResolveConfigHandler({
      baseUrl: "http://x",
      fetchImpl: (async () =>
        okJson({ version: 4, model: "qwen3", tcb: { rules: [] }, ruleClasses: {} })) as typeof fetch,
    });
    const out = await handle({ model: "qwen3" });
    expect(out.error).toBeUndefined();
    expect(out).toMatchObject({ version: 4, model: "qwen3" });
  });

  it("surfaces a structured error when the service is unreachable", async () => {
    const handle = createResolveConfigHandler({
      baseUrl: "http://x",
      fetchImpl: (async () => {
        throw new Error("fetch failed");
      }) as typeof fetch,
    });
    const out = await handle({});
    expect(out.error).toMatch(/service unreachable/);
  });
});

describe("mba_set_rules", () => {
  it("returns the new version on success", async () => {
    const handle = createSetRulesHandler({
      baseUrl: "http://x",
      fetchImpl: (async () => okJson({ version: 9, tcb: { rules: [] } })) as typeof fetch,
    });
    const out = await handle({ tcb: { rules: [] } });
    expect(out.error).toBeUndefined();
    expect(out).toMatchObject({ version: 9 });
  });

  it("surfaces the service 400 message", async () => {
    const handle = createSetRulesHandler({
      baseUrl: "http://x",
      fetchImpl: (async () =>
        new Response("body.tcb must be a valid ToolCircuitBreakerConfig", { status: 400 })) as typeof fetch,
    });
    const out = await handle({ tcb: null });
    expect(out.error).toMatch(/HTTP 400/);
  });
});

describe("mba_server_status", () => {
  it("returns the status body on success", async () => {
    const handle = createServerStatusHandler({
      baseUrl: "http://x",
      fetchImpl: (async () =>
        okJson({ version: 2, uptimeMs: 1234, paths: { baseDir: "/b", tcbPath: "/t", ruleClassesPath: "/r", versionPath: "/v" } })) as typeof fetch,
    });
    const out = await handle();
    expect(out.error).toBeUndefined();
    expect(out).toMatchObject({ version: 2, uptimeMs: 1234 });
  });

  it("surfaces a structured error when unreachable", async () => {
    const handle = createServerStatusHandler({
      baseUrl: "http://x",
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED");
      }) as typeof fetch,
    });
    const out = await handle();
    expect(out.error).toMatch(/service unreachable/);
  });
});
