import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readServiceInfoOrNull,
  resolveServiceBaseUrl,
  fetchResolveConfig,
  fetchSetRules,
  fetchStatus,
  fetchModels,
  fetchEnsureModel,
} from "./service-client.js";

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("service-client", () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "mba-mcp-svc-"));
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
    delete process.env.CYARD_MBA_SERVICE_URL;
  });

  describe("readServiceInfoOrNull", () => {
    it("returns null when the discovery file is missing", () => {
      expect(readServiceInfoOrNull(baseDir)).toBeNull();
    });

    it("parses a valid discovery file", () => {
      mkdirSync(join(baseDir, "mba"), { recursive: true });
      writeFileSync(
        join(baseDir, "mba", "service.json"),
        JSON.stringify({ port: 4321, pid: 999, startedAt: "2026-08-20T00:00:00Z" }),
      );
      expect(readServiceInfoOrNull(baseDir)).toEqual({
        port: 4321,
        pid: 999,
        startedAt: "2026-08-20T00:00:00Z",
      });
    });

    it("returns null on malformed discovery file", () => {
      mkdirSync(join(baseDir, "mba"), { recursive: true });
      writeFileSync(join(baseDir, "mba", "service.json"), "{not json");
      expect(readServiceInfoOrNull(baseDir)).toBeNull();
    });

    it("returns null when port is not an integer", () => {
      mkdirSync(join(baseDir, "mba"), { recursive: true });
      writeFileSync(join(baseDir, "mba", "service.json"), JSON.stringify({ port: "4321" }));
      expect(readServiceInfoOrNull(baseDir)).toBeNull();
    });
  });

  describe("resolveServiceBaseUrl", () => {
    it("prefers an explicit baseUrl", () => {
      expect(resolveServiceBaseUrl({ baseUrl: "http://127.0.0.1:1" })).toBe(
        "http://127.0.0.1:1",
      );
    });

    it("falls back to CYARD_MBA_SERVICE_URL", () => {
      process.env.CYARD_MBA_SERVICE_URL = "http://127.0.0.1:2";
      expect(resolveServiceBaseUrl({ baseDir })).toBe("http://127.0.0.1:2");
    });

    it("falls back to the discovery file", () => {
      mkdirSync(join(baseDir, "mba"), { recursive: true });
      writeFileSync(
        join(baseDir, "mba", "service.json"),
        JSON.stringify({ port: 4321, pid: 1, startedAt: "" }),
      );
      expect(resolveServiceBaseUrl({ baseDir })).toBe("http://127.0.0.1:4321");
    });

    it("returns null when nothing is available", () => {
      expect(resolveServiceBaseUrl({ baseDir })).toBeNull();
    });
  });

  describe("fetch calls", () => {
    it("fetchResolveConfig returns parsed body on 200", async () => {
      const res = await fetchResolveConfig(
        { baseUrl: "http://x", fetchImpl: (async () => okJson({ version: 3, model: null, tcb: {}, ruleClasses: {} })) as typeof fetch },
        "qwen3",
      );
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.data.version).toBe(3);
    });

    it("fetchResolveConfig passes the model query param", async () => {
      let seenUrl = "";
      const res = await fetchResolveConfig(
        {
          baseUrl: "http://x",
          fetchImpl: (async (url: string) => {
            seenUrl = url;
            return okJson({ version: 0, model: null, tcb: {}, ruleClasses: {} });
          }) as typeof fetch,
        },
        "my model",
      );
      expect(res.ok).toBe(true);
      expect(seenUrl).toBe("http://x/resolve_config?model=my%20model");
    });

    it("fetchSetRules POSTs the body", async () => {
      let seenInit: RequestInit | undefined;
      const res = await fetchSetRules(
        {
          baseUrl: "http://x",
          fetchImpl: (async (_url: string, init?: RequestInit) => {
            seenInit = init;
            return okJson({ version: 7, tcb: {} });
          }) as typeof fetch,
        },
        { tcb: { rules: [] } },
      );
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.data.version).toBe(7);
      expect(seenInit?.method).toBe("POST");
      expect(JSON.parse(String(seenInit?.body))).toEqual({ tcb: { rules: [] } });
    });

    it("fetchStatus returns parsed body on 200", async () => {
      const res = await fetchStatus({
        baseUrl: "http://x",
        fetchImpl: (async () => okJson({ version: 1, uptimeMs: 5, paths: {} })) as typeof fetch,
      });
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.data.uptimeMs).toBe(5);
    });

    it("returns a structured error when no base URL is available", async () => {
      const res = await fetchStatus({ baseDir });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toMatch(/no base URL/);
    });

    it("returns a structured error on non-2xx", async () => {
      const res = await fetchSetRules(
        {
          baseUrl: "http://x",
          fetchImpl: (async () =>
            new Response("body.tcb must be a valid ToolCircuitBreakerConfig", { status: 400 })) as typeof fetch,
        },
        { tcb: null },
      );
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error).toMatch(/HTTP 400/);
        expect(res.error).toMatch(/must be a valid ToolCircuitBreakerConfig/);
      }
    });

    it("returns a structured error when fetch throws (unreachable)", async () => {
      const res = await fetchStatus({
        baseUrl: "http://x",
        fetchImpl: (async () => {
          throw new Error("fetch failed");
        }) as typeof fetch,
      });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toMatch(/service unreachable: fetch failed/);
    });

    it("times out via AbortController", async () => {
      const res = await fetchStatus({
        baseUrl: "http://x",
        timeoutMs: 10,
        fetchImpl: (async (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          })) as typeof fetch,
      });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toMatch(/service unreachable/);
    });
  });

  describe("model plane calls (ADR-0093 Phase 2)", () => {
    it("fetchModels returns the parsed catalog on 200", async () => {
      const res = await fetchModels({
        baseUrl: "http://x",
        fetchImpl: (async () =>
          okJson({
            models: [
              { id: "qwen3-coder-30b", name: "Qwen3 Coder 30B", family: "qwen3-coder", modelFile: "/m.gguf", loaded: true },
            ],
          })) as typeof fetch,
      });
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.data.models[0]?.id).toBe("qwen3-coder-30b");
    });

    it("fetchEnsureModel POSTs the id and returns the result on 200", async () => {
      let seenInit: RequestInit | undefined;
      const res = await fetchEnsureModel(
        {
          baseUrl: "http://x",
          fetchImpl: (async (_url: string, init?: RequestInit) => {
            seenInit = init;
            return okJson({ status: "switched", id: "qwen3-coder-30b" });
          }) as typeof fetch,
        },
        "qwen3-coder-30b",
      );
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.data.status).toBe("switched");
      expect(seenInit?.method).toBe("POST");
      expect(JSON.parse(String(seenInit?.body))).toEqual({ id: "qwen3-coder-30b" });
    });

    it("fetchEnsureModel surfaces a 409 disabled body as a structured error", async () => {
      const res = await fetchEnsureModel(
        {
          baseUrl: "http://x",
          fetchImpl: (async () =>
            new Response(
              JSON.stringify({ error: "model switching is disabled (set MBA_MODEL_SWITCH=on to arm)" }),
              { status: 409, headers: { "content-type": "application/json" } },
            )) as typeof fetch,
        },
        "qwen3-coder-30b",
      );
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error).toMatch(/HTTP 409/);
        expect(res.error).toMatch(/disabled/);
      }
    });

    it("fetchEnsureModel surfaces a 404 unknown-id body as a structured error", async () => {
      const res = await fetchEnsureModel(
        {
          baseUrl: "http://x",
          fetchImpl: (async () =>
            new Response(JSON.stringify({ status: "unknown", id: "gpt-9" }), {
              status: 404,
              headers: { "content-type": "application/json" },
            })) as typeof fetch,
        },
        "gpt-9",
      );
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error).toMatch(/HTTP 404/);
        expect(res.error).toMatch(/gpt-9/);
      }
    });
  });
});
