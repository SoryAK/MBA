import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MBA_STAGE_MARKER } from "./envelope.js";
import { isPathInside, stageInstructions } from "./stage-instructions.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mba-stage-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("isPathInside", () => {
  it("rejects siblings that share a prefix", () => {
    expect(isPathInside("/tmp/proj", "/tmp/proj/card.md")).toBe(true);
    expect(isPathInside("/tmp/proj", "/tmp/proj-other/card.md")).toBe(false);
    expect(isPathInside("/tmp/proj", "/tmp/proj")).toBe(false);
  });
});

describe("stageInstructions", () => {
  it("copies a non-empty card into the harness slot", () => {
    const store = join(dir, "store");
    const project = join(dir, "project");
    mkdirSync(store);
    mkdirSync(project);
    const source = join(store, "instructions.md");
    writeFileSync(source, "# model playbook\n");

    const result = stageInstructions({
      projectRoot: project,
      sourcePath: source,
      harness: "claude-code",
      sourceRoot: store,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action).toBe("wrote");
    expect(result.envelope).toBe("CLAUDE.local.md");
    const dest = join(project, "CLAUDE.local.md");
    const body = readFileSync(dest, "utf8");
    expect(body).toContain(MBA_STAGE_MARKER);
    expect(body).toContain("# model playbook");
    expect(body).not.toContain("operator secret");
  });

  it("never writes notes.md into the project", () => {
    const store = join(dir, "store");
    const project = join(dir, "project");
    mkdirSync(store);
    mkdirSync(project);
    writeFileSync(join(store, "instructions.md"), "card\n");
    writeFileSync(join(store, "notes.md"), "operator secret\n");

    const result = stageInstructions({
      projectRoot: project,
      sourcePath: join(store, "instructions.md"),
      harness: "cursor",
      sourceRoot: store,
    });
    expect(result.ok).toBe(true);
    const staged = readFileSync(join(project, ".cursor/rules/mba.mdc"), "utf8");
    expect(staged).toContain("card");
    expect(staged).not.toContain("operator secret");
    expect(() => readFileSync(join(project, "notes.md"), "utf8")).toThrow();
  });

  it("skips an empty card and does not create the envelope", () => {
    const store = join(dir, "store");
    const project = join(dir, "project");
    mkdirSync(store);
    mkdirSync(project);
    writeFileSync(join(store, "instructions.md"), "  \n");

    const result = stageInstructions({
      projectRoot: project,
      sourcePath: join(store, "instructions.md"),
      harness: "cline",
      sourceRoot: store,
    });
    expect(result).toMatchObject({ ok: true, action: "skipped", reason: "empty" });
    expect(() => readFileSync(join(project, ".clinerules/mba.md"), "utf8")).toThrow();
  });

  it("removes a previous MBA envelope when the new card is empty", () => {
    const store = join(dir, "store");
    const project = join(dir, "project");
    mkdirSync(store);
    mkdirSync(join(project, ".clinerules"), { recursive: true });
    writeFileSync(join(store, "instructions.md"), "");
    writeFileSync(join(project, ".clinerules/mba.md"), `${MBA_STAGE_MARKER}\n\nold card\n`);

    const result = stageInstructions({
      projectRoot: project,
      sourcePath: join(store, "instructions.md"),
      harness: "cline",
      sourceRoot: store,
    });
    expect(result).toMatchObject({ ok: true, action: "removed", reason: "empty" });
    expect(() => readFileSync(join(project, ".clinerules/mba.md"), "utf8")).toThrow();
  });

  it("refuses to overwrite a file MBA did not stage", () => {
    const store = join(dir, "store");
    const project = join(dir, "project");
    mkdirSync(store);
    mkdirSync(project);
    writeFileSync(join(store, "instructions.md"), "card\n");
    writeFileSync(join(project, "CLAUDE.local.md"), "# mine\n");

    const result = stageInstructions({
      projectRoot: project,
      sourcePath: join(store, "instructions.md"),
      harness: "claude",
      sourceRoot: store,
    });
    expect(result).toMatchObject({ ok: false, code: "conflict" });
    expect(readFileSync(join(project, "CLAUDE.local.md"), "utf8")).toBe("# mine\n");
  });

  it("overwrites an existing MBA-staged envelope", () => {
    const store = join(dir, "store");
    const project = join(dir, "project");
    mkdirSync(store);
    mkdirSync(project);
    writeFileSync(join(store, "instructions.md"), "new card\n");
    writeFileSync(join(project, "CLAUDE.local.md"), `${MBA_STAGE_MARKER}\n\nold\n`);

    const result = stageInstructions({
      projectRoot: project,
      sourcePath: join(store, "instructions.md"),
      harness: "claude-code",
      sourceRoot: store,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action).toBe("wrote");
    expect(readFileSync(join(project, "CLAUDE.local.md"), "utf8")).toContain("new card");
  });

  it("rejects a source path outside the adapter tree", () => {
    const store = join(dir, "store");
    const project = join(dir, "project");
    mkdirSync(store);
    mkdirSync(project);
    const outside = join(dir, "outside.md");
    writeFileSync(outside, "stolen\n");

    const result = stageInstructions({
      projectRoot: project,
      sourcePath: outside,
      harness: "copilot",
      sourceRoot: store,
    });
    expect(result).toMatchObject({ ok: false, code: "source-escape" });
  });

  it("rejects an unknown harness", () => {
    const project = join(dir, "project");
    mkdirSync(project);
    const result = stageInstructions({
      projectRoot: project,
      sourcePath: join(dir, "x.md"),
      harness: "notepad",
    });
    expect(result).toMatchObject({ ok: false, code: "unknown-harness" });
  });

  it("stages into an operator-defined envelope", () => {
    const store = join(dir, "store");
    const project = join(dir, "project");
    mkdirSync(store);
    mkdirSync(project);
    writeFileSync(join(store, "instructions.md"), "# added client\n");
    const result = stageInstructions({
      projectRoot: project,
      sourcePath: join(store, "instructions.md"),
      harness: "windsurf",
      envelopes: [{ name: "windsurf", envelope: ".windsurf/mba.md" }],
      sourceRoot: store,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.envelope).toBe(".windsurf/mba.md");
    expect(readFileSync(join(project, ".windsurf/mba.md"), "utf8")).toContain("# added client");
  });

  it("rejects a missing project folder", () => {
    const result = stageInstructions({
      projectRoot: join(dir, "nope"),
      harness: "cursor",
    });
    expect(result).toMatchObject({ ok: false, code: "invalid-project" });
  });

  it("refuses to stage under a path that is already a file", () => {
    const store = join(dir, "store");
    const project = join(dir, "project");
    mkdirSync(store);
    mkdirSync(project);
    writeFileSync(join(store, "instructions.md"), "card\n");
    writeFileSync(join(project, ".clinerules"), "user cline rules\n");

    const result = stageInstructions({
      projectRoot: project,
      sourcePath: join(store, "instructions.md"),
      harness: "cline",
      sourceRoot: store,
    });
    expect(result).toMatchObject({ ok: false, code: "conflict" });
    expect(readFileSync(join(project, ".clinerules"), "utf8")).toBe("user cline rules\n");
  });
});
