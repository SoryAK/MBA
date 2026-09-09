import { describe, expect, it } from "vitest";
import {
  KNOWN_HARNESSES,
  MBA_STAGE_MARKER,
  envelopeRelativePath,
  isMbaStaged,
  normalizeHarness,
  wrapStagedCard,
} from "./envelope.js";

describe("envelopeRelativePath", () => {
  it("maps each known harness to a slot the client already injects", () => {
    expect(envelopeRelativePath("claude-code")).toBe("CLAUDE.local.md");
    expect(envelopeRelativePath("cursor")).toBe(".cursor/rules/mba.mdc");
    expect(envelopeRelativePath("cline")).toBe(".clinerules/mba.md");
    expect(envelopeRelativePath("copilot")).toBe(".github/instructions/mba.instructions.md");
    expect(envelopeRelativePath("continue")).toBe(".continue/rules/mba.md");
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
    const wrapped = wrapStagedCard("cursor", "# card");
    expect(wrapped).toContain("alwaysApply: true");
    expect(isMbaStaged(wrapped)).toBe(true);
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
