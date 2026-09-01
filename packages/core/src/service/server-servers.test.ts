/**
 * Server-plane routes (ADR-0097 Phase 2): GET /servers, POST /servers/boot,
 * POST /servers/stop.
 *
 * The boot path is driven through the `lifecycleSeams` injection: a fake
 * `spawnImpl` + `fetchImpl` + `killImpl` stand in for the real process and
 * network, so no llama-server is ever spawned in tests. The registry is the
 * single source of truth for what is "running" — the routes read and write
 * it, and the G2 port rule is enforced against it.
 */

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createMbaServiceApp } from "./server.js";
import { defaultStorePaths } from "./config-store.js";
import { readRegistry, writeRegistry, type UpstreamEntry } from "./upstream-registry.js";
import type { LifecycleSeams } from "../mba/server-lifecycle.js";

/** Write a minimal switchable adapter (leaf with a weights file). */
function writeAdapter(dir: string, rel: string, id: string, file: string): void {
  const yamlFile = join(dir, rel);
  mkdirSync(join(yamlFile, ".."), { recursive: true });
  const lines = [
    "apiVersion: mba.c-yard.dev/v1alpha1",
    "kind: ModelBehavioralAdapter",
    "metadata:",
    `  id: ${id}`,
    "identity:",
    "  model:",
    `    file: "${file}"`,
    "bindings: {}",
  ];
  writeFileSync(yamlFile, lines.join("\n"));
}

/**
 * A fake child process: reports a pid, no-ops kill/unref. stdout/stderr are
 * emittable streams so the pipe-capture path (ring buffer + tee) can be
 * driven from tests.
 */
function fakeChild(pid: number): ChildProcess & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  emitOut: (chunk: string) => void;
  emitErr: (chunk: string) => void;
} {
  const out = new EventEmitter();
  const err = new EventEmitter();
  return {
    pid,
    kill: vi.fn(),
    on: vi.fn(),
    once: vi.fn(),
    unref: vi.fn(),
    stdio: [null, null, null],
    stdout: out,
    stderr: err,
    emitOut: (chunk: string) => out.emit("data", Buffer.from(chunk)),
    emitErr: (chunk: string) => err.emit("data", Buffer.from(chunk)),
  } as unknown as ChildProcess & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    emitOut: (chunk: string) => void;
    emitErr: (chunk: string) => void;
  };
}

/**
 * Build a lifecycle-seams fake: spawn returns `pid`, fetch answers /health
 * and /completion with 200, kill records every call. Returns the seams plus
 * the spawn/kill call logs for assertions.
 */
function bootSeams(pid: number): {
  seams: LifecycleSeams;
  spawnCalls: Array<{ binary: string; args: string[]; opts: unknown; child: ReturnType<typeof fakeChild> }>;
  killCalls: Array<[number, NodeJS.Signals | number | undefined]>;
} {
  const spawnCalls: Array<{ binary: string; args: string[]; opts: unknown; child: ReturnType<typeof fakeChild> }> = [];
  const killCalls: Array<[number, NodeJS.Signals | number | undefined]> = [];
  const seams: LifecycleSeams = {
    spawnImpl: (binary, args, opts) => {
      const child = fakeChild(pid);
      spawnCalls.push({ binary, args, opts, child });
      return child;
    },
    fetchImpl: (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/health") || url.includes("/completion")) {
        return new Response(JSON.stringify({ status: "ok" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`ECONNREFUSED ${url}`);
    }) as unknown as typeof fetch,
    killImpl: (p, signal) => {
      killCalls.push([p, signal]);
      return true;
    },
    now: () => 1_000_000,
    healthDeadlineMs: 1000,
    mkdirImpl: vi.fn(),
  };
  return { seams, spawnCalls, killCalls };
}

describe("mba service server plane (ADR-0097 Phase 2)", () => {
  let paths: ReturnType<typeof defaultStorePaths>;
  let adapterDir: string;
  let modelFile: string;
  let modelDir: string;

  beforeEach(() => {
    paths = defaultStorePaths(mkdtempSync(join(tmpdir(), "mba-svc-servers-")));
    adapterDir = mkdtempSync(join(tmpdir(), "mba-svc-servers-adapters-"));
    modelDir = mkdtempSync(join(tmpdir(), "mba-svc-servers-models-"));
    modelFile = join(modelDir, "qwen3.8-27b.gguf");
    writeAdapter(adapterDir, "qwen/qwen3.8-27b/qwen3.8-27b.yaml", "qwen3.8-27b", modelFile);
  });

  // --- GET /servers ---------------------------------------------------------

  it("GET /servers returns an empty list when the registry is empty", async () => {
    const app = createMbaServiceApp({ paths, adapterDir });
    const res = await app.request("/servers");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { servers: unknown[] };
    expect(body.servers).toEqual([]);
  });

  it("GET /servers reports each entry with a live health probe + resolved marker", async () => {
    const entry: UpstreamEntry = {
      id: "llama-cpp-8080",
      serverType: "llama.cpp",
      modelFile,
      port: 8080,
      pid: 2148863,
      startedAt: "2026-08-24T02:00:00.000Z",
    };
    writeRegistry(paths.upstreamsPath, [entry]);
    // A fetch that answers /health 200 for port 8080.
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/health")) {
        return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
      }
      throw new Error(`ECONNREFUSED ${url}`);
    }) as unknown as typeof fetch;
    const app = createMbaServiceApp({ paths, adapterDir, fetch: fetchImpl });
    const res = await app.request("/servers");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      servers: Array<{ id: string; port: number; pid: number; healthy: boolean; resolved: boolean }>;
    };
    expect(body.servers).toHaveLength(1);
    expect(body.servers[0]).toMatchObject({
      id: "llama-cpp-8080",
      port: 8080,
      pid: 2148863,
      healthy: true,
      resolved: true,
    });
  });

  it("GET /servers labels same-model losers as duplicates (Q2)", async () => {
    const older: UpstreamEntry = {
      id: "llama-cpp-8080",
      serverType: "llama.cpp",
      modelFile,
      port: 8080,
      pid: 111,
      startedAt: "2026-08-24T02:00:00.000Z",
    };
    const newer: UpstreamEntry = {
      id: "llama-cpp-9123",
      serverType: "llama.cpp",
      modelFile,
      port: 9123,
      pid: 222,
      startedAt: "2026-08-24T03:00:00.000Z",
    };
    writeRegistry(paths.upstreamsPath, [older, newer]);
    // Both ports answer /health 200 → both healthy → newest startedAt wins.
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/health")) {
        return new Response(JSON.stringify({ status: "ok" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`ECONNREFUSED ${url}`);
    }) as unknown as typeof fetch;
    const app = createMbaServiceApp({ paths, adapterDir, fetch: fetchImpl });
    const res = await app.request("/servers");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      servers: Array<{
        id: string;
        healthy: boolean;
        resolved: boolean;
        duplicate?: boolean;
      }>;
    };
    const byId = new Map(body.servers.map((s) => [s.id, s]));
    // Newest healthy entry wins resolution.
    expect(byId.get("llama-cpp-9123")).toMatchObject({
      healthy: true,
      resolved: true,
      duplicate: false,
    });
    // The older same-model entry is a labeled duplicate.
    expect(byId.get("llama-cpp-8080")).toMatchObject({
      healthy: true,
      resolved: false,
      duplicate: true,
    });
  });

  it("GET /servers marks an unreachable entry as not healthy", async () => {
    const entry: UpstreamEntry = {
      id: "llama-cpp-9999",
      serverType: "llama.cpp",
      modelFile,
      port: 9999,
      pid: 1,
      startedAt: "2026-08-24T02:00:00.000Z",
    };
    writeRegistry(paths.upstreamsPath, [entry]);
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const app = createMbaServiceApp({ paths, adapterDir, fetch: fetchImpl });
    const res = await app.request("/servers");
    const body = (await res.json()) as {
      servers: Array<{ id: string; healthy: boolean; resolved: boolean }>;
    };
    expect(body.servers[0]).toMatchObject({ id: "llama-cpp-9999", healthy: false, resolved: false });
  });

  // --- POST /servers/boot ---------------------------------------------------

  it("POST /servers/boot boots the model, registers it, and returns the entry", async () => {
    const { seams, spawnCalls } = bootSeams(424242);
    const app = createMbaServiceApp({ paths, adapterDir, lifecycleSeams: seams });
    const res = await app.request("/servers/boot", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ modelFile, port: 9123 }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      port: number;
      pid: number;
      modelFile: string;
      serverType: string;
    };
    expect(body).toMatchObject({
      id: "llama-cpp-9123",
      port: 9123,
      pid: 424242,
      modelFile,
      serverType: "llama.cpp",
    });
    // The registry now holds the booted server.
    const reg = readRegistry(paths.upstreamsPath);
    expect(reg).toHaveLength(1);
    expect(reg[0]).toMatchObject({ id: "llama-cpp-9123", port: 9123, pid: 424242 });
    // Deployment facts were prepended; the tuning recipe follows.
    const call = spawnCalls[0]!;
    expect(call.args).toContain("-m");
    expect(call.args[call.args.indexOf("-m") + 1]).toBe(modelFile);
    expect(call.args).toContain("--port");
    expect(call.args[call.args.indexOf("--port") + 1]).toBe("9123");
    expect(call.args).toContain("--slot-save-path");
    expect(call.opts).toMatchObject({ detached: true });
  });

  // --- GET /servers/logs ----------------------------------------------------

  it("GET /servers/logs returns the captured lines for a booted server", async () => {
    const { seams, spawnCalls } = bootSeams(424242);
    const app = createMbaServiceApp({ paths, adapterDir, lifecycleSeams: seams });
    const boot = await app.request("/servers/boot", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ modelFile, port: 9123 }),
    });
    expect(boot.status).toBe(201);

    // Drive the pipe: the daemon line-splits into the ring buffer.
    const child = spawnCalls[0]!.child;
    child.emitOut("loading model\n");
    child.emitOut("ready\n");

    const res = await app.request("/servers/logs?id=llama-cpp-9123");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; lines: string[] };
    expect(body.id).toBe("llama-cpp-9123");
    expect(body.lines).toEqual(["loading model", "ready"]);
  });

  it("GET /servers/logs honours the lines query param (last N)", async () => {
    const { seams, spawnCalls } = bootSeams(424242);
    const app = createMbaServiceApp({ paths, adapterDir, lifecycleSeams: seams });
    await app.request("/servers/boot", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ modelFile, port: 9123 }),
    });
    const child = spawnCalls[0]!.child;
    child.emitOut("one\ntwo\nthree\n");

    const res = await app.request("/servers/logs?id=llama-cpp-9123&lines=2");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { lines: string[] };
    expect(body.lines).toEqual(["two", "three"]);
  });

  it("GET /servers/logs returns 404 for an unknown id", async () => {
    const { seams } = bootSeams(424242);
    const app = createMbaServiceApp({ paths, adapterDir, lifecycleSeams: seams });
    const res = await app.request("/servers/logs?id=llama-cpp-9999");
    expect(res.status).toBe(404);
  });

  it("POST /servers/boot refuses a port already in use (G2) with 409", async () => {
    const existing: UpstreamEntry = {
      id: "llama-cpp-9123",
      serverType: "llama.cpp",
      modelFile: "/other/model.gguf",
      port: 9123,
      pid: 111,
      startedAt: "2026-08-24T02:00:00.000Z",
    };
    writeRegistry(paths.upstreamsPath, [existing]);
    const { seams, spawnCalls } = bootSeams(424242);
    // Simulate the OS port being occupied (the self-healing G2 check).
    const seamsWithBusyPort: LifecycleSeams = { ...seams, portCheckImpl: async () => false };
    const app = createMbaServiceApp({ paths, adapterDir, lifecycleSeams: seamsWithBusyPort });
    const res = await app.request("/servers/boot", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ modelFile, port: 9123 }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/port 9123/i);
    // No spawn happened — the port was refused before any process was started.
    expect(spawnCalls).toHaveLength(0);
  });

  it("POST /servers/boot refuses a second server for the same model (Q1) with 409", async () => {
    const existing: UpstreamEntry = {
      id: "llama-cpp-8080",
      serverType: "llama.cpp",
      modelFile,
      port: 8080,
      pid: 111,
      startedAt: "2026-08-24T02:00:00.000Z",
    };
    writeRegistry(paths.upstreamsPath, [existing]);
    const { seams, spawnCalls } = bootSeams(424242);
    const app = createMbaServiceApp({ paths, adapterDir, lifecycleSeams: seams });
    const res = await app.request("/servers/boot", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ modelFile, port: 9123 }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    // The error names the existing server so the user can stop it first.
    expect(body.error).toMatch(/llama-cpp-8080/);
    expect(body.error).toMatch(/8080/);
    // No spawn happened — the duplicate was refused before any process started.
    expect(spawnCalls).toHaveLength(0);
    // The registry is untouched (still just the original entry).
    expect(readRegistry(paths.upstreamsPath)).toHaveLength(1);
  });

  it("POST /servers/boot still allows a new port for a DIFFERENT model (G2)", async () => {
    const otherModel = join(modelDir, "other-7b.gguf");
    writeAdapter(adapterDir, "other/other-7b/other-7b.yaml", "other-7b", otherModel);
    const existing: UpstreamEntry = {
      id: "llama-cpp-8080",
      serverType: "llama.cpp",
      modelFile,
      port: 8080,
      pid: 111,
      startedAt: "2026-08-24T02:00:00.000Z",
    };
    writeRegistry(paths.upstreamsPath, [existing]);
    const { seams, spawnCalls } = bootSeams(424242);
    const app = createMbaServiceApp({ paths, adapterDir, lifecycleSeams: seams });
    const res = await app.request("/servers/boot", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ modelFile: otherModel, port: 9123 }),
    });
    expect(res.status).toBe(201);
    expect(spawnCalls).toHaveLength(1);
    // Both entries now coexist (merge, never clobber).
    const reg = readRegistry(paths.upstreamsPath);
    expect(reg).toHaveLength(2);
  });

  it("POST /servers/boot rejects a missing modelFile with 400", async () => {
    const { seams } = bootSeams(424242);
    const app = createMbaServiceApp({ paths, adapterDir, lifecycleSeams: seams });
    const res = await app.request("/servers/boot", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ port: 9123 }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /servers/boot rejects an unknown model (not in the catalog) with 404", async () => {
    const { seams, spawnCalls } = bootSeams(424242);
    const app = createMbaServiceApp({ paths, adapterDir, lifecycleSeams: seams });
    const res = await app.request("/servers/boot", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ modelFile: "/nope/unknown.gguf", port: 9123 }),
    });
    expect(res.status).toBe(404);
    expect(spawnCalls).toHaveLength(0);
  });

  it("POST /servers/boot reports a boot failure (health timeout) as 500", async () => {
    // A fetch that never answers /health → health check times out.
    // No fixed `now` here: the real clock must advance so the 100ms health
    // deadline is actually reached (a frozen clock would loop forever).
    const seams: LifecycleSeams = {
      spawnImpl: () => fakeChild(424242),
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
      killImpl: () => true,
      healthDeadlineMs: 100,
    };
    const app = createMbaServiceApp({ paths, adapterDir, lifecycleSeams: seams });
    const res = await app.request("/servers/boot", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ modelFile, port: 9123 }),
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/health|timed out/i);
    // A failed boot must not leave a registry entry behind.
    expect(readRegistry(paths.upstreamsPath)).toHaveLength(0);
  });

  // --- POST /servers/stop ---------------------------------------------------

  it("POST /servers/stop kills the group and removes the registry entry", async () => {
    const entry: UpstreamEntry = {
      id: "llama-cpp-9123",
      serverType: "llama.cpp",
      modelFile,
      port: 9123,
      pid: 424242,
      startedAt: "2026-08-24T02:00:00.000Z",
    };
    writeRegistry(paths.upstreamsPath, [entry]);
    const killCalls: Array<[number, NodeJS.Signals | number | undefined]> = [];
    const seams: LifecycleSeams = {
      killImpl: (p, signal) => {
        killCalls.push([p, signal]);
        // First probe (signal 0) reports alive; after SIGTERM the group is gone.
        return signal === 0 ? killCalls.filter((c) => c[1] === 0).length <= 1 : true;
      },
    };
    const app = createMbaServiceApp({ paths, adapterDir, lifecycleSeams: seams });
    const res = await app.request("/servers/stop", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pid: 424242 }),
    });
    expect(res.status).toBe(200);
    // The group was signalled (negative pid = process group).
    expect(killCalls.some(([p]) => p === -424242)).toBe(true);
    // The registry entry is gone.
    expect(readRegistry(paths.upstreamsPath)).toHaveLength(0);
  });

  it("POST /servers/stop rejects a missing pid with 400", async () => {
    const app = createMbaServiceApp({ paths, adapterDir });
    const res = await app.request("/servers/stop", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  // --- Phase 3: type-table dispatch (Ollama proof) --------------------------

  it("POST /servers/boot boots an ollama model (no spawn, no pid) and registers it", async () => {
    const tag = "qwen3.8:27b";
    const calls: Array<{ method: string; url: string }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ method, url });
      if (url.includes("/api/tags")) {
        return new Response(JSON.stringify({ models: [{ name: tag }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/api/generate")) {
        return new Response(JSON.stringify({ status: "success" }), { status: 200 });
      }
      throw new Error(`unexpected url ${url}`);
    }) as unknown as typeof fetch;
    // The Ollama boot is a lifecycle op — it uses the seams' fetch. Build the
    // seams inline so the fetch is the Ollama fake (spawn is still recorded to
    // prove no process is started).
    const spawnCalls: Array<{ binary: string; args: string[]; opts: unknown }> = [];
    const seams: LifecycleSeams = {
      spawnImpl: (binary, args, opts) => {
        spawnCalls.push({ binary, args, opts });
        return fakeChild(424242);
      },
      fetchImpl,
      killImpl: () => true,
      now: () => 1_000_000,
      healthDeadlineMs: 1000,
    };
    const app = createMbaServiceApp({
      paths,
      adapterDir,
      lifecycleSeams: seams,
      fetch: fetchImpl,
    });
    const res = await app.request("/servers/boot", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ serverType: "ollama", modelRef: tag, port: 11434 }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; serverType: string; pid?: number };
    expect(body).toMatchObject({ id: "ollama-11434", serverType: "ollama" });
    expect(body.pid).toBeUndefined();
    // No process was spawned — Ollama loads in its own daemon.
    expect(spawnCalls).toHaveLength(0);
    expect(calls.some((c) => c.method === "POST" && c.url.includes("/api/generate"))).toBe(true);
    const reg = readRegistry(paths.upstreamsPath);
    expect(reg).toHaveLength(1);
    expect(reg[0]).toMatchObject({ id: "ollama-11434", serverType: "ollama" });
  });

  it("POST /servers/boot rejects an unknown serverType with 400", async () => {
    const { seams } = bootSeams(424242);
    const app = createMbaServiceApp({ paths, adapterDir, lifecycleSeams: seams });
    const res = await app.request("/servers/boot", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ serverType: "vllm", modelFile, port: 9123 }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /servers/stop by id stops an ollama entry (no kill, entry removed)", async () => {
    const entry: UpstreamEntry = {
      id: "ollama-11434",
      serverType: "ollama",
      modelFile: "qwen3.8:27b",
      port: 11434,
      startedAt: "2026-08-25T02:00:00.000Z",
    };
    writeRegistry(paths.upstreamsPath, [entry]);
    const killCalls: Array<[number, NodeJS.Signals | number | undefined]> = [];
    const calls: Array<{ method: string; url: string }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ method, url });
      return new Response(JSON.stringify({ status: "success" }), { status: 200 });
    }) as unknown as typeof fetch;
    const seams: LifecycleSeams = {
      killImpl: (p, signal) => {
        killCalls.push([p, signal]);
        return true;
      },
      fetchImpl,
    };
    const app = createMbaServiceApp({ paths, adapterDir, lifecycleSeams: seams });
    const res = await app.request("/servers/stop", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "ollama-11434" }),
    });
    expect(res.status).toBe(200);
    // Unloaded via the API — no process signal was sent.
    expect(killCalls).toHaveLength(0);
    expect(calls.some((c) => c.method === "POST" && c.url.includes("/api/generate"))).toBe(true);
    expect(readRegistry(paths.upstreamsPath)).toHaveLength(0);
  });

  it("GET /servers probes an ollama entry via /api/tags, not /health", async () => {
    const entry: UpstreamEntry = {
      id: "ollama-11434",
      serverType: "ollama",
      modelFile: "qwen3.8:27b",
      port: 11434,
      startedAt: "2026-08-25T02:00:00.000Z",
    };
    writeRegistry(paths.upstreamsPath, [entry]);
    const urls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("/api/tags")) {
        return new Response(JSON.stringify({ models: [] }), { status: 200 });
      }
      throw new Error(`unexpected url ${url}`);
    }) as unknown as typeof fetch;
    const app = createMbaServiceApp({ paths, adapterDir, fetch: fetchImpl });
    const res = await app.request("/servers");
    const body = (await res.json()) as {
      servers: Array<{ id: string; healthy: boolean; resolved: boolean }>;
    };
    expect(body.servers[0]).toMatchObject({ id: "ollama-11434", healthy: true, resolved: true });
    expect(urls.some((u) => u.includes("/api/tags"))).toBe(true);
    expect(urls.some((u) => u.includes("/health"))).toBe(false);
  });
});
