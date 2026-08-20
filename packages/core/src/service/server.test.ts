import { mkdtempSync } from "node:fs";
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
    };
    expect(body.version).toBe(0);
    expect(body.model).toBe("llama-3.1-8b");
    expect(body.tcb).toEqual(defaultToolCircuitBreakerConfig());
    expect(body.ruleClasses).toEqual({});
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
      paths: { baseDir: string; tcbPath: string };
    };
    expect(body.version).toBe(0);
    expect(body.uptimeMs).toBeGreaterThanOrEqual(0);
    expect(body.paths.baseDir).toBe(paths.baseDir);
    expect(body.paths.tcbPath).toBe(paths.tcbPath);
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
