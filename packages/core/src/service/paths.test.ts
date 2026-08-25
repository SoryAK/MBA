import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  defaultStateDir,
  defaultModelStoreRoot,
  legacyStateDir,
  legacyModelStoreRoot,
  ensureDir,
  normalizePlatform,
  planMigration,
  executeMigration,
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

describe("legacy locations (migration source only)", () => {
  it("state: ~/.mba", () => {
    expect(legacyStateDir(ctx())).toBe("/home/user/.mba");
  });
  it("store: ~/models/adapters", () => {
    expect(legacyModelStoreRoot(ctx())).toBe("/home/user/models/adapters");
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

describe("planMigration (pure decision table)", () => {
  it("moves when source exists and destination is absent", () => {
    expect(planMigration(true, false, true, "/old", "/new")).toEqual({
      status: "moved",
      from: "/old",
      to: "/new",
    });
  });
  it("moves when source exists and destination is present but empty", () => {
    expect(planMigration(true, true, true, "/old", "/new")).toEqual({
      status: "moved",
      from: "/old",
      to: "/new",
    });
  });
  it("skips when the source is missing (fresh install / already migrated)", () => {
    expect(planMigration(false, false, true, "/old", "/new")).toEqual({
      status: "skipped-missing-source",
      from: "/old",
      to: "/new",
    });
  });
  it("refuses when the destination exists and is non-empty", () => {
    expect(planMigration(true, true, false, "/old", "/new")).toEqual({
      status: "skipped-destination-exists",
      from: "/old",
      to: "/new",
    });
  });
});

describe("executeMigration (real filesystem)", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mba-migrate-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** Probe helpers mirroring what the CLI does before calling executeMigration. */
  function probe(dir: string): { exists: boolean; empty: boolean } {
    const exists = existsSync(dir);
    const empty = exists && readdirSync(dir).length === 0;
    return { exists, empty };
  }

  it("moves a populated source into an absent destination", () => {
    const from = join(root, "old");
    const to = join(root, "new");
    ensureDir(from);
    writeFileSync(join(from, "a.txt"), "hello");
    const p = probe(from);
    const d = probe(to);
    const result = executeMigration(from, to, p.exists, d.exists, d.empty);
    expect(result.status).toBe("moved");
    expect(existsSync(join(to, "a.txt"))).toBe(true);
    expect(existsSync(from)).toBe(false);
  });

  it("creates the destination's missing parents (nested new home)", () => {
    const from = join(root, "old");
    // Destination sits under parents that do not exist yet — the real store
    // case (…/mba/model_hub/adapters on a fresh install).
    const to = join(root, "a", "b", "c", "new");
    ensureDir(from);
    writeFileSync(join(from, "a.txt"), "hello");
    const p = probe(from);
    const d = probe(to);
    const result = executeMigration(from, to, p.exists, d.exists, d.empty);
    expect(result.status).toBe("moved");
    expect(existsSync(join(to, "a.txt"))).toBe(true);
    expect(existsSync(from)).toBe(false);
  });

  it("is idempotent — a second run finds no source and skips", () => {
    const from = join(root, "old");
    const to = join(root, "new");
    ensureDir(from);
    writeFileSync(join(from, "a.txt"), "hello");
    executeMigration(from, to, probe(from).exists, probe(to).exists, probe(to).empty);
    // Second run: source is gone now.
    const p = probe(from);
    const d = probe(to);
    const result = executeMigration(from, to, p.exists, d.exists, d.empty);
    expect(result.status).toBe("skipped-missing-source");
    // Data still intact at the destination.
    expect(existsSync(join(to, "a.txt"))).toBe(true);
  });

  it("refuses to overwrite a non-empty destination", () => {
    const from = join(root, "old");
    const to = join(root, "new");
    ensureDir(from);
    writeFileSync(join(from, "a.txt"), "from");
    ensureDir(to);
    writeFileSync(join(to, "b.txt"), "to");
    const p = probe(from);
    const d = probe(to);
    const result = executeMigration(from, to, p.exists, d.exists, d.empty);
    expect(result.status).toBe("skipped-destination-exists");
    // Source untouched, destination untouched.
    expect(existsSync(join(from, "a.txt"))).toBe(true);
    expect(existsSync(join(to, "b.txt"))).toBe(true);
    expect(existsSync(join(to, "a.txt"))).toBe(false);
  });
});
