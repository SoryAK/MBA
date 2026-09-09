/**
 * POST /models/stage — copy winning instructions.md into a harness envelope.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import { createMbaServiceApp } from "./server.js";
import { defaultStorePaths } from "./config-store.js";
import { MBA_STAGE_MARKER } from "../mba/envelope.js";

function writeStageFixture(dir: string): void {
  const modelDir = join(dir, "qwen3-coder", "qwen3-coder-30b");
  mkdirSync(modelDir, { recursive: true });
  writeFileSync(
    join(dir, "qwen3-coder", "family.yaml"),
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
  writeFileSync(join(dir, "qwen3-coder", "instructions.md"), "# family\n");
  writeFileSync(join(dir, "qwen3-coder", "notes.md"), "# family notes\n");
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
  instructions: "./instructions.md"
  notes: "./notes.md"
`,
  );
  writeFileSync(join(modelDir, "instructions.md"), "# model playbook\n");
  writeFileSync(join(modelDir, "notes.md"), "# operator notes\n");
  writeFileSync(join(modelDir, "m.gguf"), "gguf");
}

describe("POST /models/stage", () => {
  let adapterDir: string;
  let project: string;
  let app: ReturnType<typeof createMbaServiceApp>;

  beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), "mba-svc-stage-"));
    adapterDir = join(root, "mba", "adapters");
    mkdirSync(adapterDir, { recursive: true });
    writeStageFixture(adapterDir);
    project = join(root, "project");
    mkdirSync(project);
    app = createMbaServiceApp({
      paths: defaultStorePaths(join(root, "state")),
      adapterDir,
    });
  });

  it("copies the winning card into the harness slot", async () => {
    const res = await app.request("/models/stage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "qwen3-coder-30b",
        projectRoot: project,
        harness: "claude-code",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { action: string; envelope: string; dest: string };
    expect(body.action).toBe("wrote");
    expect(body.envelope).toBe("CLAUDE.local.md");
    const staged = readFileSync(join(project, "CLAUDE.local.md"), "utf8");
    expect(staged).toContain(MBA_STAGE_MARKER);
    expect(staged).toContain("# model playbook");
    expect(staged).not.toContain("operator notes");
  });

  it("rejects an unknown model with 404", async () => {
    const res = await app.request("/models/stage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "missing",
        projectRoot: project,
        harness: "cursor",
      }),
    });
    expect(res.status).toBe(404);
  });

  it("rejects a malformed body with 400", async () => {
    const res = await app.request("/models/stage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "qwen3-coder-30b" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 409 when the envelope is not MBA-owned", async () => {
    writeFileSync(join(project, "CLAUDE.local.md"), "# mine\n");
    const res = await app.request("/models/stage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "qwen3-coder-30b",
        projectRoot: project,
        harness: "claude",
      }),
    });
    expect(res.status).toBe(409);
    expect(readFileSync(join(project, "CLAUDE.local.md"), "utf8")).toBe("# mine\n");
  });
});
