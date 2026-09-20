import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { reasoningGateForModel } from "./reasoning-gate.js";

function writeRecipeTree(): { adapterDir: string; modelFile: string } {
  const root = mkdtempSync(join(tmpdir(), "mba-reason-"));
  const adapterDir = join(root, "adapters");
  const modelDir = join(adapterDir, "qwen");
  mkdirSync(join(modelDir, "environments", "cursor"), { recursive: true });
  const modelFile = join(root, "qwen.gguf");
  writeFileSync(modelFile, "GGUF");
  writeFileSync(
    join(modelDir, "qwen.yaml"),
    [
      "apiVersion: mba.ai/v1alpha1",
      "kind: ModelBehavioralAdapter",
      "metadata:",
      "  id: qwen",
      "  name: qwen",
      "identity:",
      "  model:",
      "    name: qwen",
      `    file: "${modelFile}"`,
      "bindings:",
      '  server_setup: "./server_setup.json"',
    ].join("\n"),
  );
  writeFileSync(
    join(modelDir, "server_setup.json"),
    JSON.stringify({ "llama.cpp": { reasoningBudget: 512, reasoningPreserve: true } }),
  );
  writeFileSync(
    join(modelDir, "environments", "cursor", "server_setup.json"),
    JSON.stringify({ "llama.cpp": { reasoningBudget: 0, reasoningPreserve: false } }),
  );
  return { adapterDir, modelFile };
}

describe("reasoningGateForModel", () => {
  it("resolves the paired harness env, not a hardcoded Copilot context", () => {
    const { adapterDir } = writeRecipeTree();
    const cursor = reasoningGateForModel("qwen", adapterDir, {
      harness: "cursor",
      ide: "cursor",
      serverRuntime: "llamacpp",
    });
    const copilot = reasoningGateForModel("qwen", adapterDir, {
      harness: "copilot",
      ide: "vscode",
      serverRuntime: "llamacpp",
    });
    expect(cursor).toMatchObject({ reasoningBudget: 0, reasoningPreserve: false });
    expect(copilot).toMatchObject({ reasoningBudget: 512, reasoningPreserve: true });
  });
});
