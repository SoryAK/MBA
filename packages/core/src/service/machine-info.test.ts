import { describe, it, expect } from "vitest";
import {
  countPhysicalCores,
  detectMachineInfo,
  extractCpuFlags,
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

  it("returns CPU model, architecture, and flags on Linux", () => {
    if (process.platform !== "linux") return;
    const info = detectMachineInfo();
    expect(info).toBeDefined();
    expect(typeof info!.cpuModel).toBe("string");
    expect(info!.cpuModel!.length).toBeGreaterThan(0);
    expect(typeof info!.cpuArchitecture).toBe("string");
    expect(info!.cpuArchitecture!.length).toBeGreaterThan(0);
    expect(Array.isArray(info!.cpuFlags)).toBe(true);
    expect(info!.cpuFlags!.length).toBeGreaterThan(0);
  });
});

describe("countPhysicalCores", () => {
  it("counts unique physical cores from /proc/cpuinfo-style text", () => {
    const text = [
      "processor\t: 0",
      "physical id\t: 0",
      "core id\t\t: 0",
      "",
      "processor\t: 1",
      "physical id\t: 0",
      "core id\t\t: 0",
      "",
      "processor\t: 2",
      "physical id\t: 0",
      "core id\t\t: 1",
      "",
      "processor\t: 3",
      "physical id\t: 1",
      "core id\t\t: 0",
    ].join("\n");
    expect(countPhysicalCores(text)).toBe(3);
  });

  it("returns undefined when no core ids are present", () => {
    expect(countPhysicalCores("processor\t: 0")).toBeUndefined();
  });
});

describe("extractCpuFlags", () => {
  it("extracts the flags list from the first processor block", () => {
    const text = [
      "processor\t: 0",
      "flags\t\t: fpu vme de pse tsc msr pae mce cx8 apic sep mtrr pge mca cmov pat pse36 clflush mmx fxsr sse sse2 ss ht syscall nx pdpe1gb rdtscp lm constant_tsc rep_good nopl xtopology nonstop_tsc cpuid aperfmperf tsc_known_freq pni pclmulqdq ssse3 fma cx16 pcid sse4_1 sse4_2 x2apic movbe popcnt tsc_deadline_timer aes xsave avx f16c rdrand hypervisor lahf_lm abm cpuid_fault invpcid_single ssbd ibrs ibpb stibp ibrs_enhanced fsgsbase tsc_adjust bmi1 avx2 smep bmi2 erms invpcid xsaveopt arat",
      "",
      "processor\t: 1",
      "flags\t\t: should be ignored",
    ].join("\n");
    const flags = extractCpuFlags(text);
    expect(flags).toBeDefined();
    expect(flags).toContain("avx");
    expect(flags).toContain("avx2");
    expect(flags).not.toContain("should");
  });

  it("returns undefined when no flags line is present", () => {
    expect(extractCpuFlags("processor\t: 0")).toBeUndefined();
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
      "    <product_name>Example NVIDIA GPU</product_name>",
      "    <fb_memory_usage>",
      "      <total>24564 MiB</total>",
      "    </fb_memory_usage>",
      "  </gpu>",
      "</nvidia_smi_log>",
    ].join("\n");
    const gpus = parseNvidiaSmiXml(xml);
    expect(gpus).toHaveLength(1);
    expect(gpus![0]).toEqual({
      name: "Example NVIDIA GPU",
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
    const csv = ["Example NVIDIA GPU, 8192 MiB", "Example High-End GPU, 24576 MiB"].join(
      "\n",
    );
    const gpus = parseNvidiaSmiCsv(csv);
    expect(gpus).toHaveLength(2);
    expect(gpus![1]).toEqual({
      name: "Example High-End GPU",
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
            sppci_model: "Apple GPU Example",
            sppci_vram: "18 GB",
          },
        ],
      },
    ]);
    const gpus = parseSystemProfiler(json);
    expect(gpus).toHaveLength(1);
    expect(gpus![0]).toEqual({
      name: "Apple GPU Example",
      vramBytes: 18 * 1024 * 1024 * 1024,
    });
  });

  it("returns undefined for invalid JSON", () => {
    expect(parseSystemProfiler("not json")).toBeUndefined();
  });
});

describe("parseWindowsVideoControllers", () => {
  it("extracts name and AdapterRAM from PowerShell JSON", () => {
    const json = JSON.stringify({ Name: "Example NVIDIA GPU", AdapterRAM: 12884901888 });
    const gpus = parseWindowsVideoControllers(json);
    expect(gpus).toHaveLength(1);
    expect(gpus![0]).toEqual({
      name: "Example NVIDIA GPU",
      vramBytes: 12884901888,
    });
  });

  it("handles an array of controllers", () => {
    const json = JSON.stringify([
      { Name: "Example NVIDIA GPU", AdapterRAM: 12884901888 },
      { Name: "Intel iGPU Example", AdapterRAM: 1073741824 },
    ]);
    const gpus = parseWindowsVideoControllers(json);
    expect(gpus).toHaveLength(2);
  });
});

describe("parseLspciGpus", () => {
  it("extracts clean device names from lspci output", () => {
    const output = [
      "00:00.0 VGA compatible controller: NVIDIA Corporation GPU Chip [Example GPU] (rev a1)",
      "00:00.1 VGA compatible controller: Advanced Micro Devices, Inc. [AMD/ATI] Example iGPU (rev c1)",
      "01:00.0 3D controller: NVIDIA Corporation GPU Chip 2 [Example GPU 2]",
    ].join("\n");
    const gpus = parseLspciGpus(output);
    expect(gpus).toEqual([
      { name: "NVIDIA Corporation GPU Chip [Example GPU]" },
      { name: "Advanced Micro Devices, Inc. [AMD/ATI] Example iGPU" },
      { name: "NVIDIA Corporation GPU Chip 2 [Example GPU 2]" },
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
