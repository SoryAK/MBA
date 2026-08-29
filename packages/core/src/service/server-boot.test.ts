/**
 * Server-plane boot (ADR-0097 Phase 2) — self-healing G2 port rule.
 *
 * The G2 port rule now checks the actual OS port first (via the injected
 * `portCheckImpl` seam), not just the registry. This test suite proves:
 *   - a free port boots even when the registry has a stale entry for it
 *     (the stale entry is cleaned up);
 *   - an occupied port is refused with a friendly message that names the
 *     registry entry when one exists, or reports an external process when
 *     it does not;
 *   - the default `portCheckImpl` performs a real TCP bind probe.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootServer, type BootServerInput } from "./server-boot.js";
import { writeRegistry, readRegistry, type UpstreamEntry } from "./upstream-registry.js";
import { resolveSeams } from "../mba/index.js";

let tmp: string;
let registryPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "mba-boot-test-"));
  registryPath = join(tmp, "upstreams.json");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function makeEntry(overrides: Partial<UpstreamEntry> = {}): UpstreamEntry {
  return {
    id: "llama-cpp-8080",
    serverType: "llama.cpp",
    modelFile: "/models/test.gguf",
    port: 8080,
    pid: 12345,
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeInput(overrides: Partial<BootServerInput> = {}): BootServerInput {
  return {
    serverType: "llama.cpp",
    modelFile: "/models/test.gguf",
    port: 8080,
    adapterDir: tmp,
    registryPath,
    ...overrides,
  };
}

describe("G2 self-healing port rule", () => {
  it("boots on a free port even when the registry has a stale entry", async () => {
    // Seed a stale registry entry for port 8080 with a DIFFERENT model file
    // so the Q1 duplicate check does not fire.
    writeRegistry(registryPath, [
      makeEntry({ id: "stale-llama-cpp-8080", modelFile: "/models/other.gguf" }),
    ]);

    // The OS port is actually free.
    const result = await bootServer(
      makeInput({
        seams: { portCheckImpl: async () => true },
      }),
    );

    // The boot should fail at recipe resolution (no adapter tree), but the
    // stale entry must have been cleaned up before that.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("unknown-model");
    }
    const cleaned = readRegistry(registryPath);
    expect(cleaned.find((e) => e.port === 8080)).toBeUndefined();
  });

  it("refuses an occupied port with the registry entry name", async () => {
    writeRegistry(registryPath, [makeEntry({ id: "llama-cpp-8080" })]);

    const result = await bootServer(
      makeInput({
        seams: { portCheckImpl: async () => false },
      }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("port-busy");
      expect(result.error).toContain("llama-cpp-8080");
    }
  });

  it("refuses an occupied port with an external-process message when no registry entry", async () => {
    // Empty registry.
    writeRegistry(registryPath, []);

    const result = await bootServer(
      makeInput({
        seams: { portCheckImpl: async () => false },
      }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("port-busy");
      expect(result.error).toContain("external process");
    }
  });

  it("does not clean up the registry when the port is occupied", async () => {
    writeRegistry(registryPath, [makeEntry()]);

    await bootServer(
      makeInput({
        seams: { portCheckImpl: async () => false },
      }),
    );

    const after = readRegistry(registryPath);
    expect(after.find((e) => e.port === 8080)).toBeDefined();
  });

  it("skips the port check entirely for ollama", async () => {
    // Ollama shares the daemon port — the G2 rule does not apply.
    const result = await bootServer(
      makeInput({
        serverType: "ollama",
        modelRef: "qwen3.8:27b",
        modelFile: undefined,
        seams: {
          portCheckImpl: async () => {
            throw new Error("portCheckImpl should not be called for ollama");
          },
          // Fail fast so the test does not hang on a real network call.
          fetchImpl: (async () => {
            throw new Error("ECONNREFUSED");
          }) as unknown as typeof fetch,
        },
      }),
    );

    // Should fail at boot (no Ollama daemon), not at the port check.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("boot-failed");
    }
  });
});

describe("default portCheckImpl", () => {
  it("returns true for a free port", async () => {
    const { portCheckImpl } = resolveSeams();
    // Pick a high port unlikely to be in use.
    const free = await portCheckImpl(49999);
    expect(free).toBe(true);
  });

  it("returns false for an occupied port", async () => {
    const net = await import("node:net");
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(49998, "127.0.0.1", resolve));

    const { portCheckImpl } = resolveSeams();
    const occupied = await portCheckImpl(49998);
    expect(occupied).toBe(false);

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
