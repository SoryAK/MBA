import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import { createMbaServiceApp } from "./server.js";
import { defaultStorePaths } from "./config-store.js";
import { defaultToolCircuitBreakerConfig } from "../bcb/default-config.js";
import { BUILTIN_RULE_CLASSES } from "../bcb/rule-classes.js";

describe("mba service app", () => {
  let paths: ReturnType<typeof defaultStorePaths>;

  beforeEach(() => {
    paths = defaultStorePaths(mkdtempSync(join(tmpdir(), "mba-svc-")));
  });

  it("GET /resolve_config returns the global layer + version", async () => {
    const app = createMbaServiceApp({ paths });
    const res = await app.request("/resolve_config?model=llama-3.1-8b");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      version: number;
      model: string | null;
      tcb: unknown;
      ruleClasses: unknown;
      machineOverlay: string;
    };
    expect(body.version).toBe(0);
    expect(body.model).toBe("llama-3.1-8b");
    expect(body.tcb).toEqual(defaultToolCircuitBreakerConfig());
    expect(body.ruleClasses).toEqual({});
    expect(body.machineOverlay).toBe("enforce");
  });

  it("POST /set_rules persists, bumps the version, and is visible to resolve_config", async () => {
    const app = createMbaServiceApp({ paths });
    const res = await app.request("/set_rules", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tcb: defaultToolCircuitBreakerConfig(),
        ruleClasses: BUILTIN_RULE_CLASSES,
      }),
    });
    expect(res.status).toBe(200);
    const setBody = (await res.json()) as { version: number };
    expect(setBody.version).toBe(1);

    const after = await app.request("/resolve_config");
    const afterBody = (await after.json()) as {
      version: number;
      ruleClasses: unknown;
    };
    expect(afterBody.version).toBe(1);
    expect(afterBody.ruleClasses).toEqual(BUILTIN_RULE_CLASSES);
  });

  it("POST /set_rules rejects an invalid TCB shape with 400", async () => {
    const app = createMbaServiceApp({ paths });
    const res = await app.request("/set_rules", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tcb: { nope: true } }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/ToolCircuitBreakerConfig/);
  });

  it("POST /set_rules rejects an invalid rule-class registry with 400", async () => {
    const app = createMbaServiceApp({ paths });
    const res = await app.request("/set_rules", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tcb: defaultToolCircuitBreakerConfig(),
        ruleClasses: { not: "a registry" },
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/RuleClassRegistry/);
  });

  it("POST /set_rules rejects a malformed JSON body with 400", async () => {
    const app = createMbaServiceApp({ paths });
    const res = await app.request("/set_rules", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ not json",
    });
    expect(res.status).toBe(400);
  });

  it("GET /status reports version, uptime, and paths", async () => {
    const app = createMbaServiceApp({ paths });
    const res = await app.request("/status");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      version: number;
      uptimeMs: number;
      pairing: { active: boolean; count: number; integrity: string; blocked: boolean; sessions: unknown[] };
      registry: { integrity: string; blocked: boolean; count: number };
      paths: { baseDir: string; tcbPath: string };
      machineOverlay: { mode: string };
      models: unknown[];
      servers: unknown[];
      watches: { modelId: string | null; watches: unknown[] };
    };
    expect(body.version).toBe(0);
    expect(body.uptimeMs).toBeGreaterThanOrEqual(0);
    expect(body.pairing).toEqual({
      active: false,
      blocked: false,
      count: 0,
      integrity: "missing",
      sessions: [],
    });
    expect(body.registry).toEqual({ blocked: false, count: 0, integrity: "missing" });
    expect(body.paths.baseDir).toBe(paths.baseDir);
    expect(body.paths.tcbPath).toBe(paths.tcbPath);
    expect(body).toMatchObject({
      machineOverlay: { mode: "enforce" },
      models: [],
      servers: [],
      watches: { modelId: null, watches: expect.any(Array) },
    });
    expect(body.watches.watches).toHaveLength(3);
  });

  it("GET /status reports corrupt session state as blocked", async () => {
    mkdirSync(join(paths.sessionsPath, ".."), { recursive: true });
    writeFileSync(paths.sessionsPath, "{ not json", "utf8");
    const app = createMbaServiceApp({ paths });

    const res = await app.request("/status");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      pairing: {
        active: false,
        blocked: true,
        count: 0,
        integrity: "corrupt",
        error: expect.stringMatching(/valid JSON/),
        sessions: [],
      },
    });
  });

  it("GET /status reports corrupt registry state as blocked", async () => {
    mkdirSync(join(paths.upstreamsPath, ".."), { recursive: true });
    writeFileSync(paths.upstreamsPath, "{ not json", "utf8");
    const app = createMbaServiceApp({ paths });

    const res = await app.request("/status");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      registry: {
        blocked: true,
        count: 0,
        integrity: "corrupt",
        error: expect.stringMatching(/valid JSON/),
      },
    });
  });

  it("GET /config/machine-overlay returns the default enforce mode", async () => {
    const app = createMbaServiceApp({ paths });
    const res = await app.request("/config/machine-overlay");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { mode: string };
    expect(body.mode).toBe("enforce");
  });

  it("POST /config/machine-overlay persists a new mode and bumps the version", async () => {
    const app = createMbaServiceApp({ paths });
    const res = await app.request("/config/machine-overlay", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "warn" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { mode: string; version: number };
    expect(body.mode).toBe("warn");
    expect(body.version).toBe(1);

    const after = await app.request("/config/machine-overlay");
    const afterBody = (await after.json()) as { mode: string };
    expect(afterBody.mode).toBe("warn");
  });

  it("POST /config/machine-overlay rejects an invalid mode with 400", async () => {
    const app = createMbaServiceApp({ paths });
    const res = await app.request("/config/machine-overlay", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "nope" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/mode must be one of/);
  });

  it("shares state across app instances on the same paths (files are truth)", async () => {
    const appA = createMbaServiceApp({ paths });
    await appA.request("/set_rules", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tcb: defaultToolCircuitBreakerConfig() }),
    });
    // A second instance (e.g. a service restart) sees the bumped version.
    const appB = createMbaServiceApp({ paths });
    const res = await appB.request("/resolve_config");
    const body = (await res.json()) as { version: number };
    expect(body.version).toBe(1);
  });
});
