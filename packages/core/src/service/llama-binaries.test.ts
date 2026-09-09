import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultStorePaths } from "./config-store.js";
import {
  binaryMismatchWarning,
  gpuVendors,
  inspectLlamaBackend,
  ignoreLlamaServer,
  isBundledOllamaLlamaServer,
  isLlamaServerCatalogStale,
  listLlamaServers,
  llamaServerCatalogTtlMs,
  LLAMA_SERVER_CATALOG_TTL_MS,
  nicknameLlamaServer,
  readLlamaServerCatalog,
  readLlamaServerChoice,
  recommendBackend,
  refreshLlamaServerCatalog,
  restoreLlamaServer,
  selectLlamaServer,
  useLlamaServer,
  startLlamaServerCatalogRefresh,
  writeLlamaServerChoice,
  type LlamaServerBinary,
} from "./llama-binaries.js";
import type { MachineInfo } from "./machine-info.js";

function nvidiaMachine(): MachineInfo {
  return {
    os: "linux",
    cpuCores: 16,
    totalRamBytes: 64 * 1024 ** 3,
    gpus: [{ name: "NVIDIA GeForce RTX 5090", vramBytes: 32 * 1024 ** 3 }],
  };
}

function amdMachine(): MachineInfo {
  return {
    os: "linux",
    cpuCores: 16,
    totalRamBytes: 64 * 1024 ** 3,
    gpus: [{ name: "Advanced Micro Devices, Inc. [AMD/ATI] Strix Halo" }],
  };
}

describe("inspectLlamaBackend", () => {
  it("reads sibling ggml libs", () => {
    const exists = (p: string) => p.endsWith("libggml-cuda.so.0");
    expect(inspectLlamaBackend("/opt/llama/llama-server", exists)).toBe("cuda");
  });

  it("falls back to cpu when no backend lib is next to the binary", () => {
    expect(inspectLlamaBackend("/opt/llama/llama-server", () => false)).toBe("cpu");
  });
});

describe("gpuVendors / mismatch", () => {
  it("tags NVIDIA and AMD from gpu names", () => {
    expect([...gpuVendors(nvidiaMachine())]).toEqual(["nvidia"]);
    expect([...gpuVendors(amdMachine())]).toEqual(["amd"]);
  });

  it("warns when the backend does not match the detected vendor", () => {
    const nvidia = gpuVendors(nvidiaMachine());
    expect(binaryMismatchWarning("hip", nvidia)).toMatch(/HIP build/);
    expect(binaryMismatchWarning("cuda", nvidia)).toBeUndefined();
    expect(binaryMismatchWarning("cpu", nvidia)).toMatch(/CPU-only/);
  });

  it("does not warn on a dual-vendor box", () => {
    const both = gpuVendors({
      os: "linux",
      cpuCores: 8,
      totalRamBytes: 1,
      gpus: [{ name: "NVIDIA RTX 4070" }, { name: "AMD Radeon 8060S" }],
    });
    expect(binaryMismatchWarning("cuda", both)).toBeUndefined();
    expect(binaryMismatchWarning("hip", both)).toBeUndefined();
  });
});

describe("listLlamaServers / selectLlamaServer", () => {
  let root: string;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  function plant(backend: "cuda" | "hip" | "vulkan", rel: string): string {
    const dir = join(root, rel);
    mkdirSync(dir, { recursive: true });
    const bin = join(dir, "llama-server");
    writeFileSync(bin, "");
    const lib =
      backend === "cuda"
        ? "libggml-cuda.so.0"
        : backend === "hip"
          ? "libggml-hip.so.0"
          : "libggml-vulkan.so.0";
    writeFileSync(join(dir, lib), "");
    return bin;
  }

  it("lists known trees and tags backends", () => {
    root = mkdtempSync(join(tmpdir(), "mba-llama-bin-"));
    const cuda = plant("cuda", join("llama-cuda", "build", "bin"));
    const hip = plant("hip", join("llama.cpp", "build", "bin"));
    const catalog = listLlamaServers({ homedir: root, env: { PATH: "" } });
    expect(catalog.map((b) => b.backend).sort()).toEqual(["cuda", "hip"]);
    expect(catalog.some((b) => b.path === cuda)).toBe(true);
    expect(catalog.some((b) => b.path === hip)).toBe(true);
  });

  it("uses last pick over MBA_LLAMA_SERVER_BIN so a boot switch sticks", () => {
    root = mkdtempSync(join(tmpdir(), "mba-llama-bin-"));
    const cuda = plant("cuda", join("llama-cuda", "build", "bin"));
    const hip = plant("hip", join("llama.cpp", "build", "bin"));
    const picked = selectLlamaServer({
      lastPath: hip,
      machineInfo: nvidiaMachine(),
      scan: { homedir: root, env: { PATH: "", MBA_LLAMA_SERVER_BIN: cuda } },
    });
    expect(picked.selected?.path).toBe(hip);
    expect(picked.warning).toMatch(/HIP build/);
    expect(picked.pinned).toBe(true);
  });

  it("uses last pick when env is unset, even if another backend is recommended", () => {
    root = mkdtempSync(join(tmpdir(), "mba-llama-bin-"));
    plant("cuda", join("llama-cuda", "build", "bin"));
    const hip = plant("hip", join("llama.cpp", "build", "bin"));
    const picked = selectLlamaServer({
      lastPath: hip,
      machineInfo: nvidiaMachine(),
      scan: { homedir: root, env: { PATH: "" } },
    });
    expect(picked.selected?.path).toBe(hip);
    expect(picked.warning).toMatch(/HIP build/);
    expect(picked.recommended).toBe("cuda");
  });

  it("falls back to MBA_LLAMA_SERVER_BIN when nothing has been remembered", () => {
    root = mkdtempSync(join(tmpdir(), "mba-llama-bin-"));
    const cuda = plant("cuda", join("llama-cuda", "build", "bin"));
    plant("hip", join("llama.cpp", "build", "bin"));
    const picked = selectLlamaServer({
      machineInfo: nvidiaMachine(),
      scan: { homedir: root, env: { PATH: "", MBA_LLAMA_SERVER_BIN: cuda } },
    });
    expect(picked.selected?.path).toBe(cuda);
    expect(picked.warning).toBeUndefined();
  });

  it("recommends CUDA when NVIDIA is present and nothing was remembered", () => {
    root = mkdtempSync(join(tmpdir(), "mba-llama-bin-"));
    const cuda = plant("cuda", join("llama-cuda", "build", "bin"));
    plant("hip", join("llama.cpp", "build", "bin"));
    const picked = selectLlamaServer({
      machineInfo: nvidiaMachine(),
      scan: { homedir: root, env: { PATH: "" } },
    });
    expect(picked.recommended).toBe("cuda");
    expect(picked.selected?.path).toBe(cuda);
  });

  it("name-walk finds builds outside the known trees", () => {
    root = mkdtempSync(join(tmpdir(), "mba-llama-bin-"));
    const hidden = plant("hip", join(".unsloth", "llama.cpp", "build", "bin"));
    const vendor = plant("vulkan", join("src", "vendor", "llama.cpp", "build", "bin"));
    const missed = listLlamaServers({ homedir: root, env: { PATH: "" } });
    expect(missed.map((b) => b.path)).not.toContain(hidden);
    expect(missed.map((b) => b.path)).not.toContain(vendor);
    const catalog = listLlamaServers({ homedir: root, env: { PATH: "" }, discover: true });
    expect(catalog.some((b) => b.path === hidden)).toBe(true);
    expect(catalog.some((b) => b.path === vendor)).toBe(true);
  });

  it("name-walk skips node_modules and ollama-bundled copies", () => {
    root = mkdtempSync(join(tmpdir(), "mba-llama-bin-"));
    const keep = plant("cuda", join(".unsloth", "llama.cpp", "build", "bin"));
    const nm = plant("hip", join("proj", "node_modules", "llama.cpp", "build", "bin"));
    const ollamaRoot = join(root, "usr", "local");
    const ollama = plant("cuda", join("usr", "local", "lib", "ollama"));
    const catalog = listLlamaServers({
      homedir: root,
      env: { PATH: "" },
      discover: true,
      extraRoots: [ollamaRoot],
    });
    expect(catalog.some((b) => b.path === keep)).toBe(true);
    expect(catalog.some((b) => b.path === nm)).toBe(false);
    expect(catalog.some((b) => b.path === ollama)).toBe(false);
  });

  it("collapses a llama-server symlink onto the real binary", () => {
    root = mkdtempSync(join(tmpdir(), "mba-llama-bin-"));
    const real = plant("hip", join(".unsloth", "llama.cpp", "build", "bin"));
    const link = join(root, ".unsloth", "llama.cpp", "llama-server");
    symlinkSync(join("build", "bin", "llama-server"), link);
    const catalog = listLlamaServers({ homedir: root, env: { PATH: "" }, discover: true });
    expect(catalog.filter((b) => b.backend === "hip")).toHaveLength(1);
    expect(catalog[0]?.path).toBe(real);
  });
});

describe("isBundledOllamaLlamaServer", () => {
  it("matches ollama's vendored binary and not a coincidental name", () => {
    expect(isBundledOllamaLlamaServer("/usr/local/lib/ollama/llama-server")).toBe(true);
    expect(isBundledOllamaLlamaServer("/home/x/llama-ollama/build/bin/llama-server")).toBe(false);
  });
});

describe("llama-server catalog persistence", () => {
  it("refresh writes a scan and selectLlamaServer reuses it without walking", () => {
    const store = mkdtempSync(join(tmpdir(), "mba-llama-cat-"));
    const home = mkdtempSync(join(tmpdir(), "mba-llama-home-"));
    try {
      const paths = defaultStorePaths(store);
      const binDir = join(home, ".unsloth", "llama.cpp", "build", "bin");
      mkdirSync(binDir, { recursive: true });
      const bin = join(binDir, "llama-server");
      writeFileSync(bin, "");
      writeFileSync(join(binDir, "libggml-hip.so.0"), "");

      const scanned = refreshLlamaServerCatalog(paths, { homedir: home, env: { PATH: "" }, extraRoots: [] });
      expect(scanned.some((b) => b.path === bin)).toBe(true);
      expect(readLlamaServerCatalog(paths)?.entries.some((b) => b.path === bin)).toBe(true);

      const picked = selectLlamaServer({
        paths,
        scan: { homedir: home, env: { PATH: "" } },
      });
      expect(picked.catalog.some((b) => b.path === bin)).toBe(true);
    } finally {
      rmSync(store, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("refresh drops binaries that no longer exist", () => {
    const store = mkdtempSync(join(tmpdir(), "mba-llama-cat-"));
    const home = mkdtempSync(join(tmpdir(), "mba-llama-home-"));
    try {
      const paths = defaultStorePaths(store);
      const binDir = join(home, ".unsloth", "llama.cpp", "build", "bin");
      mkdirSync(binDir, { recursive: true });
      const bin = join(binDir, "llama-server");
      writeFileSync(bin, "");
      refreshLlamaServerCatalog(paths, { homedir: home, env: { PATH: "" }, extraRoots: [] });
      rmSync(bin, { force: true });
      const scanned = refreshLlamaServerCatalog(paths, { homedir: home, env: { PATH: "" }, extraRoots: [] });
      expect(scanned.some((b) => b.path === bin)).toBe(false);
      expect(readLlamaServerCatalog(paths)?.entries).toEqual([]);
    } finally {
      rmSync(store, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("treats TTL 0 as never stale and defaults to 15 minutes", () => {
    expect(llamaServerCatalogTtlMs({})).toBe(LLAMA_SERVER_CATALOG_TTL_MS);
    expect(llamaServerCatalogTtlMs({ MBA_LLAMA_CATALOG_TTL_MS: "0" })).toBe(0);
    const now = Date.parse("2026-09-08T12:00:00.000Z");
    expect(
      isLlamaServerCatalogStale(
        { scannedAt: "2000-01-01T00:00:00.000Z", entries: [], ignored: [] },
        now,
        0,
      ),
    ).toBe(false);
    expect(
      isLlamaServerCatalogStale(
        { scannedAt: "2026-09-08T11:50:00.000Z", entries: [], ignored: [] },
        now,
        15 * 60 * 1000,
      ),
    ).toBe(false);
    expect(
      isLlamaServerCatalogStale(
        { scannedAt: "2026-09-08T11:44:00.000Z", entries: [], ignored: [] },
        now,
        15 * 60 * 1000,
      ),
    ).toBe(true);
  });

  it("drops ghosts from a fresh catalog without walking for new trees", () => {
    const store = mkdtempSync(join(tmpdir(), "mba-llama-cat-"));
    const home = mkdtempSync(join(tmpdir(), "mba-llama-home-"));
    try {
      const paths = defaultStorePaths(store);
      const oldDir = join(home, ".unsloth", "llama.cpp", "build", "bin");
      mkdirSync(oldDir, { recursive: true });
      const oldBin = join(oldDir, "llama-server");
      writeFileSync(oldBin, "");
      refreshLlamaServerCatalog(paths, { homedir: home, env: { PATH: "" }, extraRoots: [] });
      rmSync(oldBin, { force: true });

      const newDir = join(home, "src", "vendor", "llama.cpp", "build", "bin");
      mkdirSync(newDir, { recursive: true });
      const newBin = join(newDir, "llama-server");
      writeFileSync(newBin, "");

      const picked = selectLlamaServer({
        paths,
        scan: { homedir: home, env: { PATH: "" }, extraRoots: [], now: Date.now(), ttlMs: 15 * 60 * 1000 },
      });
      expect(picked.catalog.some((b) => b.path === oldBin)).toBe(false);
      expect(picked.catalog.some((b) => b.path === newBin)).toBe(false);
      expect(readLlamaServerCatalog(paths)?.entries).toEqual([]);
    } finally {
      rmSync(store, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("walks again when the catalog is past the TTL so a new binary appears", () => {
    const store = mkdtempSync(join(tmpdir(), "mba-llama-cat-"));
    const home = mkdtempSync(join(tmpdir(), "mba-llama-home-"));
    try {
      const paths = defaultStorePaths(store);
      const firstDir = join(home, ".unsloth", "llama.cpp", "build", "bin");
      mkdirSync(firstDir, { recursive: true });
      writeFileSync(join(firstDir, "llama-server"), "");
      refreshLlamaServerCatalog(paths, { homedir: home, env: { PATH: "" }, extraRoots: [] });

      const newDir = join(home, "src", "vendor", "llama.cpp", "build", "bin");
      mkdirSync(newDir, { recursive: true });
      const newBin = join(newDir, "llama-server");
      writeFileSync(newBin, "");

      const scannedAt = readLlamaServerCatalog(paths)!.scannedAt;
      const later = Date.parse(scannedAt) + 15 * 60 * 1000;
      const picked = selectLlamaServer({
        paths,
        scan: {
          homedir: home,
          env: { PATH: "" },
          extraRoots: [],
          now: later,
          ttlMs: 15 * 60 * 1000,
        },
      });
      expect(picked.catalog.some((b) => b.path === newBin)).toBe(true);
    } finally {
      rmSync(store, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("rescans on an interval", () => {
    vi.useFakeTimers();
    const store = mkdtempSync(join(tmpdir(), "mba-llama-cat-"));
    const home = mkdtempSync(join(tmpdir(), "mba-llama-home-"));
    try {
      const paths = defaultStorePaths(store);
      refreshLlamaServerCatalog(paths, { homedir: home, env: { PATH: "" }, extraRoots: [] });
      const stop = startLlamaServerCatalogRefresh(paths, {
        ttlMs: 1000,
        scan: { homedir: home, env: { PATH: "" }, extraRoots: [] },
      });
      const newDir = join(home, ".unsloth", "llama.cpp", "build", "bin");
      mkdirSync(newDir, { recursive: true });
      const newBin = join(newDir, "llama-server");
      writeFileSync(newBin, "");
      vi.advanceTimersByTime(1000);
      expect(readLlamaServerCatalog(paths)?.entries.some((b) => b.path === newBin)).toBe(true);
      stop();
    } finally {
      vi.useRealTimers();
      rmSync(store, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("keeps a nickname across refresh and hides a removed build", () => {
    const store = mkdtempSync(join(tmpdir(), "mba-llama-cat-"));
    const home = mkdtempSync(join(tmpdir(), "mba-llama-home-"));
    try {
      const paths = defaultStorePaths(store);
      const binDir = join(home, ".unsloth", "llama.cpp", "build", "bin");
      mkdirSync(binDir, { recursive: true });
      const bin = join(binDir, "llama-server");
      writeFileSync(bin, "");
      writeFileSync(join(binDir, "libggml-hip.so.0"), "");
      const scan = { homedir: home, env: { PATH: "" }, extraRoots: [] as const };
      refreshLlamaServerCatalog(paths, scan);
      nicknameLlamaServer(paths, bin, "unsloth");
      refreshLlamaServerCatalog(paths, scan);
      expect(readLlamaServerCatalog(paths)?.entries.find((b) => b.path === bin)?.nickname).toBe("unsloth");

      ignoreLlamaServer(paths, bin);
      refreshLlamaServerCatalog(paths, scan);
      expect(readLlamaServerCatalog(paths)?.entries).toEqual([]);
      expect(readLlamaServerCatalog(paths)?.ignored[0]).toMatchObject({ path: bin, nickname: "unsloth" });
      const hidden = selectLlamaServer({ paths, scan });
      expect(hidden.catalog.some((b) => b.path === bin)).toBe(false);

      restoreLlamaServer(paths, bin);
      expect(readLlamaServerCatalog(paths)?.entries[0]).toMatchObject({ path: bin, nickname: "unsloth" });
      useLlamaServer(paths, bin);
      expect(readLlamaServerChoice(paths)?.path).toBe(bin);
      const pinned = selectLlamaServer({ paths, scan, lastPath: readLlamaServerChoice(paths)?.path });
      expect(pinned.pinned).toBe(true);
      expect(pinned.selected?.path).toBe(bin);
    } finally {
      rmSync(store, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("llama-server choice persistence", () => {
  it("round-trips the last binary", () => {
    const dir = mkdtempSync(join(tmpdir(), "mba-llama-choice-"));
    try {
      const paths = defaultStorePaths(dir);
      const choice: LlamaServerBinary = { path: "/opt/llama-cuda/llama-server", backend: "cuda" };
      writeLlamaServerChoice(paths, choice);
      expect(readLlamaServerChoice(paths)).toMatchObject(choice);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("recommendBackend", () => {
  it("picks hip on AMD when a hip binary exists", () => {
    expect(
      recommendBackend(gpuVendors(amdMachine()), [
        { path: "/hip", backend: "hip" },
        { path: "/vk", backend: "vulkan" },
      ]),
    ).toBe("hip");
  });
});
