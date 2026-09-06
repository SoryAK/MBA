import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MbaStorePaths } from "./config-store.js";
import type { MachineInfo } from "./machine-info.js";
import {
  machineInfoPath,
  readMachineInfo,
  refreshMachineInfo,
  writeMachineInfo,
} from "./machine-store.js";

function fakePaths(): MbaStorePaths {
  const baseDir = mkdtempSync(join(tmpdir(), "mba-machine-store-"));
  return {
    baseDir,
    serviceInfoPath: join(baseDir, "mba", "service.json"),
    tcbPath: join(baseDir, "bcb", "tool-circuit-breakers.json"),
    ruleClassesPath: join(baseDir, "mba", "rule-classes.json"),
    versionPath: join(baseDir, "mba", "version.json"),
    machineOverlayPath: join(baseDir, "mba", "machine-overlay.json"),
    upstreamsPath: join(baseDir, "mba", "upstreams.json"),
    udsPath: join(baseDir, "mba", "mba.sock"),
  };
}

const INFO: MachineInfo = {
  os: "linux",
  cpuCores: 8,
  totalRamBytes: 16 * 1024 * 1024 * 1024,
  gpus: [{ name: "Example GPU", vramBytes: 12 * 1024 * 1024 * 1024 }],
};

const INFO2: MachineInfo = {
  os: "linux",
  cpuCores: 16,
  totalRamBytes: 32 * 1024 * 1024 * 1024,
  gpus: [{ name: "RTX 4090", vramBytes: 24 * 1024 * 1024 * 1024 }],
};

describe("machine-store", () => {
  let paths: ReturnType<typeof fakePaths>;

  beforeEach(() => {
    paths = fakePaths();
  });

  afterEach(() => {
    rmSync(paths.baseDir, { recursive: true, force: true });
  });

  it("computes the machine info path inside the mba state dir", () => {
    expect(machineInfoPath(paths)).toBe(join(paths.baseDir, "mba", "machine.json"));
  });

  it("returns undefined when no profile exists", () => {
    expect(readMachineInfo(paths)).toBeUndefined();
  });

  it("writes and reads a valid profile", () => {
    writeMachineInfo(paths, INFO);
    expect(readMachineInfo(paths)).toEqual(INFO);
    expect(existsSync(machineInfoPath(paths))).toBe(true);
  });

  it("creates parent directories when writing", () => {
    writeMachineInfo(paths, INFO);
    expect(existsSync(join(paths.baseDir, "mba"))).toBe(true);
  });

  it("returns undefined for a malformed profile", () => {
    const file = machineInfoPath(paths);
    // Force-create parent dir and write bad JSON.
    writeMachineInfo(paths, INFO);
    // Overwrite with invalid JSON outside the atomic helper to test read resilience.
    const bad = JSON.stringify({ os: "linux" }); // missing cpuCores/totalRamBytes
    // Write directly to file.
    writeFileSync(file, bad, "utf8");
    expect(readMachineInfo(paths)).toBeUndefined();
  });

  it("refresh writes detected info when no profile exists", () => {
    const env = {
      MBA_MACHINE_INFO: JSON.stringify(INFO),
    };
    const result = refreshMachineInfo(paths, env);
    expect(result.info).toEqual(INFO);
    expect(result.changed).toBe(true);
    expect(result.fromEnv).toBe(true);
    expect(readMachineInfo(paths)).toEqual(INFO);
  });

  it("refresh detects a changed profile and returns a diff", () => {
    writeMachineInfo(paths, INFO);
    const env = {
      MBA_MACHINE_INFO: JSON.stringify(INFO2),
    };
    const result = refreshMachineInfo(paths, env);
    expect(result.info).toEqual(INFO2);
    expect(result.changed).toBe(true);
    expect(result.diff.length).toBeGreaterThan(0);
    expect(result.diff.some((line) => line.includes("RTX 4090"))).toBe(true);
  });

  it("refresh is a no-op when the profile is unchanged", () => {
    writeMachineInfo(paths, INFO);
    const env = {
      MBA_MACHINE_INFO: JSON.stringify(INFO),
    };
    const result = refreshMachineInfo(paths, env);
    expect(result.info).toEqual(INFO);
    expect(result.changed).toBe(false);
    expect(result.diff).toEqual([]);
  });

  it("refresh writes detected info when the env override is absent and no profile exists", () => {
    const result = refreshMachineInfo(paths, {});
    expect(result.fromEnv).toBe(false);
    // Detection should succeed in a normal test environment.
    expect(result.info).toBeDefined();
    if (result.info) {
      expect(result.info.cpuCores).toBeGreaterThan(0);
      expect(result.info.totalRamBytes).toBeGreaterThan(0);
      expect(result.info.os).toBe(process.platform);
    }
  });

  it("writes a stable JSON file", () => {
    writeMachineInfo(paths, INFO);
    const text = readFileSync(machineInfoPath(paths), "utf8");
    expect(text).toContain("\"os\": \"linux\"");
    expect(text).toContain("\"cpuCores\": 8");
    expect(JSON.parse(text)).toEqual(INFO);
  });
});
