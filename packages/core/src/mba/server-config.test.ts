/**
 * Step 2 tests: the MBA resolver loads and merges the per-adapter
 * `bindings.server` recipe (server.json) the same way it merges structural.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadServerConfig, resolveMbaConfig } from "./index.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cyard-mba-server-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Write an adapter YAML into `adapterDir`. The resolver scans for any
 * `.yaml`/`.yml` file and scores by identity, so the filename is purely a
 * discoverability concern — but we follow the convention: `family.yaml` at the
 * family level, `{model-name}.yaml` at the environment level.
 */
function writeAdapter(
  adapterDir: string,
  id: string,
  identityYaml: string,
  bindingsYaml: string,
  filename = "adapter.yaml",
): void {
  mkdirSync(adapterDir, { recursive: true });
  writeFileSync(
    join(adapterDir, filename),
    `apiVersion: mba.c-yard.dev/v1alpha1
kind: ModelBehavioralAdapter
metadata:
  id: ${id}
identity:
${identityYaml}
bindings:
${bindingsYaml}
`,
  );
}

describe("loadServerConfig", () => {
  it("parses a runtime-keyed server.json", () => {
    const path = join(dir, "server.json");
    writeFileSync(path, JSON.stringify({ "llama.cpp": { ctxSize: 64000 } }));
    expect(loadServerConfig(path)).toEqual({ "llama.cpp": { ctxSize: 64000 } });
  });

  it("throws on non-object JSON", () => {
    const path = join(dir, "server.json");
    writeFileSync(path, JSON.stringify([1, 2, 3]));
    expect(() => loadServerConfig(path)).toThrow();
  });
});

describe("resolveMbaConfig — server recipe", () => {
  it("returns an empty server config when no adapter binds one", () => {
    const mbaDir = join(dir, "mba");
    mkdirSync(join(mbaDir, "adapters"), { recursive: true });
    const resolved = resolveMbaConfig(mbaDir, { modelName: "unknown", harness: "copilot" });
    expect(resolved.server).toEqual({});
  });

  it("loads a single-adapter server recipe", () => {
    const mbaDir = join(dir, "mba");
    const adaptersDir = join(mbaDir, "adapters");
    writeAdapter(
      join(adaptersDir, "m1"),
      "model-1",
      `  model:
    name: m1`,
      `  server_setup: "./server_setup.json"`,
      "m1.yaml",
    );
    writeFileSync(
      join(adaptersDir, "m1", "server_setup.json"),
      JSON.stringify({ "llama.cpp": { ctxSize: 64000, reasoningBudget: 256 } }),
    );

    const resolved = resolveMbaConfig(mbaDir, { modelName: "m1", harness: "copilot" });
    expect(resolved.server["llama.cpp"]?.ctxSize).toBe(64000);
    expect(resolved.server["llama.cpp"]?.reasoningBudget).toBe(256);
  });

  it("deep-merges family ← environment server recipes (last-wins per key)", () => {
    const mbaDir = join(dir, "mba");
    const adaptersDir = join(mbaDir, "adapters");

    // Family layer: two knobs.
    writeAdapter(
      join(adaptersDir, "qwen3-coder"),
      "qwen3-coder-family",
      `  model:
    family: qwen3-coder`,
      `  server_setup: "./server_setup.json"`,
      "family.yaml",
    );
    writeFileSync(
      join(adaptersDir, "qwen3-coder", "server_setup.json"),
      JSON.stringify({ "llama.cpp": { ctxSize: 100000, reasoningBudget: 512 } }),
    );

    // Environment layer: overrides ctxSize only.
    writeAdapter(
      join(adaptersDir, "qwen3-coder", "copilot-vscode", "llamacpp"),
      "qwen3-coder-30b-copilot-vscode-llamacpp",
      `  model:
    name: qwen3-coder-30b
    family: qwen3-coder
  environment:
    harness: copilot
    ide: vscode
  server:
    runtime: llama.cpp`,
      `  server_setup: "./server_setup.json"`,
      "qwen3-coder-30b.yaml",
    );
    writeFileSync(
      join(adaptersDir, "qwen3-coder", "copilot-vscode", "llamacpp", "server_setup.json"),
      JSON.stringify({ "llama.cpp": { ctxSize: 64000 } }),
    );

    const resolved = resolveMbaConfig(mbaDir, {
      modelName: "qwen3-coder-30b",
      modelFamily: "qwen3-coder",
      harness: "copilot",
      ide: "vscode",
      serverRuntime: "llama.cpp",
    });
    expect(resolved.selectedIds).toEqual([
      "qwen3-coder-family",
      "qwen3-coder-30b-copilot-vscode-llamacpp",
    ]);
    // Overridden by the more-specific layer...
    expect(resolved.server["llama.cpp"]?.ctxSize).toBe(64000);
    // ...inherited from the family layer.
    expect(resolved.server["llama.cpp"]?.reasoningBudget).toBe(512);
  });

  it("reports a load-error diagnostic and keeps the previous layer on bad JSON", () => {
    const mbaDir = join(dir, "mba");
    const adaptersDir = join(mbaDir, "adapters");
    writeAdapter(
      join(adaptersDir, "m1"),
      "model-1",
      `  model:
    name: m1`,
      `  server_setup: "./server_setup.json"`,
      "m1.yaml",
    );
    writeFileSync(join(adaptersDir, "m1", "server_setup.json"), "{ not valid json");

    const resolved = resolveMbaConfig(mbaDir, { modelName: "m1", harness: "copilot" });
    expect(resolved.server).toEqual({});
    expect(resolved.diagnostics.some((d) => d.kind === "load-error")).toBe(true);
  });
});
