import { describe, expect, it } from "vitest";
import {
  KNOWN_HARNESSES,
  MBA_STAGE_MARKER,
  envelopeFileStem,
  envelopeRelativePath,
  isMbaStaged,
  normalizeHarness,
  stagedModelId,
  wrapStagedCard,
} from "./envelope.js";

describe("envelopeRelativePath", () => {
  it("maps each known harness to a slot the client already injects", () => {
    expect(envelopeRelativePath("claude-code")).toBe("CLAUDE.local.md");
    expect(envelopeRelativePath("claude-code", undefined, [], "deepseek_test")).toBe(
      "CLAUDE.local.md",
    );
    expect(envelopeRelativePath("cursor")).toBe(".cursor/rules/mba.mdc");
    expect(envelopeRelativePath("cursor", undefined, [], "deepseek_test")).toBe(
      ".cursor/rules/mba.mdc",
    );
    expect(envelopeRelativePath("cline")).toBe(".clinerules/mba.md");
    expect(envelopeRelativePath("cline", undefined, [], "deepseek_test")).toBe(
      ".clinerules/mba.md",
    );
    expect(envelopeRelativePath("copilot")).toBe(".github/instructions/mba.instructions.md");
    expect(envelopeRelativePath("copilot", undefined, [], "deepseek_test")).toBe(
      ".github/instructions/mba.instructions.md",
    );
    expect(envelopeRelativePath("continue")).toBe(".continue/rules/mba.md");
    expect(envelopeRelativePath("continue", undefined, [], "deepseek_test")).toBe(
      ".continue/rules/mba.md",
    );
  });

  it("folds aliases onto the closed set", () => {
    expect(normalizeHarness("claude")).toBe("claude-code");
    expect(normalizeHarness("Claude Code")).toBe("claude-code");
    expect(normalizeHarness("github-copilot")).toBe("copilot");
    expect(envelopeRelativePath("claude")).toBe("CLAUDE.local.md");
  });

  it("returns undefined for an unknown harness", () => {
    expect(envelopeRelativePath("unknown")).toBeUndefined();
    expect(envelopeRelativePath("vscode")).toBeUndefined();
  });

  it("resolves an operator-defined extra after the shipped set", () => {
    expect(
      envelopeRelativePath("windsurf", undefined, [
        { name: "windsurf", envelope: ".windsurf/mba.md" },
      ]),
    ).toBe(".windsurf/mba.md");
    expect(
      envelopeRelativePath("cursor", undefined, [
        { name: "windsurf", envelope: ".windsurf/mba.md" },
      ]),
    ).toBe(".cursor/rules/mba.mdc");
    expect(
      envelopeRelativePath("windsurf", undefined, [
        { name: "windsurf", envelope: ".windsurf/{model}.md" },
      ], "deepseek_test"),
    ).toBe(".windsurf/deepseek_test.md");
  });

  it("keeps the closed set small", () => {
    expect(KNOWN_HARNESSES).toHaveLength(5);
  });
});

describe("wrapStagedCard", () => {
  it("always plants the MBA marker", () => {
    const wrapped = wrapStagedCard("cline", "be terse\n");
    expect(isMbaStaged(wrapped)).toBe(true);
    expect(wrapped).toContain("be terse");
    expect(wrapped.startsWith(MBA_STAGE_MARKER)).toBe(true);
  });

  it("adds Cursor alwaysApply frontmatter", () => {
    const wrapped = wrapStagedCard("cursor", "# card", "deepseek_test");
    expect(wrapped).toContain("alwaysApply: true");
    expect(wrapped).toContain('"deepseek_test model card (live copy; do not edit)"');
    expect(wrapped).toContain("<!-- mba-model: deepseek_test -->");
    expect(isMbaStaged(wrapped)).toBe(true);
  });

  it("names the model in the staged marker for every harness", () => {
    const wrapped = wrapStagedCard("claude-code", "# card", "deepseek_test");
    expect(wrapped).toContain("<!-- mba-model: deepseek_test -->");
    expect(wrapped.startsWith(MBA_STAGE_MARKER)).toBe(true);
  });

  it("adds Copilot applyTo frontmatter", () => {
    const wrapped = wrapStagedCard("copilot", "# card");
    expect(wrapped).toContain('applyTo: "**"');
  });

  it("strips trailing whitespace without leaving a blank run at the end", () => {
    const wrapped = wrapStagedCard("cline", "# card\n\n  \n");
    expect(wrapped).toBe(`${MBA_STAGE_MARKER}\n\n# card\n`);
  });
});

describe("envelopeFileStem", () => {
  it("keeps a safe model id and falls back to mba", () => {
    expect(envelopeFileStem("deepseek_test")).toBe("deepseek_test");
    expect(envelopeFileStem("qwen3-coder-30b")).toBe("qwen3-coder-30b");
    expect(envelopeFileStem("../odd name")).toBe("odd-name");
    expect(envelopeFileStem("")).toBe("mba");
    expect(envelopeFileStem(undefined)).toBe("mba");
  });
});

describe("stagedModelId", () => {
  it("reads the model marker from a wrapped card", () => {
    const wrapped = wrapStagedCard("cursor", "# card", "deepseek_test");
    expect(stagedModelId(wrapped)).toBe("deepseek_test");
    expect(stagedModelId("# no marker")).toBeUndefined();
  });
});
