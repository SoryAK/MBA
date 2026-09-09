import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  authorizeChat,
  bearerToken,
  hashToken,
  mintToken,
  pairingActive,
  publicSessions,
  readSessions,
  revokeSessions,
  upsertSession,
  writeSessions,
  type ClientSession,
} from "./sessions.js";

function session(
  partial: Partial<ClientSession> & Pick<ClientSession, "modelId"> & { token?: string },
): ClientSession {
  return {
    id: partial.id ?? "s1",
    modelId: partial.modelId,
    harness: partial.harness ?? "cursor",
    projectRoot: partial.projectRoot ?? "/tmp/proj",
    tokenHash: partial.tokenHash ?? hashToken(partial.token ?? "mba.secret"),
    createdAt: partial.createdAt ?? "2026-09-09T00:00:00.000Z",
    ide: partial.ide,
  };
}

describe("sessions", () => {
  it("treats a missing file as no pairing", () => {
    const path = join(mkdtempSync(join(tmpdir(), "mba-sess-")), "sessions.json");
    expect(readSessions(path)).toEqual([]);
    expect(pairingActive([])).toBe(false);
  });

  it("publicSessions omits the hash", () => {
    const row = session({ modelId: "deepseek_test", token: "mba.secret" });
    const pub = publicSessions([row]);
    expect(pub).toHaveLength(1);
    expect(pub[0]).toMatchObject({
      id: "s1",
      modelId: "deepseek_test",
      harness: "cursor",
      projectRoot: "/tmp/proj",
    });
    expect(pub[0]).not.toHaveProperty("token");
    expect(pub[0]).not.toHaveProperty("tokenHash");
  });

  it("round-trips a session and stores the hash, not the plaintext", () => {
    const path = join(mkdtempSync(join(tmpdir(), "mba-sess-")), "sessions.json");
    const plaintext = mintToken();
    const first = session({ modelId: "deepseek_test", token: "mba.old" });
    writeSessions(path, upsertSession([], first));
    const rotated = session({
      id: "s2",
      modelId: "deepseek_test",
      token: plaintext,
      createdAt: "2026-09-09T01:00:00.000Z",
    });
    writeSessions(path, upsertSession(readSessions(path), rotated));
    const rows = readSessions(path);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tokenHash).toBe(hashToken(plaintext));
    const disk = readFileSync(path, "utf8");
    expect(disk).not.toContain(plaintext);
    expect(disk).not.toMatch(/"token"/);
    expect(JSON.parse(disk)).toMatchObject({ version: 2 });
  });

  it("hashes leftover plaintext on read and rewrites the file", () => {
    const path = join(mkdtempSync(join(tmpdir(), "mba-sess-")), "sessions.json");
    const plaintext = "mba.legacy-plain";
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        sessions: [
          {
            id: "s1",
            modelId: "deepseek_test",
            harness: "cursor",
            projectRoot: "/tmp/proj",
            token: plaintext,
            createdAt: "2026-09-09T00:00:00.000Z",
          },
        ],
      }) + "\n",
      "utf8",
    );
    const rows = readSessions(path);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tokenHash).toBe(hashToken(plaintext));
    const disk = readFileSync(path, "utf8");
    expect(disk).not.toContain(plaintext);
    expect(disk).not.toMatch(/"token"/);
    const v = authorizeChat(rows, `Bearer ${plaintext}`, "deepseek_test");
    expect(v.ok).toBe(true);
  });

  it("keeps a second harness as its own session", () => {
    const a = session({ modelId: "deepseek_test", token: "mba.a", harness: "cursor" });
    const b = session({ modelId: "deepseek_test", token: "mba.b", harness: "cline", id: "s2" });
    expect(upsertSession([a], b)).toHaveLength(2);
  });

  it("revokes one model and can clear all", () => {
    const rows = [
      session({ modelId: "a", token: "t1", id: "1" }),
      session({ modelId: "b", token: "t2", id: "2", harness: "cline" }),
    ];
    expect(revokeSessions(rows, { modelId: "a" }).map((s) => s.modelId)).toEqual(["b"]);
    expect(revokeSessions(rows, {})).toEqual([]);
  });

  it("parses a Bearer token", () => {
    expect(bearerToken("Bearer mba.abc")).toBe("mba.abc");
    expect(bearerToken("bearer mba.abc")).toBe("mba.abc");
    expect(bearerToken(undefined)).toBeUndefined();
  });
});

describe("authorizeChat", () => {
  it("is open when no sessions exist", () => {
    const v = authorizeChat([], undefined, "deepseek_test");
    expect(v).toEqual({ ok: true, stripAuth: false });
  });

  it("rejects a missing or unknown token once paired", () => {
    const token = mintToken();
    const rows = [session({ modelId: "deepseek_test", token })];
    expect(authorizeChat(rows, undefined, "deepseek_test").ok).toBe(false);
    expect(authorizeChat(rows, "Bearer nope", "deepseek_test").ok).toBe(false);
  });

  it("accepts the paired token for that model and strips it", () => {
    const token = mintToken();
    const rows = [session({ modelId: "deepseek_test", token })];
    const v = authorizeChat(rows, `Bearer ${token}`, "deepseek_test");
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.stripAuth).toBe(true);
      expect(v.session?.modelId).toBe("deepseek_test");
      expect(v.session).not.toHaveProperty("token");
    }
  });

  it("rejects a token for a different model", () => {
    const token = mintToken();
    const rows = [session({ modelId: "deepseek_test", token })];
    const v = authorizeChat(rows, `Bearer ${token}`, "qwen");
    expect(v).toMatchObject({ ok: false, error: "paired token does not match this model" });
  });
});
