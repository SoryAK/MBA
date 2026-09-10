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

function writeEmbedFixture(dir: string): void {
  const modelDir = join(dir, "nomic", "nomic-embed-text-v1.5");
  mkdirSync(modelDir, { recursive: true });
  writeFileSync(
    join(modelDir, "nomic-embed-text-v1.5.yaml"),
    `apiVersion: mba.ai/v1alpha1
kind: ModelBehavioralAdapter
metadata:
  id: nomic-embed-text-v1.5
  name: nomic-embed-text-v1.5
identity:
  model:
    name: nomic-embed-text-v1.5
    file: "./m.gguf"
bindings: {}
`,
  );
  writeFileSync(join(modelDir, "m.gguf"), "gguf");
}

function writeOtherCardFixture(dir: string): void {
  const modelDir = join(dir, "other", "other-coder");
  mkdirSync(modelDir, { recursive: true });
  writeFileSync(
    join(modelDir, "other-coder.yaml"),
    `apiVersion: mba.ai/v1alpha1
kind: ModelBehavioralAdapter
metadata:
  id: other-coder
  name: other-coder
identity:
  model:
    name: other-coder
    file: "./m.gguf"
bindings:
  instructions: "./instructions.md"
`,
  );
  writeFileSync(join(modelDir, "instructions.md"), "# other card\n");
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
      card: true,
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

  it("keeps a playbook when a second model on the same slot has no card", async () => {
    const first = await app.request("/connect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "qwen3-coder-30b",
        projectRoot: project,
        harness: "cursor",
      }),
    });
    expect(first.status).toBe(200);
    expect(readFileSync(join(project, ".cursor/rules/mba.mdc"), "utf8")).toContain("# card");

    writeEmbedFixture(adapterDir);

    const second = await app.request("/connect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "nomic-embed-text-v1.5",
        projectRoot: project,
        harness: "cursor",
      }),
    });
    expect(second.status).toBe(200);
    const body = (await second.json()) as { stage: { action: string } };
    expect(body.stage.action).toBe("skipped");
    expect(readFileSync(join(project, ".cursor/rules/mba.mdc"), "utf8")).toContain("# card");
    expect(readSessions(paths.sessionsPath)).toHaveLength(2);

    const rev = await app.request("/connect/revoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "nomic-embed-text-v1.5" }),
    });
    expect(rev.status).toBe(200);
    expect(readFileSync(join(project, ".cursor/rules/mba.mdc"), "utf8")).toContain("# card");
    expect(readSessions(paths.sessionsPath)).toHaveLength(1);
  });

  it("lets the last model with a card own the harness envelope", async () => {
    await app.request("/connect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "qwen3-coder-30b",
        projectRoot: project,
        harness: "cursor",
      }),
    });
    writeOtherCardFixture(adapterDir);
    const second = await app.request("/connect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "other-coder",
        projectRoot: project,
        harness: "cursor",
      }),
    });
    expect(second.status).toBe(200);
    const body = (await second.json()) as {
      stage: { action: string; owner?: string; replaced?: string };
    };
    expect(body.stage).toMatchObject({
      action: "wrote",
      owner: "other-coder",
      replaced: "qwen3-coder-30b",
    });
    const disk = readFileSync(join(project, ".cursor/rules/mba.mdc"), "utf8");
    expect(disk).toContain("# other card");
    expect(disk).not.toContain("# card\n");
    expect(disk).toContain("<!-- mba-model: other-coder -->");

    const status = await app.request("/status");
    const st = (await status.json()) as {
      pairing: { sessions: Array<{ modelId: string; card: boolean }> };
    };
    expect(st.pairing.sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          modelId: "qwen3-coder-30b",
          card: false,
          envelope: ".cursor/rules/mba.mdc",
        }),
        expect.objectContaining({
          modelId: "other-coder",
          card: true,
          envelope: ".cursor/rules/mba.mdc",
        }),
      ]),
    );
  });
});
