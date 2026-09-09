import { describe, expect, it } from "vitest";
import { DEFAULT_RESOLVE_ENV, defaultIdeForHarness, resolveEnvContext } from "./env-context.js";
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

describe("resolveEnvContext", () => {
  it("falls back to copilot+vscode+llamacpp when unpaired", () => {
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
