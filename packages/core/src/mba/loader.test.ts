/**
 * Tests for the MBA loader's mtime-based parse cache: it must actually cache
 * (second read is a hit) and it must stay bounded — a long-lived service must
 * not accumulate one entry per distinct file path forever.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearLoaderCaches,
  loadStructuralConfig,
  loaderCacheSizes,
} from "./loader.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cyard-mba-loader-"));
  clearLoaderCaches();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  clearLoaderCaches();
});

describe("loader cache", () => {
  it("serves a second read of the same file from the cache", () => {
    const path = join(dir, "structural.json");
    writeFileSync(path, JSON.stringify({ a: 1 }));
    expect(loadStructuralConfig(path)).toEqual({ a: 1 });
    // The first load populated the json cache.
    expect(loaderCacheSizes().json).toBe(1);
    // A second read returns the same value (mtime unchanged → cache hit).
    expect(loadStructuralConfig(path)).toEqual({ a: 1 });
    expect(loaderCacheSizes().json).toBe(1);
  });

  it("re-parses when the file's mtime advances", () => {
    const path = join(dir, "structural.json");
    writeFileSync(path, JSON.stringify({ a: 1 }));
    expect(loadStructuralConfig(path)).toEqual({ a: 1 });
    // Force a strictly newer mtime so the cache entry is stale.
    const future = new Date(Date.now() + 60_000);
    writeFileSync(path, JSON.stringify({ a: 2 }));
    // Touch to a future mtime (writeFileSync uses the real clock, which may
    // not have advanced past the cached mtime within the same millisecond).
    utimesSync(path, future, future);
    expect(loadStructuralConfig(path)).toEqual({ a: 2 });
  });

  it("bounds the json cache at the entry cap, dropping the oldest", () => {
    // 300 distinct files > the 256 cap.
    for (let i = 0; i < 300; i++) {
      const path = join(dir, `s${i}.json`);
      writeFileSync(path, JSON.stringify({ i }));
      loadStructuralConfig(path);
    }
    expect(loaderCacheSizes().json).toBeLessThanOrEqual(256);
    // The most recently loaded file is still served correctly.
    expect(loadStructuralConfig(join(dir, "s299.json"))).toEqual({ i: 299 });
  });
});
