/**
 * Lineage-tree resolution tests (ADR-0090).
 *
 * The adapter tree is a folder hierarchy: `adapters/<trunk>/<branch>/...`.
 * Family adapters (`identity.model.family`, no `name`) mark lineage rungs;
 * leaf adapters (`identity.model.name`) are the specific model. The resolver
 * walks the tree root→leaf and deep-merges least-specific-first. A leaf's
 * declared `identity.model.lineage` is cross-checked against its folder path.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveMbaConfig } from "./index.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cyard-mba-lineage-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeYaml(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

function familyAdapter(id: string, family: string, extra = ""): string {
  return `apiVersion: mba.c-yard.dev/v1alpha1
kind: ModelBehavioralAdapter
metadata:
  id: ${id}
  family: ${family}
identity:
  model:
    family: ${family}
${extra}bindings:
  server_setup: "./server_setup.json"
`;
}

function leafAdapter(id: string, name: string, family: string, lineage: string): string {
  return `apiVersion: mba.c-yard.dev/v1alpha1
kind: ModelBehavioralAdapter
metadata:
  id: ${id}
  family: ${family}
identity:
  model:
    name: ${name}
    family: ${family}
    lineage: [${lineage}]
  environment:
    harness: copilot
    ide: vscode
  server:
    runtime: llama.cpp
bindings:
  server_setup: "./server_setup.json"
`;
}

const CTX = {
  modelName: "qwen3-coder-30b",
  modelFamily: "qwen3-coder",
  harness: "copilot",
  ide: "vscode",
  serverRuntime: "llama.cpp",
};

describe("lineage-tree resolution", () => {
  it("merges trunk ← branch ← leaf, least-specific first", () => {
    const adapters = join(dir, "mba", "adapters");

    // Trunk: applies to ALL Qwen models.
    writeYaml(join(adapters, "qwen", "family.yaml"), familyAdapter("qwen-trunk", "qwen"));
    writeFileSync(
      join(adapters, "qwen", "server_setup.json"),
      JSON.stringify({ "llama.cpp": { ctxSize: 32000, reasoningBudget: 128 } }),
    );

    // Branch: applies to all qwen3-coder variants.
    writeYaml(
      join(adapters, "qwen", "qwen3-coder", "family.yaml"),
      familyAdapter("qwen3-coder-branch", "qwen3-coder"),
    );
    writeFileSync(
      join(adapters, "qwen", "qwen3-coder", "server_setup.json"),
      JSON.stringify({ "llama.cpp": { ctxSize: 100000, gpuLayers: 100 } }),
    );

    // Leaf: this specific model.
    const leafDir = join(adapters, "qwen", "qwen3-coder", "copilot-vscode", "llamacpp");
    writeYaml(
      join(leafDir, "qwen3-coder-30b.yaml"),
      leafAdapter("qwen3-coder-30b-leaf", "qwen3-coder-30b", "qwen3-coder", "qwen, qwen3-coder"),
    );
    writeFileSync(
      join(leafDir, "server_setup.json"),
      JSON.stringify({ "llama.cpp": { ctxSize: 64000 } }),
    );

    const resolved = resolveMbaConfig(join(dir, "mba"), CTX);

    // All three layers selected, least-specific first.
    expect(resolved.selectedIds).toEqual([
      "qwen-trunk",
      "qwen3-coder-branch",
      "qwen3-coder-30b-leaf",
    ]);
    // ctxSize: leaf wins (64000).
    expect(resolved.server["llama.cpp"]?.ctxSize).toBe(64000);
    // gpuLayers: inherited from branch (leaf doesn't set it).
    expect(resolved.server["llama.cpp"]?.gpuLayers).toBe(100);
    // reasoningBudget: inherited from trunk (branch + leaf don't set it).
    expect(resolved.server["llama.cpp"]?.reasoningBudget).toBe(128);
  });

  it("trunk matches any model in the trunk's lineage (prefix match)", () => {
    const adapters = join(dir, "mba", "adapters");

    // Trunk only — no branch, no leaf. A different Qwen model (qwen3-32b)
    // should still pick up the trunk because [qwen] is a prefix of its lineage.
    writeYaml(join(adapters, "qwen", "family.yaml"), familyAdapter("qwen-trunk", "qwen"));
    writeFileSync(
      join(adapters, "qwen", "server_setup.json"),
      JSON.stringify({ "llama.cpp": { ctxSize: 32000 } }),
    );

    // The caller supplies the full lineage; the resolver derives it from the
    // family hint only when no lineage is given.
    const resolved = resolveMbaConfig(join(dir, "mba"), {
      modelName: "qwen3-32b",
      modelFamily: "qwen3",
      modelLineage: ["qwen", "qwen3"],
      harness: "copilot",
    });

    expect(resolved.selectedIds).toContain("qwen-trunk");
    expect(resolved.server["llama.cpp"]?.ctxSize).toBe(32000);
  });

  it("emits a lineage-mismatch diagnostic when declared lineage disagrees with the folder path", () => {
    const adapters = join(dir, "mba", "adapters");

    // Leaf lives under qwen/qwen3-coder/ but declares lineage [deepseek].
    const leafDir = join(adapters, "qwen", "qwen3-coder", "copilot-vscode", "llamacpp");
    writeYaml(
      join(leafDir, "qwen3-coder-30b.yaml"),
      leafAdapter("qwen3-coder-30b-leaf", "qwen3-coder-30b", "qwen3-coder", "deepseek"),
    );
    writeFileSync(
      join(leafDir, "server_setup.json"),
      JSON.stringify({ "llama.cpp": { ctxSize: 64000 } }),
    );

    const resolved = resolveMbaConfig(join(dir, "mba"), CTX);

    // Still resolves (diagnostic is non-fatal)...
    expect(resolved.selectedIds).toContain("qwen3-coder-30b-leaf");
    // ...but flags the mismatch.
    expect(resolved.diagnostics.some((d) => d.kind === "lineage-mismatch")).toBe(true);
  });

  it("keeps flat (non-tree) adapters working — backward compat", () => {
    const adapters = join(dir, "mba", "adapters");

    // A flat adapter at adapters/m1/ with no lineage context.
    const m1Dir = join(adapters, "m1");
    writeYaml(
      join(m1Dir, "m1.yaml"),
      `apiVersion: mba.c-yard.dev/v1alpha1
kind: ModelBehavioralAdapter
metadata:
  id: model-1
identity:
  model:
    name: m1
bindings:
  server_setup: "./server_setup.json"
`,
    );
    writeFileSync(
      join(m1Dir, "server_setup.json"),
      JSON.stringify({ "llama.cpp": { ctxSize: 64000 } }),
    );

    const resolved = resolveMbaConfig(join(dir, "mba"), {
      modelName: "m1",
      harness: "copilot",
    });

    expect(resolved.selectedIds).toEqual(["model-1"]);
    expect(resolved.server["llama.cpp"]?.ctxSize).toBe(64000);
  });
});
