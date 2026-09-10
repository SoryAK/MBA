import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  defaultStateDir,
  defaultModelStoreRoot,
  ensureDir,
  normalizePlatform,
  type PathContext,
} from "./paths.js";

function ctx(over: Partial<PathContext> = {}): PathContext {
  return {
    platform: "linux",
    env: {},
    homedir: "/home/user",
    ...over,
  };
}

/**
 * Split a path into segments on BOTH separators. `path.join` uses the host
 * OS's separator, so a Windows-shaped path resolved on Linux comes back with
 * `/`. Comparing segment arrays (rather than the literal string) makes the
 * Windows assertions honest on every host.
 */
function segments(p: string): string[] {
  return p.split(/[\\/]+/).filter((s) => s.length > 0);
}

describe("normalizePlatform", () => {
  it("maps the known platforms", () => {
    expect(normalizePlatform("darwin")).toBe("darwin");
    expect(normalizePlatform("win32")).toBe("win32");
    expect(normalizePlatform("linux")).toBe("linux");
  });
  it("buckets anything else as other", () => {
    expect(normalizePlatform("freebsd")).toBe("other");
    expect(normalizePlatform("aix")).toBe("other");
  });
});

describe("defaultStateDir", () => {
  it("linux: ~/.config/mba by default", () => {
    expect(defaultStateDir(ctx())).toBe("/home/user/.config/mba");
  });
  it("linux: honors XDG_CONFIG_HOME", () => {
    expect(defaultStateDir(ctx({ env: { XDG_CONFIG_HOME: "/xdg/cfg" } }))).toBe(
      "/xdg/cfg/mba",
    );
  });
  it("linux: empty XDG_CONFIG_HOME falls back to ~/.config", () => {
    expect(defaultStateDir(ctx({ env: { XDG_CONFIG_HOME: "" } }))).toBe(
      "/home/user/.config/mba",
    );
  });
  it("macos: ~/Library/Application Support/mba", () => {
    expect(defaultStateDir(ctx({ platform: "darwin" }))).toBe(
      "/home/user/Library/Application Support/mba",
    );
  });
  it("windows: %APPDATA%/mba", () => {
    expect(
      segments(defaultStateDir(ctx({ platform: "win32", env: { APPDATA: "C:\\Users\\u\\AppData\\Roaming" } }))),
    ).toEqual(["C:", "Users", "u", "AppData", "Roaming", "mba"]);
  });
  it("windows: throws when APPDATA is unset", () => {
    expect(() => defaultStateDir(ctx({ platform: "win32", env: {} }))).toThrow(/APPDATA/);
  });
  it("other: falls back to ~/.config/mba", () => {
    expect(defaultStateDir(ctx({ platform: "other" }))).toBe("/home/user/.config/mba");
  });
});

describe("defaultModelStoreRoot", () => {
  it("linux: ~/.local/share/mba/model_hub/adapters by default", () => {
    expect(defaultModelStoreRoot(ctx())).toBe(
      "/home/user/.local/share/mba/model_hub/adapters",
    );
  });
  it("linux: honors XDG_DATA_HOME", () => {
    expect(defaultModelStoreRoot(ctx({ env: { XDG_DATA_HOME: "/xdg/data" } }))).toBe(
      "/xdg/data/mba/model_hub/adapters",
    );
  });
  it("linux: empty XDG_DATA_HOME falls back to ~/.local/share", () => {
    expect(defaultModelStoreRoot(ctx({ env: { XDG_DATA_HOME: "" } }))).toBe(
      "/home/user/.local/share/mba/model_hub/adapters",
    );
  });
  it("macos: shares the Application Support base with state", () => {
    expect(defaultModelStoreRoot(ctx({ platform: "darwin" }))).toBe(
      "/home/user/Library/Application Support/mba/model_hub/adapters",
    );
  });
  it("windows: %LOCALAPPDATA%/mba/model_hub/adapters", () => {
    expect(
      segments(
        defaultModelStoreRoot(
          ctx({ platform: "win32", env: { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" } }),
        ),
      ),
    ).toEqual(["C:", "Users", "u", "AppData", "Local", "mba", "model_hub", "adapters"]);
  });
  it("windows: throws when LOCALAPPDATA is unset", () => {
    expect(() => defaultModelStoreRoot(ctx({ platform: "win32", env: {} }))).toThrow(
      /LOCALAPPDATA/,
    );
  });
  it("other: falls back to ~/.local/share/mba/model_hub/adapters", () => {
    expect(defaultModelStoreRoot(ctx({ platform: "other" }))).toBe(
      "/home/user/.local/share/mba/model_hub/adapters",
    );
  });
});

describe("ensureDir", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mba-paths-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("creates a missing nested directory", () => {
    const target = join(root, "a", "b", "c");
    ensureDir(target);
    expect(existsSync(target)).toBe(true);
  });
  it("is idempotent on an existing directory", () => {
    const target = join(root, "exists");
    ensureDir(target);
    expect(() => ensureDir(target)).not.toThrow();
  });
});
