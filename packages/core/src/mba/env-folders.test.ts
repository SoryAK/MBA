/**
 * Environment-folder resolution tests (ADR-0091).
 *
 * The model is a FOLDER (YAML + binding files), mirroring the family shape.
 * `environments/` subfolders — at both family and model level — contain only
 * the binding files they override. The folder name is the match key:
 * `harness[-ide[-runtime]]`; partial names are wildcards; the most-specific
 * match wins. Dials merge across four rungs, least → most specific:
 *
 *   1. family bindings
 *   2. family environment
 *   3. model bindings
 *   4. model environment
 *
 * Environment folder names are `+`-separated (`copilot+vscode+llamacpp`),
 * never `-`: model folders are hyphenated (`qwen3-coder-30b`) and a hyphen
 * split would misparse them.
 *
 * The model's `profile` (immutable GGUF facts) is never merged — it is read
 * straight off the matched model and exposed on the resolved config. Dials
 * that exceed a profile ceiling emit a `ceiling-violation` diagnostic.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveMbaConfig } from "./index.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cyard-mba-envfolders-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

function familyYaml(id: string, family: string): string {
  return `apiVersion: mba.c-yard.dev/v1alpha1
kind: ModelBehavioralAdapter
metadata:
  id: ${id}
  family: ${family}
identity:
  model:
    family: ${family}
    lineage: [qwen, ${family}]
bindings:
  server_setup: "./server_setup.json"
`;
}

function modelYaml(
  id: string,
  name: string,
  family: string,
  extra = "",
): string {
  return `apiVersion: mba.c-yard.dev/v1alpha1
kind: ModelBehavioralAdapter
metadata:
  id: ${id}
  family: ${family}
identity:
  model:
    name: ${name}
    lineage: [qwen, ${family}]
${extra}bindings:
  server_setup: "./server_setup.json"
`;
}

const PROFILE_YAML = `    file: "/mnt/nas/AI_Models/qwen3/Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf"
    profile:
      architecture: qwen3moe
      quant: "Q4_K_M"
      params:
        maxContextLength: 262144
        expertCount: 128
        expertUsedCount: 8
`;

const CTX = {
  modelName: "Qwen3-Coder-30B-A3B-Instruct",
  modelFamily: "qwen3-coder",
  harness: "copilot",
  ide: "vscode",
  serverRuntime: "llama.cpp",
};

/**
 * Build the canonical 4-rung tree:
 *
 *   adapters/qwen/qwen3-coder/
 *   ├── family.yaml + server_setup.json            (rung 1)
 *   ├── environments/copilot/server_setup.json     (rung 2)
 *   └── qwen3-coder-30b/
 *       ├── qwen3-coder-30b.yaml + server_setup.json (rung 3)
 *       └── environments/copilot+vscode+llamacpp/
 *           └── server_setup.json                  (rung 4)
 */
function buildTree(adapters: string, modelExtra = ""): void {
  const branch = join(adapters, "qwen", "qwen3-coder");
  write(join(branch, "family.yaml"), familyYaml("qwen3-coder-family", "qwen3-coder"));
  write(
    join(branch, "server_setup.json"),
    JSON.stringify({ "llama.cpp": { ctxSize: 32000, gpuLayers: 99 } }),
  );
  write(
    join(branch, "environments", "copilot", "server_setup.json"),
    JSON.stringify({ "llama.cpp": { threads: 4 } }),
  );

  const model = join(branch, "qwen3-coder-30b");
  write(
    join(model, "qwen3-coder-30b.yaml"),
    modelYaml("qwen3-coder-30b", "Qwen3-Coder-30B-A3B-Instruct", "qwen3-coder", modelExtra),
  );
  write(
    join(model, "server_setup.json"),
    JSON.stringify({ "llama.cpp": { ctxSize: 100000 } }),
  );
  write(
    join(model, "environments", "copilot+vscode+llamacpp", "server_setup.json"),
    JSON.stringify({ "llama.cpp": { warmupTokens: 777 } }),
  );
}

describe("environment-folder resolution (ADR-0091)", () => {
  it("merges the 4 rungs least-specific-first: family ← family-env ← model ← model-env", () => {
    const adapters = join(dir, "mba", "adapters");
    buildTree(adapters);

    const resolved = resolveMbaConfig(join(dir, "mba"), CTX);
    const flags = resolved.server["llama.cpp"];

    expect(resolved.selectedIds).toEqual(["qwen3-coder-family", "qwen3-coder-30b"]);
    // Rung 3 (model) overrides rung 1 (family) for ctxSize.
    expect(flags?.ctxSize).toBe(100000);
    // Rung 1 (family) inherited where no other rung sets it.
    expect(flags?.gpuLayers).toBe(99);
    // Rung 2 (family environment `copilot`) applies.
    expect(flags?.threads).toBe(4);
    // Rung 4 (model environment `copilot-vscode-llamacpp`) applies.
    expect(flags?.warmupTokens).toBe(777);
  });

  it("selects the exact environment folder by harness-ide-runtime segments", () => {
    const adapters = join(dir, "mba", "adapters");
    buildTree(adapters);

    // A different runtime must NOT pick up the llamacpp environment folder.
    const resolved = resolveMbaConfig(join(dir, "mba"), {
      ...CTX,
      serverRuntime: "vllm",
    });
    const flags = resolved.server["llama.cpp"];

    // Family-env `copilot` still matches (harness-only wildcard)...
    expect(flags?.threads).toBe(4);
    // ...but the model's llamacpp-specific folder does not.
    expect(flags?.warmupTokens).toBeUndefined();
  });

  it("treats partial environment folder names as wildcards (harness-only)", () => {
    const adapters = join(dir, "mba", "adapters");
    const branch = join(adapters, "qwen", "qwen3-coder");
    write(join(branch, "family.yaml"), familyYaml("qwen3-coder-family", "qwen3-coder"));
    write(
      join(branch, "server_setup.json"),
      JSON.stringify({ "llama.cpp": { ctxSize: 32000 } }),
    );
    // Harness-only environment folder: matches any IDE and runtime.
    write(
      join(branch, "environments", "copilot", "server_setup.json"),
      JSON.stringify({ "llama.cpp": { threads: 4 } }),
    );
    const model = join(branch, "qwen3-coder-30b");
    write(
      join(model, "qwen3-coder-30b.yaml"),
      modelYaml("qwen3-coder-30b", "Qwen3-Coder-30B-A3B-Instruct", "qwen3-coder"),
    );
    write(join(model, "server_setup.json"), JSON.stringify({ "llama.cpp": { ctxSize: 100000 } }));

    const resolved = resolveMbaConfig(join(dir, "mba"), {
      modelName: "Qwen3-Coder-30B-A3B-Instruct",
      modelFamily: "qwen3-coder",
      harness: "copilot",
      // No ide, no runtime — the harness-only folder must still match.
    });

    expect(resolved.server["llama.cpp"]?.threads).toBe(4);
    expect(resolved.server["llama.cpp"]?.ctxSize).toBe(100000);
  });

  it("prefers the most-specific environment folder when several match", () => {
    const adapters = join(dir, "mba", "adapters");
    const branch = join(adapters, "qwen", "qwen3-coder");
    write(join(branch, "family.yaml"), familyYaml("qwen3-coder-family", "qwen3-coder"));
    write(
      join(branch, "server_setup.json"),
      JSON.stringify({ "llama.cpp": { ctxSize: 32000 } }),
    );
    const model = join(branch, "qwen3-coder-30b");
    write(
      join(model, "qwen3-coder-30b.yaml"),
      modelYaml("qwen3-coder-30b", "Qwen3-Coder-30B-A3B-Instruct", "qwen3-coder"),
    );
    write(join(model, "server_setup.json"), JSON.stringify({ "llama.cpp": { ctxSize: 100000 } }));
    // Two matching environment folders: harness-only and full 3-segment.
    write(
      join(model, "environments", "copilot", "server_setup.json"),
      JSON.stringify({ "llama.cpp": { warmupTokens: 111 } }),
    );
    write(
      join(model, "environments", "copilot+vscode+llamacpp", "server_setup.json"),
      JSON.stringify({ "llama.cpp": { warmupTokens: 777 } }),
    );

    const resolved = resolveMbaConfig(join(dir, "mba"), CTX);

    // The 3-segment folder wins over the 1-segment one.
    expect(resolved.server["llama.cpp"]?.warmupTokens).toBe(777);
  });

  it("exposes the model profile on the resolved config (never merged)", () => {
    const adapters = join(dir, "mba", "adapters");
    buildTree(adapters, PROFILE_YAML);

    const resolved = resolveMbaConfig(join(dir, "mba"), CTX);

    expect(resolved.profile?.architecture).toBe("qwen3moe");
    expect(resolved.profile?.quant).toBe("Q4_K_M");
    expect(resolved.profile?.params?.maxContextLength).toBe(262144);
    expect(resolved.profile?.params?.expertCount).toBe(128);
  });

  it("emits a ceiling-violation diagnostic when ctxSize exceeds maxContextLength", () => {
    const adapters = join(dir, "mba", "adapters");
    buildTree(adapters, PROFILE_YAML);

    // Override the model's server_setup with a ctxSize above the 262144 ceiling.
    const model = join(adapters, "qwen", "qwen3-coder", "qwen3-coder-30b");
    write(
      join(model, "server_setup.json"),
      JSON.stringify({ "llama.cpp": { ctxSize: 300000 } }),
    );

    const resolved = resolveMbaConfig(join(dir, "mba"), CTX);

    expect(resolved.server["llama.cpp"]?.ctxSize).toBe(300000);
    const violation = resolved.diagnostics.find((d) => d.kind === "ceiling-violation");
    expect(violation).toBeDefined();
    expect(violation?.message).toContain("ctxSize");
  });

  it("does NOT emit a ceiling violation when ctxSize is within the ceiling", () => {
    const adapters = join(dir, "mba", "adapters");
    buildTree(adapters, PROFILE_YAML);

    const resolved = resolveMbaConfig(join(dir, "mba"), CTX);

    // 100000 ≤ 262144 — clean.
    expect(resolved.diagnostics.some((d) => d.kind === "ceiling-violation")).toBe(false);
  });

  it("emits env-adapter-deprecated for old-style environment adapter YAMLs", () => {
    const adapters = join(dir, "mba", "adapters");
    const branch = join(adapters, "qwen", "qwen3-coder");
    write(join(branch, "family.yaml"), familyYaml("qwen3-coder-family", "qwen3-coder"));
    write(
      join(branch, "server_setup.json"),
      JSON.stringify({ "llama.cpp": { ctxSize: 32000 } }),
    );

    // Old style: a separate adapter YAML per (model × environment).
    const oldLeaf = join(branch, "copilot-vscode", "llamacpp");
    write(
      join(oldLeaf, "qwen3-coder-30b.yaml"),
      `apiVersion: mba.c-yard.dev/v1alpha1
kind: ModelBehavioralAdapter
metadata:
  id: qwen3-coder-30b-copilot-vscode-llamacpp
  family: qwen3-coder
identity:
  model:
    name: Qwen3-Coder-30B-A3B-Instruct
    lineage: [qwen, qwen3-coder]
  environment:
    harness: copilot
    ide: vscode
  server:
    runtime: llama.cpp
bindings:
  server_setup: "./server_setup.json"
`,
    );
    write(
      join(oldLeaf, "server_setup.json"),
      JSON.stringify({ "llama.cpp": { ctxSize: 100000 } }),
    );

    const resolved = resolveMbaConfig(join(dir, "mba"), CTX);

    // Still resolves (backward compat)...
    expect(resolved.selectedIds).toContain("qwen3-coder-30b-copilot-vscode-llamacpp");
    expect(resolved.server["llama.cpp"]?.ctxSize).toBe(100000);
    // ...but flags the deprecated shape.
    expect(resolved.diagnostics.some((d) => d.kind === "env-adapter-deprecated")).toBe(true);
  });
});
