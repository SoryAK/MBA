import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import {
  defaultStorePaths,
  migrateLegacyBaseDir,
  readGlobalConfig,
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
});

describe("migrateLegacyBaseDir", () => {
  let legacyDir: string;
  let newDir: string;

  beforeEach(() => {
    legacyDir = mkdtempSync(join(tmpdir(), "mba-legacy-"));
    newDir = mkdtempSync(join(tmpdir(), "mba-new-"));
  });

  it("copies legacy files preserving layout, without overwriting new files", () => {
    // Legacy state: TCB config + a version file.
    mkdirSync(join(legacyDir, "bcb"), { recursive: true });
    writeFileSync(join(legacyDir, "bcb", "tool-circuit-breakers.json"), "{}\n", "utf8");
    mkdirSync(join(legacyDir, "mba"), { recursive: true });
    writeFileSync(join(legacyDir, "mba", "version.json"), "{\n  \"version\": 7\n}\n", "utf8");
    // New dir already has a TCB file — it must win.
    mkdirSync(join(newDir, "bcb"), { recursive: true });
    writeFileSync(join(newDir, "bcb", "tool-circuit-breakers.json"), "EXISTING\n", "utf8");

    const copied = migrateLegacyBaseDir(legacyDir, newDir);

    expect(copied).toEqual(["mba/version.json"]);
    // Existing file untouched.
    expect(readFileSync(join(newDir, "bcb", "tool-circuit-breakers.json"), "utf8")).toBe(
      "EXISTING\n",
    );
    // Missing file copied.
    expect(readFileSync(join(newDir, "mba", "version.json"), "utf8")).toBe(
      "{\n  \"version\": 7\n}\n",
    );
    // Legacy files left in place.
    expect(existsSync(join(legacyDir, "bcb", "tool-circuit-breakers.json"))).toBe(true);
  });

  it("is a no-op when the legacy dir does not exist", () => {
    const missing = join(tmpdir(), "mba-does-not-exist-");
    expect(migrateLegacyBaseDir(missing, newDir)).toEqual([]);
  });
});
