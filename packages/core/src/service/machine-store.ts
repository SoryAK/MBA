/**
 * Machine profile persistence (ADR-0103).
 *
 * Reads, writes, and refreshes the persisted `machine.json` profile in the MBA
 * state directory. The daemon uses this file as the source of truth for
 * clamping; it does not have to re-detect hardware on every request.
 *
 * Refresh happens at daemon boot and on explicit request. A diff is produced
 * when the recorded profile changes so the daemon can log it.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { MachineInfo } from "./machine-info.js";
import { machineInfoFromEnv, resolveMachineInfo } from "./machine-info.js";
import type { MbaStorePaths } from "./config-store.js";

export const MACHINE_INFO_FILENAME = "machine.json";

export interface MachineStoreRefreshResult {
  readonly info: MachineInfo | undefined;
  /** True if the persisted file was written or overwritten. */
  readonly changed: boolean;
  /** Human-readable diff lines, empty when unchanged. */
  readonly diff: readonly string[];
  /** True if the profile came from the MBA_MACHINE_INFO env override. */
  readonly fromEnv: boolean;
}

/**
 * Resolve the path to `machine.json` within the MBA state directory.
 */
export function machineInfoPath(paths: MbaStorePaths): string {
  return join(paths.baseDir, "mba", MACHINE_INFO_FILENAME);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidMachineInfo(value: unknown): value is MachineInfo {
  if (!isPlainObject(value)) return false;
  if (typeof value.os !== "string") return false;
  if (typeof value.cpuCores !== "number" || !Number.isFinite(value.cpuCores)) return false;
  if (value.cpuPhysicalCores !== undefined && (typeof value.cpuPhysicalCores !== "number" || !Number.isFinite(value.cpuPhysicalCores))) return false;
  if (value.cpuModel !== undefined && typeof value.cpuModel !== "string") return false;
  if (value.cpuSpeedMHz !== undefined && (typeof value.cpuSpeedMHz !== "number" || !Number.isFinite(value.cpuSpeedMHz))) return false;
  if (value.cpuArchitecture !== undefined && typeof value.cpuArchitecture !== "string") return false;
  if (value.cpuFlags !== undefined && (!Array.isArray(value.cpuFlags) || value.cpuFlags.some((f) => typeof f !== "string"))) return false;
  if (typeof value.totalRamBytes !== "number" || !Number.isFinite(value.totalRamBytes)) return false;
  if (value.gpus !== undefined) {
    if (!Array.isArray(value.gpus)) return false;
    for (const gpu of value.gpus) {
      if (!isPlainObject(gpu)) return false;
      if (gpu.name !== undefined && typeof gpu.name !== "string") return false;
      if (gpu.vramBytes !== undefined && typeof gpu.vramBytes !== "number") return false;
    }
  }
  return true;
}

/**
 * Read the persisted machine profile. Returns undefined if the file is missing,
 * unreadable, or malformed. A malformed file is treated as if it did not exist
 * so the daemon can recover by writing fresh detected data.
 */
export function readMachineInfo(paths: MbaStorePaths): MachineInfo | undefined {
  const path = machineInfoPath(paths);
  if (!existsSync(path)) return undefined;
  try {
    const text = readFileSync(path, "utf8");
    const parsed = JSON.parse(text) as unknown;
    if (isValidMachineInfo(parsed)) return parsed;
  } catch {
    // Treat corrupt files as absent.
  }
  return undefined;
}

function writeAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, path);
}

/**
 * Write the machine profile to disk. Overwrites any existing file.
 */
export function writeMachineInfo(paths: MbaStorePaths, info: MachineInfo): void {
  writeAtomic(machineInfoPath(paths), JSON.stringify(info, null, 2) + "\n");
}

function normalizeGpu(gpu: GpuInfo): string {
  const parts: string[] = [];
  if (gpu.name) parts.push(gpu.name);
  if (gpu.vramBytes !== undefined) parts.push(`${formatBytes(gpu.vramBytes)} VRAM`);
  return parts.length > 0 ? parts.join(" ") : "unknown GPU";
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024 * 1024) return `${(n / (1024 * 1024 * 1024 * 1024)).toFixed(1)} TiB`;
  if (n >= 1024 * 1024 * 1024) return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${n} B`;
}

type GpuInfo = NonNullable<MachineInfo["gpus"]>[number];

function diffMachineInfo(
  before: MachineInfo | undefined,
  after: MachineInfo | undefined,
): readonly string[] {
  if (before === undefined && after === undefined) return [];
  if (before === undefined && after !== undefined) {
    return [`initial machine profile: ${formatMachineInfo(after)}`];
  }
  if (before !== undefined && after === undefined) {
    return ["machine profile removed"];
  }
  const a = before!;
  const b = after!;
  const lines: string[] = [];

  if (a.os !== b.os) lines.push(`os: ${a.os} → ${b.os}`);
  if (a.cpuCores !== b.cpuCores) lines.push(`cpuCores: ${a.cpuCores} → ${b.cpuCores}`);
  if (a.cpuPhysicalCores !== b.cpuPhysicalCores) {
    lines.push(`cpuPhysicalCores: ${a.cpuPhysicalCores ?? "?"} → ${b.cpuPhysicalCores ?? "?"}`);
  }
  if (a.cpuModel !== b.cpuModel) {
    lines.push(`cpuModel: ${a.cpuModel ?? "?"} → ${b.cpuModel ?? "?"}`);
  }
  if (a.cpuArchitecture !== b.cpuArchitecture) {
    lines.push(`cpuArchitecture: ${a.cpuArchitecture ?? "?"} → ${b.cpuArchitecture ?? "?"}`);
  }
  if (a.cpuSpeedMHz !== b.cpuSpeedMHz) {
    lines.push(`cpuSpeedMHz: ${a.cpuSpeedMHz ?? "?"} → ${b.cpuSpeedMHz ?? "?"}`);
  }
  if (!arraysEqual(a.cpuFlags, b.cpuFlags)) {
    lines.push(`cpuFlags: changed`);
  }
  if (a.totalRamBytes !== b.totalRamBytes) {
    lines.push(`totalRam: ${formatBytes(a.totalRamBytes)} → ${formatBytes(b.totalRamBytes)}`);
  }

  const aGpus = a.gpus ?? [];
  const bGpus = b.gpus ?? [];
  if (aGpus.length !== bGpus.length) {
    lines.push(`gpus: ${aGpus.length} → ${bGpus.length}`);
  }
  for (let i = 0; i < Math.max(aGpus.length, bGpus.length); i++) {
    const beforeGpu = aGpus[i];
    const afterGpu = bGpus[i];
    if (beforeGpu === undefined && afterGpu !== undefined) {
      lines.push(`gpu[${i}]: added ${normalizeGpu(afterGpu)}`);
    } else if (beforeGpu !== undefined && afterGpu === undefined) {
      lines.push(`gpu[${i}]: removed ${normalizeGpu(beforeGpu)}`);
    } else if (beforeGpu !== undefined && afterGpu !== undefined) {
      const beforeStr = normalizeGpu(beforeGpu);
      const afterStr = normalizeGpu(afterGpu);
      if (beforeStr !== afterStr) {
        lines.push(`gpu[${i}]: ${beforeStr} → ${afterStr}`);
      }
    }
  }

  return lines;
}

function formatMachineInfo(info: MachineInfo): string {
  const parts: string[] = [];
  if (info.cpuModel) {
    parts.push(info.cpuModel);
  }
  if (info.cpuPhysicalCores !== undefined) {
    parts.push(`${info.cpuPhysicalCores}/${info.cpuCores} cores`);
  } else {
    parts.push(`${info.cpuCores} cores`);
  }
  if (info.cpuArchitecture) parts.push(info.cpuArchitecture);
  parts.push(`${formatBytes(info.totalRamBytes)} RAM`);
  if (info.gpus && info.gpus.length > 0) {
    parts.push(info.gpus.map(normalizeGpu).join(", "));
  }
  return `${info.os}, ${parts.join(", ")}`;
}

function arraysEqual(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Refresh the persisted machine profile.
 *
 * 1. If `MBA_MACHINE_INFO` is set, use it (and persist it so the overlay is
 *    consistent for the daemon's lifetime).
 * 2. Otherwise detect the host machine.
 * 3. Compare with the currently persisted profile. If it changed, write the new
 *    profile and return the diff.
 */
export function refreshMachineInfo(
  paths: MbaStorePaths,
  env?: NodeJS.ProcessEnv,
): MachineStoreRefreshResult {
  const fromEnv = machineInfoFromEnv(env) !== undefined;
  const detected = resolveMachineInfo(env);
  const existing = readMachineInfo(paths);
  const diff = diffMachineInfo(existing, detected);
  const changed = diff.length > 0;

  if (detected !== undefined && changed) {
    writeMachineInfo(paths, detected);
  }

  return { info: detected, changed, diff, fromEnv };
}
