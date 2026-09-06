import { describe, it, expect } from "vitest";
import {
  detectMachineInfo,
  machineInfoFromEnv,
  parseLspciGpus,
  parseMeminfo,
  parseNvidiaSmiCsv,
  parseNvidiaSmiXml,
  parseSystemProfiler,
  parseVramString,
  parseWindowsVideoControllers,
  resolveMachineInfo,
} from "./machine-info.js";

describe("detectMachineInfo", () => {
  it("returns cpuCores and totalRamBytes", () => {
    const info = detectMachineInfo();
    expect(info).toBeDefined();
    expect(typeof info!.cpuCores).toBe("number");
    expect(info!.cpuCores).toBeGreaterThan(0);
    expect(typeof info!.totalRamBytes).toBe("number");
    expect(info!.totalRamBytes).toBeGreaterThan(0);
    expect(info!.os).toBe(process.platform);
  });
});

describe("parseMeminfo", () => {
  it("extracts MemTotal in kB", () => {
    const text = "MemTotal:       16384000 kB\nMemFree:         8192000 kB\n";
    expect(parseMeminfo(text)).toEqual({ MemTotal: 16384000, MemFree: 8192000 });
  });

  it("returns an empty record for malformed input", () => {
    expect(parseMeminfo("not valid")).toEqual({});
  });
});

describe("parseNvidiaSmiXml", () => {
  it("extracts name and VRAM from nvidia-smi XML", () => {
    const xml = [
      '<?xml version="1.0" ?>',
      "<nvidia_smi_log>",
      "  <gpu>",
      "    <product_name>NVIDIA GeForce RTX 4090</product_name>",
      "    <fb_memory_usage>",
      "      <total>24564 MiB</total>",
      "    </fb_memory_usage>",
      "  </gpu>",
      "</nvidia_smi_log>",
    ].join("\n");
    const gpus = parseNvidiaSmiXml(xml);
    expect(gpus).toHaveLength(1);
    expect(gpus![0]).toEqual({
      name: "NVIDIA GeForce RTX 4090",
      vramBytes: 24564 * 1024 * 1024,
    });
  });

  it("returns undefined when no gpu blocks are present", () => {
    expect(parseNvidiaSmiXml("<root></root>")).toBeUndefined();
  });
});

describe("parseNvidiaSmiCsv", () => {
  it("extracts name and VRAM from a single GPU", () => {
    const gpus = parseNvidiaSmiCsv("Example NVIDIA GPU, 8192 MiB\n");
    expect(gpus).toEqual([{ name: "Example NVIDIA GPU", vramBytes: 8192 * 1024 * 1024 }]);
  });

  it("extracts multiple GPUs", () => {
    const csv = ["Example NVIDIA GPU, 8192 MiB", "NVIDIA GeForce RTX 4090, 24576 MiB"].join(
      "\n",
    );
    const gpus = parseNvidiaSmiCsv(csv);
    expect(gpus).toHaveLength(2);
    expect(gpus![1]).toEqual({
      name: "NVIDIA GeForce RTX 4090",
      vramBytes: 24576 * 1024 * 1024,
    });
  });

  it("returns undefined for empty CSV", () => {
    expect(parseNvidiaSmiCsv("")).toBeUndefined();
  });
});

describe("parseVramString", () => {
  it("parses common units", () => {
    expect(parseVramString("8 GB")).toBe(8 * 1024 * 1024 * 1024);
    expect(parseVramString("8192 MB")).toBe(8192 * 1024 * 1024);
    expect(parseVramString("8 GiB")).toBe(8 * 1024 * 1024 * 1024);
  });

  it("returns undefined for unknown strings", () => {
    expect(parseVramString("unknown")).toBeUndefined();
    expect(parseVramString(123 as unknown as string)).toBeUndefined();
  });
});

describe("parseSystemProfiler", () => {
  it("extracts Apple GPU name and VRAM", () => {
    const json = JSON.stringify([
      {
        _items: [
          {
            sppci_model: "Apple M3 Pro",
            sppci_vram: "18 GB",
          },
        ],
      },
    ]);
    const gpus = parseSystemProfiler(json);
    expect(gpus).toHaveLength(1);
    expect(gpus![0]).toEqual({
      name: "Apple M3 Pro",
      vramBytes: 18 * 1024 * 1024 * 1024,
    });
  });

  it("returns undefined for invalid JSON", () => {
    expect(parseSystemProfiler("not json")).toBeUndefined();
  });
});

describe("parseWindowsVideoControllers", () => {
  it("extracts name and AdapterRAM from PowerShell JSON", () => {
    const json = JSON.stringify({ Name: "NVIDIA GeForce Example GPU", AdapterRAM: 12884901888 });
    const gpus = parseWindowsVideoControllers(json);
    expect(gpus).toHaveLength(1);
    expect(gpus![0]).toEqual({
      name: "NVIDIA GeForce Example GPU",
      vramBytes: 12884901888,
    });
  });

  it("handles an array of controllers", () => {
    const json = JSON.stringify([
      { Name: "NVIDIA GeForce Example GPU", AdapterRAM: 12884901888 },
      { Name: "Intel UHD Graphics", AdapterRAM: 1073741824 },
    ]);
    const gpus = parseWindowsVideoControllers(json);
    expect(gpus).toHaveLength(2);
  });
});

describe("parseLspciGpus", () => {
  it("extracts clean device names from lspci output", () => {
    const output = [
      "00:00.0 VGA compatible controller: NVIDIA Corporation GA104 [Example NVIDIA GPU GDDR6X] (rev a1)",
      "00:00.1 VGA compatible controller: Advanced Micro Devices, Inc. [AMD/ATI] Raphael (rev c1)",
      "01:00.0 3D controller: NVIDIA Corporation GA102 [GeForce RTX 3090]",
    ].join("\n");
    const gpus = parseLspciGpus(output);
    expect(gpus).toEqual([
      { name: "NVIDIA Corporation GA104 [Example NVIDIA GPU GDDR6X]" },
      { name: "Advanced Micro Devices, Inc. [AMD/ATI] Raphael" },
      { name: "NVIDIA Corporation GA102 [GeForce RTX 3090]" },
    ]);
  });

  it("returns undefined for output with no GPU controllers", () => {
    expect(parseLspciGpus("00:00.0 Ethernet controller: Intel Corporation I219-V")).toBeUndefined();
  });
});

describe("machineInfoFromEnv", () => {
  it("parses a valid MBA_MACHINE_INFO value", () => {
    const info = machineInfoFromEnv({
      MBA_MACHINE_INFO: JSON.stringify({
        os: "linux",
        cpuCores: 8,
        totalRamBytes: 16 * 1024 * 1024 * 1024,
        gpus: [{ name: "Example GPU", vramBytes: 12 * 1024 * 1024 * 1024 }],
      }),
    });
    expect(info).toEqual({
      os: "linux",
      cpuCores: 8,
      totalRamBytes: 16 * 1024 * 1024 * 1024,
      gpus: [{ name: "Example GPU", vramBytes: 12 * 1024 * 1024 * 1024 }],
    });
  });

  it("returns undefined for invalid JSON", () => {
    expect(machineInfoFromEnv({ MBA_MACHINE_INFO: "not json" })).toBeUndefined();
  });

  it("returns undefined when the env var is absent", () => {
    expect(machineInfoFromEnv({})).toBeUndefined();
  });
});

describe("resolveMachineInfo", () => {
  it("prefers the env override over detection", () => {
    const env = {
      MBA_MACHINE_INFO: JSON.stringify({
        os: "linux",
        cpuCores: 99,
        totalRamBytes: 1024,
      }),
    };
    const info = resolveMachineInfo(env);
    expect(info!.cpuCores).toBe(99);
  });
});
