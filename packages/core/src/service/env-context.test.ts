import { describe, expect, it } from "vitest";
import {
  BARE_BOOT_ENV,
  DEFAULT_RESOLVE_ENV,
  bootEnvJson,
  defaultIdeForHarness,
  formatClientLabel,
  isBareBootEnv,
  overlayFolderName,
  resolveEnvContext,
} from "./env-context.js";
import { hashToken, type ClientSession } from "./sessions.js";

function session(partial: Partial<ClientSession> & Pick<ClientSession, "modelId" | "harness">): ClientSession {
  return {
    id: partial.id ?? "s1",
    modelId: partial.modelId,
    harness: partial.harness,
    ide: partial.ide,
    projectRoot: partial.projectRoot ?? "/tmp/p",
    tokenHash: partial.tokenHash ?? hashToken("mba.x"),
    createdAt: partial.createdAt ?? "2026-09-09T00:00:00.000Z",
  };
}

describe("BARE_BOOT_ENV", () => {
  it("is none and skips env folders", () => {
    expect(isBareBootEnv(BARE_BOOT_ENV)).toBe(true);
    expect(isBareBootEnv(DEFAULT_RESOLVE_ENV)).toBe(false);
    expect(bootEnvJson(BARE_BOOT_ENV)).toEqual({
      harness: "none",
      ide: "none",
      serverRuntime: "llamacpp",
    });
  });
});

describe("resolveEnvContext", () => {
  it("falls back to copilot+vscode+llamacpp when unpaired (connect/stage, not boot)", () => {
    expect(resolveEnvContext({ modelId: "deepseek_test" })).toEqual(DEFAULT_RESOLVE_ENV);
  });

  it("uses the newest pairing for that model", () => {
    const env = resolveEnvContext({
      modelId: "deepseek_test",
      sessions: [
        session({
          modelId: "deepseek_test",
          harness: "copilot",
          ide: "vscode",
          createdAt: "2026-09-09T00:00:00.000Z",
        }),
        session({
          id: "s2",
          modelId: "deepseek_test",
          harness: "cursor",
          createdAt: "2026-09-09T02:00:00.000Z",
        }),
      ],
    });
    expect(env).toEqual({
      harness: "cursor",
      ide: "cursor",
      serverRuntime: "llamacpp",
    });
  });

  it("fills ide from an added client when the session omitted it", () => {
    const env = resolveEnvContext({
      modelId: "m",
      sessions: [session({ modelId: "m", harness: "windsurf" })],
      operatorClients: [{ name: "windsurf", envelope: ".windsurf/mba.md", ide: "vscode" }],
    });
    expect(env.harness).toBe("windsurf");
    expect(env.ide).toBe("vscode");
  });
});

describe("defaultIdeForHarness", () => {
  it("maps shipped harnesses", () => {
    expect(defaultIdeForHarness("copilot")).toBe("vscode");
    expect(defaultIdeForHarness("cursor")).toBe("cursor");
    expect(defaultIdeForHarness("claude-code")).toBe("cli");
    expect(defaultIdeForHarness("windsurf")).toBe("vscode");
  });
});

describe("overlayFolderName", () => {
  it("stays harness-only unless ide or runtime actually differs", () => {
    expect(overlayFolderName({ harness: "cursor", ide: "cursor", serverRuntime: "llamacpp" })).toBe(
      "cursor",
    );
    expect(overlayFolderName({ harness: "copilot", ide: "vscode", serverRuntime: "llamacpp" })).toBe(
      "copilot",
    );
    expect(overlayFolderName({ harness: "claude-code", ide: "cli" })).toBe("claude-code");
    expect(overlayFolderName({ harness: "copilot", ide: "cursor" })).toBe("copilot+cursor");
    expect(
      overlayFolderName({ harness: "cursor", ide: "cursor", serverRuntime: "ollama" }),
    ).toBe("cursor+ollama");
  });
});

describe("formatClientLabel", () => {
  it("drops a redundant or default ide", () => {
    expect(formatClientLabel("cursor", "cursor")).toBe("cursor");
    expect(formatClientLabel("copilot", "vscode")).toBe("copilot");
    expect(formatClientLabel("claude-code", "cli")).toBe("claude-code");
    expect(formatClientLabel("cursor")).toBe("cursor");
    expect(formatClientLabel("windsurf", "vscode")).toBe("windsurf");
  });

  it("keeps a non-default ide", () => {
    expect(formatClientLabel("copilot", "cursor")).toBe("copilot+cursor");
  });
});
