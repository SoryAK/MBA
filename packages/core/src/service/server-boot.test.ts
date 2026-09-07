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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { delimiter, join } from "node:path";
import { bootServer, defaultBinaryPath, type BootServerInput } from "./server-boot.js";
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

describe("defaultBinaryPath", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "mba-binary-test-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("prefers MBA_LLAMA_SERVER_BIN over everything else", () => {
    const env = { MBA_LLAMA_SERVER_BIN: "/custom/llama-server" };
    expect(defaultBinaryPath("upstream", env)).toBe("/custom/llama-server");
    expect(defaultBinaryPath("llama.cpp", env)).toBe("/custom/llama-server");
  });

  it("searches PATH before common locations", () => {
    const pathBin = join(tmp, "path-bin");
    mkdirSync(pathBin, { recursive: true });
    writeFileSync(join(pathBin, "llama-server"), "");

    const env = { PATH: `${pathBin}${delimiter}/other` };
    expect(defaultBinaryPath("upstream", env)).toBe(join(pathBin, "llama-server"));
  });

  it("falls back to common locations when PATH has no match", () => {
    const localBin = join(homedir(), ".local", "bin");
    mkdirSync(localBin, { recursive: true });
    const marker = join(localBin, "llama-server");
    writeFileSync(marker, "");

    try {
      const env = { PATH: "/nonexistent" };
      expect(defaultBinaryPath("upstream", env)).toBe(marker);
    } finally {
      // Clean up the marker so it does not leak to other test processes.
      rmSync(marker, { force: true });
    }
  });

});

function writeMinimalAdapter(adapterDir: string, id: string, modelFile: string): void {
  const dir = join(adapterDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${id}.yaml`),
    [
      "apiVersion: mba.ai/v1alpha1",
      "kind: ModelBehavioralAdapter",
      "metadata:",
      `  id: ${id}`,
      "identity:",
      "  model:",
      `    name: ${id}`,
      `    file: "${modelFile}"`,
      "bindings: {}",
    ].join("\n"),
  );
  writeFileSync(
    join(dir, "server_setup.json"),
    JSON.stringify({ "llama.cpp": { ctxSize: 1000 } }),
  );
}

describe("bootServer binary existence", () => {
  let tmp: string;
  let adapterDir: string;
  let registryPath: string;
  let modelFile: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "mba-boot-binary-test-"));
    adapterDir = join(tmp, "adapters");
    registryPath = join(tmp, "upstreams.json");
    modelFile = join(tmp, "test.gguf");
    writeFileSync(modelFile, "");
    writeMinimalAdapter(adapterDir, "test", modelFile);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("fails fast with a helpful message when the llama-server binary is missing", async () => {
    const result = await bootServer({
      serverType: "llama.cpp",
      modelFile,
      port: 8080,
      adapterDir,
      registryPath,
      binaryPath: "/definitely/not/llama-server",
      seams: { portCheckImpl: async () => true },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("boot-failed");
      expect(result.error).toContain("llama-server binary not found");
      expect(result.error).toContain("MBA_LLAMA_SERVER_BIN");
    }
  });

  it("skips the on-disk binary check when spawnImpl is injected", async () => {
    const result = await bootServer({
      serverType: "llama.cpp",
      modelFile,
      port: 8080,
      adapterDir,
      registryPath,
      binaryPath: "/definitely/not/llama-server",
      seams: {
        portCheckImpl: async () => true,
        spawnImpl: () =>
          ({
            pid: 424242,
            kill: () => true,
            on: () => undefined,
            once: () => undefined,
            unref: () => undefined,
            stdout: { on: () => undefined },
            stderr: { on: () => undefined },
          }) as never,
        fetchImpl: (async () =>
          new Response(JSON.stringify({ status: "ok" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })) as unknown as typeof fetch,
        killImpl: () => true,
        now: () => 1_000_000,
        healthDeadlineMs: 1000,
        mkdirImpl: () => undefined,
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entry.pid).toBe(424242);
    }
  });
});
