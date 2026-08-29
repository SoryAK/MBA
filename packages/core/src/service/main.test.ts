import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveVsCodeLmConfigPath } from "./vscode-lm-config.js";

/**
 * Split a path into segments on BOTH separators. `path.join` uses the host
 * OS's separator, so a Windows-shaped path resolved on Linux comes back with
 * `/`. Comparing segment arrays (rather than the literal string) makes the
 * assertions honest on every host.
 */
function segments(p: string): string[] {
  return p.split(/[\\/]+/).filter((s) => s.length > 0);
}

describe("resolveVsCodeLmConfigPath", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "mba-lm-config-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function userDir(): string {
    return join(home, ".config", "Code", "User");
  }

  function writeSettings(content: string): void {
    mkdirSync(userDir(), { recursive: true });
    writeFileSync(join(userDir(), "settings.json"), content, "utf8");
  }

  it("uses the active profile from workbench.profile.default", () => {
    writeSettings(JSON.stringify({ "workbench.profile.default": "abc123" }));
    expect(segments(resolveVsCodeLmConfigPath(home))).toEqual([
      ...segments(home),
      ".config",
      "Code",
      "User",
      "profiles",
      "abc123",
      "chatLanguageModels.json",
    ]);
  });

  it("falls back to the no-profile location when settings.json is missing", () => {
    expect(segments(resolveVsCodeLmConfigPath(home))).toEqual([
      ...segments(home),
      ".config",
      "Code",
      "User",
      "chatLanguageModels.json",
    ]);
  });

  it("falls back when settings.json has no workbench.profile.default key", () => {
    writeSettings(JSON.stringify({ "editor.fontSize": 14 }));
    expect(segments(resolveVsCodeLmConfigPath(home))).toEqual([
      ...segments(home),
      ".config",
      "Code",
      "User",
      "chatLanguageModels.json",
    ]);
  });

  it("falls back when the profile value is not a non-empty string", () => {
    writeSettings(JSON.stringify({ "workbench.profile.default": 42 }));
    expect(segments(resolveVsCodeLmConfigPath(home))).toEqual([
      ...segments(home),
      ".config",
      "Code",
      "User",
      "chatLanguageModels.json",
    ]);
  });

  it("falls back when settings.json is malformed JSON", () => {
    writeSettings("{ not valid json");
    expect(segments(resolveVsCodeLmConfigPath(home))).toEqual([
      ...segments(home),
      ".config",
      "Code",
      "User",
      "chatLanguageModels.json",
    ]);
  });
});
