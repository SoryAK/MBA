import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import {
  readRegistry,
  removeByPid,
  resolveUpstream,
  upsertEntry,
  writeRegistry,
  type UpstreamEntry,
} from "./upstream-registry.js";

const T0 = "2026-08-24T10:00:00.000Z";
const T1 = "2026-08-24T11:00:00.000Z";
const T2 = "2026-08-24T12:00:00.000Z";

function entry(over: Partial<UpstreamEntry> & Pick<UpstreamEntry, "id" | "modelFile" | "port" | "pid">): UpstreamEntry {
  return {
    serverType: "llama.cpp",
    startedAt: T0,
    ...over,
  };
}

const QWEN = "/home/skaba/models/adapters/qwen/qwen3.8-27b/Qwen3.8-27B-Q6_K.gguf";
const LLAMA = "/home/skaba/models/adapters/llama/llama3-8b/Llama-3-8B-Q4_K_M.gguf";

describe("upstream registry (ADR-0097 Phase 1)", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mba-upstreams-"));
    path = join(dir, "upstreams.json");
  });

  describe("readRegistry", () => {
    it("returns [] when the file does not exist", () => {
      expect(readRegistry(path)).toEqual([]);
    });

    it("returns [] (never throws) on corrupt JSON", () => {
      writeFileSync(path, "{ not json", "utf8");
      expect(readRegistry(path)).toEqual([]);
    });

    it("returns [] on a valid-JSON wrong-shape file", () => {
      writeFileSync(path, JSON.stringify({ upstreams: "nope" }), "utf8");
      expect(readRegistry(path)).toEqual([]);
    });

    it("round-trips entries through writeRegistry", () => {
      const e = entry({ id: "llama-cpp-8080", modelFile: QWEN, port: 8080, pid: 111, startedAt: T1 });
      writeRegistry(path, [e]);
      expect(readRegistry(path)).toEqual([e]);
    });

    it("writeRegistry is atomic (no torn file left behind)", () => {
      writeRegistry(path, [entry({ id: "a", modelFile: QWEN, port: 8080, pid: 1 })]);
      writeRegistry(path, []);
      expect(readRegistry(path)).toEqual([]);
      // The on-disk file must be valid JSON after the overwrite.
      expect(() => JSON.parse(readFileSync(path, "utf8"))).not.toThrow();
    });
  });

  describe("upsertEntry (merge, never clobber)", () => {
    it("appends a new entry", () => {
      const a = entry({ id: "a", modelFile: QWEN, port: 8080, pid: 1 });
      const b = entry({ id: "b", modelFile: LLAMA, port: 8081, pid: 2 });
      expect(upsertEntry([a], b)).toEqual([a, b]);
    });

    it("replaces an existing entry by id, keeping the others", () => {
      const a = entry({ id: "a", modelFile: QWEN, port: 8080, pid: 1, startedAt: T0 });
      const b = entry({ id: "b", modelFile: LLAMA, port: 8081, pid: 2 });
      const a2 = entry({ id: "a", modelFile: QWEN, port: 8080, pid: 99, startedAt: T2 });
      expect(upsertEntry([a, b], a2)).toEqual([a2, b]);
    });
  });

  describe("removeByPid", () => {
    it("removes only the entry with the matching pid", () => {
      const a = entry({ id: "a", modelFile: QWEN, port: 8080, pid: 1 });
      const b = entry({ id: "b", modelFile: LLAMA, port: 8081, pid: 2 });
      expect(removeByPid([a, b], 2)).toEqual([a]);
    });

    it("is a no-op when no pid matches", () => {
      const a = entry({ id: "a", modelFile: QWEN, port: 8080, pid: 1 });
      expect(removeByPid([a], 42)).toEqual([a]);
    });
  });

  describe("resolveUpstream (healthiest + most-recently-booted wins)", () => {
    it("returns null when no entry matches the model", () => {
      const a = entry({ id: "a", modelFile: QWEN, port: 8080, pid: 1 });
      expect(resolveUpstream([a], LLAMA)).toBeNull();
    });

    it("matches by basename when the paths differ in prefix", () => {
      const a = entry({ id: "a", modelFile: "/other/root/Qwen3.8-27B-Q6_K.gguf", port: 8080, pid: 1 });
      expect(resolveUpstream([a], QWEN)?.id).toBe("a");
    });

    it("picks the only match", () => {
      const a = entry({ id: "a", modelFile: QWEN, port: 8080, pid: 1 });
      const b = entry({ id: "b", modelFile: LLAMA, port: 8081, pid: 2 });
      expect(resolveUpstream([a, b], QWEN)?.id).toBe("a");
    });

    it("health beats recency: a healthy older entry wins over an unhealthy newer one", () => {
      const old = entry({ id: "old", modelFile: QWEN, port: 8080, pid: 1, startedAt: T0 });
      const new_ = entry({ id: "new", modelFile: QWEN, port: 8081, pid: 2, startedAt: T2 });
      const healthy = new Set<string>(["old"]);
      expect(resolveUpstream([new_, old], QWEN, healthy)?.id).toBe("old");
    });

    it("drops unhealthy entries entirely when a healthy one exists", () => {
      const bad = entry({ id: "bad", modelFile: QWEN, port: 8080, pid: 1, startedAt: T2 });
      const good = entry({ id: "good", modelFile: QWEN, port: 8081, pid: 2, startedAt: T0 });
      expect(resolveUpstream([bad, good], QWEN, new Set(["good"]))?.id).toBe("good");
    });

    it("returns null when every matching entry is unhealthy", () => {
      const bad = entry({ id: "bad", modelFile: QWEN, port: 8080, pid: 1 });
      expect(resolveUpstream([bad], QWEN, new Set<string>())).toBeNull();
    });

    it("among healthy entries, most-recently-booted wins", () => {
      const a = entry({ id: "a", modelFile: QWEN, port: 8080, pid: 1, startedAt: T0 });
      const b = entry({ id: "b", modelFile: QWEN, port: 8081, pid: 2, startedAt: T1 });
      const healthy = new Set(["a", "b"]);
      expect(resolveUpstream([a, b], QWEN, healthy)?.id).toBe("b");
    });

    it("tie on recency → lowest port wins", () => {
      const hi = entry({ id: "hi", modelFile: QWEN, port: 9090, pid: 1, startedAt: T1 });
      const lo = entry({ id: "lo", modelFile: QWEN, port: 8080, pid: 2, startedAt: T1 });
      const healthy = new Set(["hi", "lo"]);
      expect(resolveUpstream([hi, lo], QWEN, healthy)?.id).toBe("lo");
    });

    it("without a health set, recency decides (no probing happened)", () => {
      const a = entry({ id: "a", modelFile: QWEN, port: 8080, pid: 1, startedAt: T0 });
      const b = entry({ id: "b", modelFile: QWEN, port: 8081, pid: 2, startedAt: T2 });
      expect(resolveUpstream([a, b], QWEN)?.id).toBe("b");
    });
  });
});
