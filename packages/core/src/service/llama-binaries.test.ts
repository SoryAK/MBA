import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultStorePaths } from "./config-store.js";
import {
  binaryMismatchWarning,
  gpuVendors,
  inspectLlamaBackend,
  listLlamaServers,
  readLlamaServerChoice,
  recommendBackend,
  selectLlamaServer,
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
