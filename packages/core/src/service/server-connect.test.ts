/**
 * POST /connect — stage the card and mint a pairing token.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import { createMbaServiceApp } from "./server.js";
import { defaultStorePaths } from "./config-store.js";
import { hashToken, readSessions } from "./sessions.js";

function writeFixture(dir: string): void {
  const modelDir = join(dir, "qwen3-coder", "qwen3-coder-30b");
  mkdirSync(modelDir, { recursive: true });
  writeFileSync(
    join(modelDir, "qwen3-coder-30b.yaml"),
    `apiVersion: mba.ai/v1alpha1
kind: ModelBehavioralAdapter
metadata:
  id: qwen3-coder-30b
  name: qwen3-coder-30b
identity:
  model:
    name: qwen3-coder-30b
    file: "./m.gguf"
bindings:
  instructions: "./instructions.md"
`,
  );
  writeFileSync(join(modelDir, "instructions.md"), "# card\n");
  writeFileSync(join(modelDir, "m.gguf"), "gguf");
}

describe("POST /connect", () => {
  let adapterDir: string;
  let project: string;
  let paths: ReturnType<typeof defaultStorePaths>;
  let app: ReturnType<typeof createMbaServiceApp>;

  beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), "mba-svc-connect-"));
    adapterDir = join(root, "mba", "adapters");
    mkdirSync(adapterDir, { recursive: true });
    writeFixture(adapterDir);
    project = join(root, "project");
    mkdirSync(project);
    paths = defaultStorePaths(join(root, "state"));
    app = createMbaServiceApp({ paths, adapterDir });
  });

  it("mints a token, stages the card, and locks the proxy", async () => {
    const res = await app.request("/connect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "qwen3-coder-30b",
        projectRoot: project,
        harness: "cursor",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      token: string;
      modelId: string;
      stage: { action: string; envelope: string };
    };
    expect(body.modelId).toBe("qwen3-coder-30b");
    expect(body.token.startsWith("mba.")).toBe(true);
    expect(body.stage.action).toBe("wrote");
    expect(body.stage.envelope).toBe(".cursor/rules/mba.mdc");
    const stored = readSessions(paths.sessionsPath);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.tokenHash).toBe(hashToken(body.token));
    const disk = readFileSync(paths.sessionsPath, "utf8");
    expect(disk).not.toContain(body.token);
    expect(disk).not.toMatch(/"token"/);

    const status = await app.request("/status");
    const st = (await status.json()) as {
      pairing: { active: boolean; count: number; sessions: Array<Record<string, unknown>> };
    };
    expect(st.pairing).toMatchObject({ active: true, count: 1 });
    expect(st.pairing.sessions[0]).toMatchObject({
      modelId: "qwen3-coder-30b",
      harness: "cursor",
    });
    expect(st.pairing.sessions[0]).not.toHaveProperty("token");
    expect(st.pairing.sessions[0]).not.toHaveProperty("tokenHash");

    const locked = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "qwen3-coder-30b", messages: [] }),
    });
    expect(locked.status).toBe(401);

    const authed = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${body.token}`,
      },
      body: JSON.stringify({ model: "qwen3-coder-30b", messages: [] }),
    });
    // No server booted — pairing passed, registry empty.
    expect(authed.status).toBe(503);
  });

  it("revokes sessions and opens the door again", async () => {
    await app.request("/connect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "qwen3-coder-30b",
        projectRoot: project,
        harness: "cursor",
      }),
    });
    const rev = await app.request("/connect/revoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(rev.status).toBe(200);
    const pairing = (await rev.json()) as { pairing: { active: boolean; count: number } };
    expect(pairing.pairing).toEqual({ active: false, count: 0 });

    const open = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "qwen3-coder-30b", messages: [] }),
    });
    expect(open.status).toBe(503);
  });
});
