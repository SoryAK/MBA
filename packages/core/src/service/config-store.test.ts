import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import {
  defaultStorePaths,
  readGlobalConfig,
  setMachineOverlay,
  setRules,
  writeServiceInfo,
  readServiceInfoOrNull,
} from "./config-store.js";
import { defaultToolCircuitBreakerConfig } from "../bcb/default-config.js";
import { BUILTIN_RULE_CLASSES } from "../bcb/rule-classes.js";

function tempPaths(): ReturnType<typeof defaultStorePaths> {
  const dir = mkdtempSync(join(tmpdir(), "mba-store-"));
  return defaultStorePaths(dir);
}

describe("config-store", () => {
  let paths: ReturnType<typeof defaultStorePaths>;

  beforeEach(() => {
    paths = tempPaths();
  });

  it("seeds defaults on first boot when nothing exists", () => {
    const cfg = readGlobalConfig(paths);
    expect(cfg.tcb).toEqual(defaultToolCircuitBreakerConfig());
    expect(cfg.ruleClasses).toEqual({});
    expect(cfg.version).toBe(0);
    // Seeded to disk.
    expect(existsSync(paths.tcbPath)).toBe(true);
  });

  it("resolves the upstream registry path under the mba/ subdir", () => {
    expect(paths.upstreamsPath).toBe(join(paths.baseDir, "mba", "upstreams.json"));
    expect(paths.sessionsPath).toBe(join(paths.baseDir, "mba", "sessions.json"));
    expect(paths.clientsPath).toBe(join(paths.baseDir, "mba", "clients.json"));
  });

  it("reads back a persisted TCB config", () => {
    readGlobalConfig(paths); // seed
    const custom = { ...defaultToolCircuitBreakerConfig() };
    setRules(paths, { tcb: custom });
    const cfg = readGlobalConfig(paths);
    expect(cfg.tcb).toEqual(custom);
  });

  it("bumps the version on each set_rules", () => {
    readGlobalConfig(paths);
    const r1 = setRules(paths, { tcb: defaultToolCircuitBreakerConfig() });
    expect(r1.version).toBe(1);
    const r2 = setRules(paths, { tcb: defaultToolCircuitBreakerConfig() });
    expect(r2.version).toBe(2);
    expect(readGlobalConfig(paths).version).toBe(2);
  });

  it("persists the global rule-class layer when provided", () => {
    readGlobalConfig(paths);
    setRules(paths, {
      tcb: defaultToolCircuitBreakerConfig(),
      ruleClasses: BUILTIN_RULE_CLASSES,
    });
    const cfg = readGlobalConfig(paths);
    expect(cfg.ruleClasses).toEqual(BUILTIN_RULE_CLASSES);
  });

  it("throws on an invalid TCB shape in set_rules", () => {
    readGlobalConfig(paths);
    expect(() => setRules(paths, { tcb: { nope: true } as never })).toThrow(
      /invalid TCB config/,
    );
  });

  it("throws on an invalid rule-class registry in set_rules", () => {
    readGlobalConfig(paths);
    expect(() =>
      setRules(paths, {
        tcb: defaultToolCircuitBreakerConfig(),
        ruleClasses: { not: "a registry" } as never,
      }),
    ).toThrow(/invalid rule-class registry/);
  });

  it("writes and reads the service discovery file", () => {
    writeServiceInfo(paths, { port: 4321, pid: 999, startedAt: "2026-08-20T00:00:00Z" });
    const info = readServiceInfoOrNull(paths);
    expect(info).toEqual({ port: 4321, pid: 999, startedAt: "2026-08-20T00:00:00Z" });
  });

  it("returns null for a missing or malformed discovery file", () => {
    expect(readServiceInfoOrNull(paths)).toBeNull();
    mkdirSync(dirname(paths.serviceInfoPath), { recursive: true });
    writeFileSync(paths.serviceInfoPath, "{ not json", "utf8");
    expect(readServiceInfoOrNull(paths)).toBeNull();
  });

  it("never leaves a torn file after a write (atomic rename)", () => {
    readGlobalConfig(paths);
    for (let i = 0; i < 5; i++) {
      setRules(paths, { tcb: defaultToolCircuitBreakerConfig() });
    }
    // The file is always valid JSON.
    JSON.parse(readFileSync(paths.tcbPath, "utf8"));
  });

  it("defaults machineOverlay to enforce", () => {
    const cfg = readGlobalConfig(paths);
    expect(cfg.machineOverlay).toBe("enforce");
  });

  it("reads back a persisted machine-overlay mode", () => {
    readGlobalConfig(paths);
    setMachineOverlay(paths, "warn");
    const cfg = readGlobalConfig(paths);
    expect(cfg.machineOverlay).toBe("warn");
  });

  it("bumps the version on set_machine_overlay", () => {
    readGlobalConfig(paths);
    const r1 = setMachineOverlay(paths, "off");
    expect(r1.version).toBe(1);
    expect(r1.machineOverlay).toBe("off");
    expect(readGlobalConfig(paths).version).toBe(1);
  });

  it("throws on an invalid machine-overlay mode", () => {
    readGlobalConfig(paths);
    expect(() => setMachineOverlay(paths, "nope" as never)).toThrow(/invalid mode/);
  });
});

