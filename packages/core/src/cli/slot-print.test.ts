import { describe, expect, it } from "vitest";
import { extraIde, formatClientLabel, harnessKind } from "../service/env-context.js";
import { formatPairedSlotLines, groupPairedSlots } from "./slot-print.js";

const PROJECT = "/home/dev/MBA";

describe("harnessKind", () => {
  it("marks Claude Code as cli and the rest as ide", () => {
    expect(harnessKind("claude-code")).toBe("cli");
    expect(harnessKind("claude")).toBe("cli");
    expect(harnessKind("cursor")).toBe("ide");
    expect(harnessKind("copilot")).toBe("ide");
  });
});

describe("extraIde", () => {
  it("hides the default and the same-name ide", () => {
    expect(extraIde("cursor", "cursor")).toBeUndefined();
    expect(extraIde("copilot", "vscode")).toBeUndefined();
    expect(extraIde("copilot", "cursor")).toBe("cursor");
    expect(formatClientLabel("copilot", "cursor")).toBe("copilot+cursor");
  });
});

describe("groupPairedSlots", () => {
  it("stacks models that share harness + project + envelope", () => {
    const groups = groupPairedSlots([
      {
        harness: "cursor",
        ide: "cursor",
        projectRoot: PROJECT,
        modelId: "nomic-embed-text-v1.5",
        card: false,
        envelope: ".cursor/rules/mba.mdc",
      },
      {
        harness: "cursor",
        ide: "cursor",
        projectRoot: PROJECT,
        modelId: "deepseek_test",
        card: true,
        envelope: ".cursor/rules/mba.mdc",
      },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.models.map((m) => m.modelId)).toEqual([
      "deepseek_test",
      "nomic-embed-text-v1.5",
    ]);
  });
});

describe("formatPairedSlotLines", () => {
  it("names the app, the kind, and the envelope file", () => {
    const lines = formatPairedSlotLines([
      {
        harness: "cursor",
        ide: "cursor",
        projectRoot: PROJECT,
        modelId: "deepseek_test",
        card: true,
        envelope: ".cursor/rules/mba.mdc",
      },
      {
        harness: "cursor",
        ide: "cursor",
        projectRoot: PROJECT,
        modelId: "nomic-embed-text-v1.5",
        card: false,
        envelope: ".cursor/rules/mba.mdc",
      },
    ]);
    expect(lines[0]).toContain("cursor");
    expect(lines[0]).toContain("ide");
    expect(lines[0]).toContain(".cursor/rules/mba.mdc");
    expect(lines[0]).not.toContain("cursor+cursor");
    expect(lines.some((l) => l.includes("deepseek_test") && l.includes("card"))).toBe(true);
    expect(lines.some((l) => l.includes("nomic-embed-text-v1.5") && l.includes("pair"))).toBe(
      true,
    );
  });

  it("marks Claude Code as cli", () => {
    const lines = formatPairedSlotLines([
      {
        harness: "claude-code",
        projectRoot: PROJECT,
        modelId: "deepseek_test",
        card: true,
        envelope: "CLAUDE.local.md",
      },
    ]);
    expect(lines[0]).toContain("claude-code");
    expect(lines[0]).toContain("cli");
    expect(lines[0]).toContain("CLAUDE.local.md");
  });
});
