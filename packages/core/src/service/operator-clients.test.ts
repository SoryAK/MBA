import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  addOperatorClient,
  isSafeEnvelopePath,
  normalizeClientName,
  readOperatorClients,
  removeOperatorClient,
} from "./operator-clients.js";

describe("operator-clients", () => {
  it("rejects reserved names and unsafe envelopes", () => {
    expect(normalizeClientName("cursor")).toBeUndefined();
    expect(normalizeClientName("Claude")).toBeUndefined();
    expect(normalizeClientName("Windsurf")).toBe("windsurf");
    expect(isSafeEnvelopePath("CLAUDE.md")).toBe(false);
    expect(isSafeEnvelopePath("../secret")).toBe(false);
    expect(isSafeEnvelopePath(".windsurf/mba.md")).toBe(true);
  });

  it("adds, updates, and removes a client", () => {
    const path = join(mkdtempSync(join(tmpdir(), "mba-clients-")), "clients.json");
    const added = addOperatorClient(path, {
      name: "Windsurf",
      envelope: ".windsurf/mba.md",
      ide: "vscode",
    });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(added.client).toEqual({
      name: "windsurf",
      envelope: ".windsurf/mba.md",
      ide: "vscode",
    });
    expect(readOperatorClients(path)).toHaveLength(1);

    const again = addOperatorClient(path, {
      name: "windsurf",
      envelope: ".windsurf/rules/mba.md",
    });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.updated).toBe(true);
    expect(again.client.envelope).toBe(".windsurf/rules/mba.md");

    const clash = addOperatorClient(path, {
      name: "zed",
      envelope: ".windsurf/rules/mba.md",
    });
    expect(clash.ok).toBe(false);

    const gone = removeOperatorClient(path, "windsurf");
    expect(gone).toEqual({ ok: true, removed: true });
    expect(readOperatorClients(path)).toEqual([]);
  });

  it("refuses to remove a built-in name", () => {
    const path = join(mkdtempSync(join(tmpdir(), "mba-clients-")), "clients.json");
    expect(removeOperatorClient(path, "cursor")).toMatchObject({ ok: false });
  });
});
