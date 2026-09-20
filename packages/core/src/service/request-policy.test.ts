import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultToolCircuitBreakerConfig } from "../bcb/default-config.js";
import { resolveChatPolicy } from "./request-policy.js";
import type { ClientSession } from "./sessions.js";

function writeQwen(root: string, opts?: { tcb?: string }): string {
  const modelDir = join(root, "qwen", "qwen");
  mkdirSync(modelDir, { recursive: true });
  writeFileSync(
    join(modelDir, "qwen.yaml"),
    [
      "apiVersion: mba.ai/v1alpha1",
      "kind: ModelBehavioralAdapter",
      "metadata:",
      "  id: qwen",
      "identity:",
      "  model:",
      '    file: "/models/qwen.gguf"',
      "bindings:",
      '  tcb: "./tcb.jsonl"',
    ].join("\n"),
  );
  writeFileSync(join(modelDir, "tcb.jsonl"), opts?.tcb ?? "{}\n");
  return root;
}

const seed = defaultToolCircuitBreakerConfig();

describe("resolveChatPolicy", () => {
  it("overlays a model watch off onto the live global TCB", () => {
    const adapterDir = writeQwen(mkdtempSync(join(tmpdir(), "mba-policy-")), {
      tcb: JSON.stringify({ tool: "read_file", rule: "eofOverflow", enabled: false }) + "\n",
    });
    const policy = resolveChatPolicy({
      globalTcb: seed,
      adapterDir,
      requestModel: "qwen",
      ua: "copilot",
      body: JSON.stringify({ model: "qwen", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(policy.modelId).toBe("qwen");
    expect(policy.tcb.tools.read_file?.eofOverflow?.enabled).toBe(false);
    expect(policy.tcb.tools.read_file?.repeatRun?.enabled).toBe(true);
  });

  it("uses the paired harness instead of the User-Agent fingerprint", () => {
    const adapterDir = writeQwen(mkdtempSync(join(tmpdir(), "mba-policy-")));
    const session: ClientSession = {
      id: "sess.1",
      modelId: "qwen",
      harness: "cursor",
      ide: "cursor",
      projectRoot: "/tmp/p",
      tokenHash: "a".repeat(64),
      createdAt: "2026-09-09T00:00:00.000Z",
    };
    const policy = resolveChatPolicy({
      globalTcb: seed,
      adapterDir,
      requestModel: "qwen",
      session,
      ua: "cline",
      body: JSON.stringify({
        model: "qwen",
        messages: [{ role: "system", content: "you are cline" }, { role: "user", content: "hi" }],
      }),
    });
    expect(policy.harness).toBe("cursor");
    expect(policy.ide).toBe("cursor");
  });

  it("falls back to the fingerprint when no session is paired", () => {
    const policy = resolveChatPolicy({
      globalTcb: seed,
      ua: "continue",
      body: JSON.stringify({
        model: "qwen",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(policy.harness).toBe("continue");
    expect(policy.tcb).toBe(seed);
  });
});
