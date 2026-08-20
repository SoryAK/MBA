/**
 * Contract tests for server-state persistence (Step 5).
 *
 * Tests the read/write logic for .cyard-store/server-state.json
 */

import { describe, expect, it, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadServerState,
  saveServerState,
  isFlagsMismatch,
  isRebootNeeded,
  type PersistedServerState,
} from "./server-state.js";

const testStoreDir = join(tmpdir(), `c-yard-test-${Date.now()}`);

describe("loadServerState", () => {
  afterEach(() => {
    try {
      // Clean up test directory
      import("node:fs").then(({ rmSync }) => {
        rmSync(testStoreDir, { recursive: true, force: true });
      });
    } catch {
      // ignore cleanup errors
    }
  });

  it("returns null when file doesn't exist", () => {
    const result = loadServerState(testStoreDir);
    expect(result).toBeNull();
  });

  it("returns null when file contains invalid JSON", () => {
    const { writeFileSync, mkdirSync } = require("node:fs");
    mkdirSync(testStoreDir, { recursive: true });
    writeFileSync(`${testStoreDir}/server-state.json`, "{ invalid json");

    const result = loadServerState(testStoreDir);
    expect(result).toBeNull();
  });

  it("returns null when required fields are missing", () => {
    const { writeFileSync, mkdirSync } = require("node:fs");
    mkdirSync(testStoreDir, { recursive: true });
    writeFileSync(
      `${testStoreDir}/server-state.json`,
      JSON.stringify({ modelPath: "/model.gguf" }), // missing other fields
    );

    const result = loadServerState(testStoreDir);
    expect(result).toBeNull();
  });

  it("loads valid server state", () => {
    const { writeFileSync, mkdirSync } = require("node:fs");
    mkdirSync(testStoreDir, { recursive: true });

    const state: PersistedServerState = {
      modelPath: "/models/test.gguf",
      flags: ["--ctx-size", "100000", "-ngl", "100"],
      pid: 12345,
      port: 8080,
      bootedAt: 1000,
    };

    writeFileSync(`${testStoreDir}/server-state.json`, JSON.stringify(state));

    const result = loadServerState(testStoreDir);
    expect(result).toEqual(state);
  });
});

describe("saveServerState", () => {
  afterEach(() => {
    try {
      import("node:fs").then(({ rmSync }) => {
        rmSync(testStoreDir, { recursive: true, force: true });
      });
    } catch {
      // ignore
    }
  });

  it("creates directory if it doesn't exist", () => {
    const { existsSync } = require("node:fs");
    expect(existsSync(testStoreDir)).toBe(false);

    const state: PersistedServerState = {
      modelPath: "/models/test.gguf",
      flags: [],
      pid: 100,
      port: 8080,
      bootedAt: 1000,
    };

    saveServerState(testStoreDir, state);
    expect(existsSync(testStoreDir)).toBe(true);
  });

  it("writes valid JSON that can be read back", () => {
    const state: PersistedServerState = {
      modelPath: "/models/qwen.gguf",
      flags: ["--ctx-size", "100000", "-ngl", "100", "--flash-attn", "on"],
      pid: 54321,
      port: 8080,
      bootedAt: 1626048000000,
    };

    saveServerState(testStoreDir, state);

    const loaded = loadServerState(testStoreDir);
    expect(loaded).toEqual(state);
  });

  it("overwrites previous state", () => {
    const state1: PersistedServerState = {
      modelPath: "/models/old.gguf",
      flags: ["--ctx-size", "50000"],
      pid: 100,
      port: 8080,
      bootedAt: 1000,
    };

    const state2: PersistedServerState = {
      modelPath: "/models/new.gguf",
      flags: ["--ctx-size", "100000"],
      pid: 200,
      port: 8080,
      bootedAt: 2000,
    };

    saveServerState(testStoreDir, state1);
    let loaded = loadServerState(testStoreDir);
    expect(loaded?.pid).toBe(100);

    saveServerState(testStoreDir, state2);
    loaded = loadServerState(testStoreDir);
    expect(loaded?.pid).toBe(200);
  });
});

describe("isFlagsMismatch", () => {
  it("returns true when prior state is null", () => {
    const mismatch = isFlagsMismatch(["--ctx-size", "100000"], null);
    expect(mismatch).toBe(true);
  });

  it("returns false when flags exactly match", () => {
    const flags = ["--ctx-size", "100000", "-ngl", "100"];
    const state: PersistedServerState = {
      modelPath: "/models/test.gguf",
      flags,
      pid: 100,
      port: 8080,
      bootedAt: 1000,
    };

    const mismatch = isFlagsMismatch(flags, state);
    expect(mismatch).toBe(false);
  });

  it("returns true when flag count differs", () => {
    const state: PersistedServerState = {
      modelPath: "/models/test.gguf",
      flags: ["--ctx-size", "100000", "-ngl", "100"],
      pid: 100,
      port: 8080,
      bootedAt: 1000,
    };

    const mismatch = isFlagsMismatch(["--ctx-size", "100000"], state);
    expect(mismatch).toBe(true);
  });

  it("returns true when any flag value differs", () => {
    const state: PersistedServerState = {
      modelPath: "/models/test.gguf",
      flags: ["--ctx-size", "100000", "-ngl", "100"],
      pid: 100,
      port: 8080,
      bootedAt: 1000,
    };

    const mismatch = isFlagsMismatch(["--ctx-size", "50000", "-ngl", "100"], state);
    expect(mismatch).toBe(true);
  });
});

describe("isRebootNeeded", () => {
  afterEach(() => {
    try {
      import("node:fs").then(({ rmSync }) => {
        rmSync(testStoreDir, { recursive: true, force: true });
      });
    } catch {
      // ignore
    }
  });

  it("returns true when no prior state exists", () => {
    const needed = isRebootNeeded(testStoreDir, "/models/test.gguf", ["--ctx-size", "100000"]);
    expect(needed).toBe(true);
  });

  it("returns true when model path differs", () => {
    const { writeFileSync, mkdirSync } = require("node:fs");
    mkdirSync(testStoreDir, { recursive: true });

    const prior: PersistedServerState = {
      modelPath: "/models/old.gguf",
      flags: ["--ctx-size", "100000"],
      pid: 100,
      port: 8080,
      bootedAt: 1000,
    };

    writeFileSync(`${testStoreDir}/server-state.json`, JSON.stringify(prior));

    const needed = isRebootNeeded(testStoreDir, "/models/new.gguf", ["--ctx-size", "100000"]);
    expect(needed).toBe(true);
  });

  it("returns true when flags differ", () => {
    const { writeFileSync, mkdirSync } = require("node:fs");
    mkdirSync(testStoreDir, { recursive: true });

    const prior: PersistedServerState = {
      modelPath: "/models/test.gguf",
      flags: ["--ctx-size", "100000"],
      pid: 100,
      port: 8080,
      bootedAt: 1000,
    };

    writeFileSync(`${testStoreDir}/server-state.json`, JSON.stringify(prior));

    const needed = isRebootNeeded(testStoreDir, "/models/test.gguf", ["--ctx-size", "50000"]);
    expect(needed).toBe(true);
  });

  it("returns false when model and flags match", () => {
    const { writeFileSync, mkdirSync } = require("node:fs");
    mkdirSync(testStoreDir, { recursive: true });

    const flags = ["--ctx-size", "100000", "-ngl", "100"];
    const prior: PersistedServerState = {
      modelPath: "/models/test.gguf",
      flags,
      pid: 100,
      port: 8080,
      bootedAt: 1000,
    };

    writeFileSync(`${testStoreDir}/server-state.json`, JSON.stringify(prior));

    const needed = isRebootNeeded(testStoreDir, "/models/test.gguf", flags);
    expect(needed).toBe(false);
  });
});
