import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MBA_STAGE_MARKER } from "../mba/envelope.js";
import { stageModelCard } from "./stage-model-card.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mba-stage-card-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeTree(opts: {
  modelInstructions?: string;
  familyInstructions?: string;
  omitModelInstructionsBinding?: boolean;
}): { adapterDir: string; project: string } {
  const mbaDir = join(dir, "mba");
  const adapterDir = join(mbaDir, "adapters");
  const familyDir = join(adapterDir, "qwen3-coder");
  const modelDir = join(familyDir, "qwen3-coder-30b");
  mkdirSync(modelDir, { recursive: true });

  writeFileSync(
    join(familyDir, "family.yaml"),
    `apiVersion: mba.ai/v1alpha1
kind: ModelBehavioralAdapter
metadata:
  id: qwen3-coder-family
  family: qwen3-coder
identity:
  model:
    family: qwen3-coder
bindings:
  instructions: "./instructions.md"
  notes: "./notes.md"
`,
  );
  writeFileSync(join(familyDir, "instructions.md"), opts.familyInstructions ?? "# family card\n");
  writeFileSync(join(familyDir, "notes.md"), "# family notes — never copy\n");

  const modelBindings = opts.omitModelInstructionsBinding
    ? "  notes: \"./notes.md\"\n"
    : "  instructions: \"./instructions.md\"\n  notes: \"./notes.md\"\n";
  writeFileSync(
    join(modelDir, "qwen3-coder-30b.yaml"),
    `apiVersion: mba.ai/v1alpha1
kind: ModelBehavioralAdapter
metadata:
  id: qwen3-coder-30b
  name: qwen3-coder-30b
  family: qwen3-coder
identity:
  model:
    name: qwen3-coder-30b
    family: qwen3-coder
    file: "./m.gguf"
bindings:
${modelBindings}`,
  );
  if (!opts.omitModelInstructionsBinding) {
    writeFileSync(join(modelDir, "instructions.md"), opts.modelInstructions ?? "# model card\n");
  }
  writeFileSync(join(modelDir, "notes.md"), "# model notes — never copy\n");
  writeFileSync(join(modelDir, "m.gguf"), "not-a-real-gguf");

  const project = join(dir, "project");
  mkdirSync(project);
  return { adapterDir, project };
}

describe("stageModelCard", () => {
  it("stages the model card when it replaces the family file", () => {
    const { adapterDir, project } = writeTree({});
    const result = stageModelCard({
      adapterDir,
      modelId: "qwen3-coder-30b",
      projectRoot: project,
      harness: "claude-code",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action).toBe("wrote");
    expect(result.modelId).toBe("qwen3-coder-30b");
    const body = readFileSync(join(project, "CLAUDE.local.md"), "utf8");
    expect(body).toContain("# model card");
    expect(body).not.toContain("family card");
    expect(body).not.toContain("never copy");
    expect(body).toContain(MBA_STAGE_MARKER);
  });

  it("inherits the family card when the model yaml omits the binding", () => {
    const { adapterDir, project } = writeTree({ omitModelInstructionsBinding: true });
    const result = stageModelCard({
      adapterDir,
      modelId: "qwen3-coder-30b",
      projectRoot: project,
      harness: "cursor",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action).toBe("wrote");
    const body = readFileSync(join(project, ".cursor/rules/mba.mdc"), "utf8");
    expect(body).toContain("# family card");
    expect(body).toContain("alwaysApply: true");
  });

  it("skips an empty winning card", () => {
    const { adapterDir, project } = writeTree({ modelInstructions: "  \n" });
    const result = stageModelCard({
      adapterDir,
      modelId: "qwen3-coder-30b",
      projectRoot: project,
      harness: "copilot",
    });
    expect(result).toMatchObject({ ok: true, action: "skipped", reason: "empty" });
  });

  it("returns unknown-model for an id not in the catalog", () => {
    const { adapterDir, project } = writeTree({});
    const result = stageModelCard({
      adapterDir,
      modelId: "nope",
      projectRoot: project,
      harness: "cline",
    });
    expect(result).toMatchObject({ ok: false, code: "unknown-model" });
  });
});
