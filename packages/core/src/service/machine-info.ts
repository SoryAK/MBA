/**
 * Host machine detection (ADR-0103).
 *
 * Detects CPU core count, total RAM, and GPU/VRAM information. The detection
 * is platform-specific but the returned shape is platform-independent. Any
 * field that cannot be detected is omitted rather than guessed.
 *
 * This module performs I/O (child process execution, file reading) and is
 * therefore kept separate from the pure overlay policy in
 * `machine-overlay.ts`.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";

export interface GpuInfo {
  readonly name?: string;
  readonly vramBytes?: number;
}

export interface MachineInfo {
  readonly os: "linux" | "darwin" | "win32" | string;
  readonly cpuCores: number;
  readonly totalRamBytes: number;
  readonly gpus?: readonly GpuInfo[];
}

/**
 * Detect the host machine. Returns undefined only if even the most basic
 * values (CPU count and RAM) cannot be read, which should never happen on a
 * healthy Node runtime. GPU detection is best-effort.
 */
export function detectMachineInfo(): MachineInfo | undefined {
  const cpuCores = detectCpuCores();
  const totalRam = detectTotalRam();
  if (cpuCores === undefined || totalRam === undefined) {
    return undefined;
  }

  const os = process.platform;
  const gpus = detectGpus();

  return {
    os,
    cpuCores,
    totalRamBytes: totalRam,
    ...(gpus !== undefined && gpus.length > 0 ? { gpus } : {}),
  };
}

function detectCpuCores(): number | undefined {
  const list = cpus();
  if (Array.isArray(list) && list.length > 0) {
    return list.length;
  }
  return undefined;
}

function detectTotalRam(): number | undefined {
  const value = totalmem();
  if (typeof value === "number" && value > 0) {
    return value;
  }

  // Fallback for Linux containers where os.totalmem() may be unreliable.
  if (process.platform === "linux" && existsSync("/proc/meminfo")) {
    const meminfo = parseMeminfo(readFileSync("/proc/meminfo", "utf8"));
    if (meminfo.MemTotal !== undefined && meminfo.MemTotal > 0) {
      return meminfo.MemTotal * 1024;
    }
  }

  return undefined;
}

/** Exported for tests. */
export function parseMeminfo(text: string): Record<string, number> {
  const result: Record<string, number> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z]+):\s*(\d+)\s*kB/i);
    if (match && match[1] && match[2]) {
      result[match[1]] = Number(match[2]);
    }
  }
  return result;
}

function detectGpus(): readonly GpuInfo[] | undefined {
  switch (process.platform) {
    case "linux":
      return detectLinuxGpus();
    case "darwin":
      return detectMacGpus();
    case "win32":
      return detectWindowsGpus();
    default:
      return undefined;
  }
}

function detectLinuxGpus(): readonly GpuInfo[] | undefined {
  // Prefer nvidia-smi because it gives accurate VRAM. If it is not present,
  // fall back to lspci for names without VRAM.
  const nvidia = detectNvidiaSmi();
  if (nvidia !== undefined && nvidia.length > 0) {
    return nvidia;
  }
  return detectLspciGpus();
}

function detectNvidiaSmi(): readonly GpuInfo[] | undefined {
  // Try the command as it would appear on PATH, then a few common absolute
  // paths. nvidia-smi is the only reliable source of NVIDIA VRAM on Linux.
  const candidates = ["nvidia-smi", "/usr/bin/nvidia-smi", "/usr/local/bin/nvidia-smi"];
  for (const bin of candidates) {
    try {
      const output = execFileSync(bin, ["-q", "-x"], {
        encoding: "utf8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      const gpus = parseNvidiaSmiXml(output);
      if (gpus !== undefined && gpus.length > 0) return gpus;
    } catch {
      // Try the next candidate.
    }
  }
  return undefined;
}

/** Exported for tests. */
export function parseNvidiaSmiXml(xml: string): readonly GpuInfo[] | undefined {
  const gpus: GpuInfo[] = [];
  // Minimal XML extraction without pulling in a full parser.
  const gpuBlocks = xml.match(/<gpu>[\s\S]*?<\/gpu>/g) ?? [];
  for (const block of gpuBlocks) {
    const name = extractXmlTag(block, "product_name");
    const vramMb = extractXmlTag(block, "fb_memory_usage")?.match(
      /<total>([\d.]+)\s*MiB<\/total>/,
    )?.[1];
    gpus.push({
      ...(name ? { name: name.trim() } : {}),
      ...(vramMb ? { vramBytes: Math.round(Number(vramMb) * 1024 * 1024) } : {}),
    });
  }
  return gpus.length > 0 ? gpus : undefined;
}

function extractXmlTag(xml: string, tag: string): string | undefined {
  const match = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
  return match?.[1];
}

/** Exported for tests. */
export function parseLspciGpus(output: string): readonly GpuInfo[] | undefined {
  const names: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    // lspci line format: "00:00.0 VGA compatible controller: NVIDIA ... [GeForce ...] (rev a1)"
    // We want the vendor/device string after the controller-type colon.
    const match = line.match(
      /(VGA compatible controller|3D controller|Display controller):\s*(.*?)\s*(?:\(rev [a-f0-9]+\))?$/i,
    );
    if (match && match[2]) {
      const cleaned = match[2].trim();
      if (cleaned.length > 0) names.push(cleaned);
    }
  }
  const unique = [...new Set(names)];
  return unique.length > 0 ? unique.map((name) => ({ name })) : undefined;
}

function detectLspciGpus(): readonly GpuInfo[] | undefined {
  try {
    const output = execFileSync("lspci", [], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return parseLspciGpus(output);
  } catch {
    return undefined;
  }
}

function detectMacGpus(): readonly GpuInfo[] | undefined {
  try {
    const output = execFileSync("system_profiler", ["SPDisplaysDataType", "-json"], {
      encoding: "utf8",
      timeout: 10000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return parseSystemProfiler(output);
  } catch {
    return undefined;
  }
}

/** Exported for tests. */
export function parseSystemProfiler(json: string): readonly GpuInfo[] | undefined {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    const gpus: GpuInfo[] = [];
    for (const entry of parsed) {
      const obj = (entry as Record<string, unknown>)?._items;
      if (!Array.isArray(obj)) continue;
      for (const item of obj) {
        const record = item as Record<string, unknown>;
        const name =
          typeof record["sppci_model"] === "string" ? record["sppci_model"] : undefined;
        const vramRaw = record["sppci_vram"];
        const vramBytes = parseVramString(vramRaw);
        gpus.push({
          ...(name ? { name: name.trim() } : {}),
          ...(vramBytes !== undefined ? { vramBytes } : {}),
        });
      }
    }
    return gpus.length > 0 ? gpus : undefined;
  } catch {
    return undefined;
  }
}

/** Exported for tests. */
export function parseVramString(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const match = value.match(/([\d.]+)\s*(GB|MB|KB|B|GiB|MiB|KiB)/i);
  if (!match || match[1] === undefined || match[2] === undefined) return undefined;
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  switch (unit) {
    case "b":
      return amount;
    case "kb":
    case "kib":
      return amount * 1024;
    case "mb":
    case "mib":
      return amount * 1024 * 1024;
    case "gb":
    case "gib":
      return amount * 1024 * 1024 * 1024;
    default:
      return undefined;
  }
}

function detectWindowsGpus(): readonly GpuInfo[] | undefined {
  // Best-effort via PowerShell Get-CimInstance. Avoids wmic which is deprecated.
  try {
    const output = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        "Get-CimInstance Win32_VideoController | Select-Object Name, AdapterRAM | ConvertTo-Json -Compress",
      ],
      {
        encoding: "utf8",
        timeout: 10000,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    return parseWindowsVideoControllers(output);
  } catch {
    return undefined;
  }
}

/** Exported for tests. */
export function parseWindowsVideoControllers(json: string): readonly GpuInfo[] | undefined {
  try {
    const parsed = JSON.parse(json) as unknown;
    const entries = Array.isArray(parsed) ? parsed : [parsed];
    const gpus: GpuInfo[] = [];
    for (const entry of entries) {
      const record = entry as Record<string, unknown>;
      const name = typeof record["Name"] === "string" ? record["Name"] : undefined;
      const ram = typeof record["AdapterRAM"] === "number" ? record["AdapterRAM"] : undefined;
      gpus.push({
        ...(name ? { name: name.trim() } : {}),
        ...(ram !== undefined ? { vramBytes: ram } : {}),
      });
    }
    return gpus.length > 0 ? gpus : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read GPU info from the environment. This is exposed for tests and for
 * headless/cloud environments where detection is unreliable.
 */
export function machineInfoFromEnv(env: NodeJS.ProcessEnv = process.env): MachineInfo | undefined {
  const override = env.MBA_MACHINE_INFO;
  if (!override || override.length === 0) return undefined;
  try {
    return JSON.parse(override) as MachineInfo;
  } catch {
    return undefined;
  }
}

/**
 * Resolve machine info, preferring an explicit env override, then detection.
 */
export function resolveMachineInfo(env?: NodeJS.ProcessEnv): MachineInfo | undefined {
  return machineInfoFromEnv(env) ?? detectMachineInfo();
}
