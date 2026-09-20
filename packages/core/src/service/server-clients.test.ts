import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeEach } from "vitest";
import { createMbaServiceApp } from "./server.js";
import { defaultStorePaths } from "./config-store.js";
import { readOperatorClients } from "./operator-clients.js";

describe("GET/POST /clients", () => {
  let paths: ReturnType<typeof defaultStorePaths>;

  beforeEach(() => {
    paths = defaultStorePaths(mkdtempSync(join(tmpdir(), "mba-svc-clients-")));
  });

  it("GET /clients lists built-in harnesses", async () => {
    const app = createMbaServiceApp({ paths });
    const res = await app.request("/clients");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { clients: Array<{ name: string; source: string }> };
    expect(body.clients.some((c) => c.name === "cursor" && c.source === "built-in")).toBe(true);
    expect(body.clients.every((c) => c.source === "built-in")).toBe(true);
  });

  it("POST /clients adds an operator row the CLI used to write locally", async () => {
    const app = createMbaServiceApp({ paths });
    const res = await app.request("/clients", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Windsurf", envelope: ".windsurf/mba.md", ide: "vscode" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      name: "windsurf",
      envelope: ".windsurf/mba.md",
      ide: "vscode",
      updated: false,
    });
    expect(readOperatorClients(paths.clientsPath)).toEqual([
      { name: "windsurf", envelope: ".windsurf/mba.md", ide: "vscode" },
    ]);

    const listed = await app.request("/clients");
    const catalog = (await listed.json()) as { clients: Array<{ name: string; source: string }> };
    expect(catalog.clients.find((c) => c.name === "windsurf")).toEqual({
      name: "windsurf",
      envelope: ".windsurf/mba.md",
      source: "added",
      ide: "vscode",
    });
  });

  it("POST /clients rejects a built-in name", async () => {
    const app = createMbaServiceApp({ paths });
    const res = await app.request("/clients", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "cursor", envelope: ".cursor/mba.md" }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringMatching(/built-in/) });
  });

  it("POST /clients/remove drops an added row and refuses a built-in", async () => {
    const app = createMbaServiceApp({ paths });
    await app.request("/clients", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "windsurf", envelope: ".windsurf/mba.md" }),
    });
    const gone = await app.request("/clients/remove", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "windsurf" }),
    });
    expect(gone.status).toBe(200);
    expect(await gone.json()).toEqual({ name: "windsurf", removed: true });
    expect(readOperatorClients(paths.clientsPath)).toEqual([]);

    const builtin = await app.request("/clients/remove", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "cursor" }),
    });
    expect(builtin.status).toBe(400);
  });
});
