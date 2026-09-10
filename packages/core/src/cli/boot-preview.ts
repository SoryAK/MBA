/**
 * Sectioned boot preview TTY (machine / model / env / server / flags).
 * JSON lives on POST /servers/resolve; this file only paints.
 */

import { formatBytes } from "./client.js";
import { compactBootLines, pairCliArgs } from "./flag-pairs.js";
import { isBareBootEnv, overlayFolderName } from "../service/env-context.js";
import { brand, dim, heading, kv, paint, BOLD } from "./style.js";

export interface BootPreviewModel {
  readonly sizeLabel?: string;
  readonly quant?: string;
  readonly architecture?: string;
  readonly fileBytes?: number;
  readonly vision?: boolean;
  readonly toolCalling?: boolean;
  readonly moe?: string;
}

export interface BootPreviewExtras {
  readonly binary?: { path: string; backend: string; nickname?: string };
  readonly warning?: string;
  readonly gpus?: readonly string[];
  readonly vramBytes?: readonly (number | null)[];
  readonly ramBytes?: number;
  readonly cpuThreads?: number;
  readonly env?: { harness: string; ide: string; serverRuntime: string };
  /** False on a bare boot (family+model only). Omit when env is attached. */
  readonly envAttached?: boolean;
  readonly model?: BootPreviewModel;
  readonly pinned?: boolean;
  readonly picked?: boolean;
  readonly machineOverlay?: "enforce" | "warn" | "off";
}

function shortGpu(name: string): string {
  return name.replace(/^NVIDIA GeForce /i, "").replace(/^NVIDIA /i, "").trim();
}

function formatGpuLine(names: readonly string[], vrams?: readonly (number | null)[]): string {
  return names
    .map((name, i) => {
      const short = shortGpu(name);
      const vram = vrams?.[i];
      if (typeof vram === "number" && vram > 0) return `${short}  ${formatBytes(vram)}`;
      return short;
    })
    .filter((s) => s.length > 0)
    .join(", ");
}

function envAttached(extras?: BootPreviewExtras): boolean {
  if (extras?.envAttached === false) return false;
  if (!extras?.env) return false;
  return !isBareBootEnv(extras.env);
}

function overlayHint(mode: "enforce" | "warn" | "off"): string {
  if (mode === "enforce") return "enforce  clamp flags to this box";
  if (mode === "warn") return "warn  log only";
  return "off  no clamp";
}

function yn(v: boolean): string {
  return v ? "true" : "false";
}

export function formatBootPreviewLines(
  modelId: string,
  port: number,
  cliArgs: readonly string[],
  extras?: BootPreviewExtras,
): string[] {
  const lines: string[] = [`${brand("boot")}  ${paint(modelId, BOLD)}  ${dim(`:${String(port)}`)}`];

  const gpuNames = extras?.gpus ?? [];
  const gpu = gpuNames.length > 0 ? formatGpuLine(gpuNames, extras?.vramBytes) : undefined;
  const cpu =
    extras?.cpuThreads !== undefined && extras.cpuThreads > 0
      ? `${extras.cpuThreads} threads`
      : undefined;
  const ram =
    extras?.ramBytes !== undefined && extras.ramBytes > 0
      ? formatBytes(extras.ramBytes)
      : undefined;
  const overlay = extras?.machineOverlay;
  if (gpu || cpu || ram || overlay) {
    lines.push(`  ${heading("machine")}`);
    if (gpu) lines.push(kv("gpu", gpu, 8));
    if (cpu) lines.push(kv("cpu", cpu, 8));
    if (ram) lines.push(kv("ram", ram, 8));
    if (overlay) lines.push(kv("overlay", overlayHint(overlay), 8));
  }

  const m = extras?.model;
  const sizeBits = [m?.sizeLabel, m?.fileBytes !== undefined ? formatBytes(m.fileBytes) : undefined].filter(
    (s): s is string => Boolean(s),
  );
  if (m && (sizeBits.length > 0 || m.quant || m.architecture || m.moe || m.vision !== undefined || m.toolCalling !== undefined)) {
    lines.push(`  ${heading("model")}`);
    if (sizeBits.length > 0) lines.push(kv("size", sizeBits.join("  "), 8));
    if (m.quant) lines.push(kv("quant", m.quant, 8));
    if (m.architecture) lines.push(kv("arch", m.architecture, 8));
    if (m.moe) lines.push(kv("moe", m.moe, 8));
    if (m.vision !== undefined) lines.push(kv("vision", yn(m.vision), 8));
    if (m.toolCalling !== undefined) lines.push(kv("tools", yn(m.toolCalling), 8));
  }

  if (envAttached(extras) && extras?.env) {
    lines.push(kv("env", overlayFolderName(extras.env), 8));
  } else {
    lines.push(kv("env", "not set", 8));
  }

  if (extras?.binary) {
    const nick = extras.binary.nickname?.trim();
    const shown = nick
      ? `${nick}  ${extras.binary.backend}`
      : extras.binary.backend;
    const set = extras.pinned ? "pinned" : extras.picked ? "picked" : "default";
    lines.push(`  ${heading("server")}`);
    lines.push(kv("bin", shown, 8));
    lines.push(kv("set", set, 8));
    if (extras.warning) lines.push(kv("note", extras.warning, 8));
  } else if (extras?.warning) {
    lines.push(kv("note", extras.warning, 8));
  }

  const flags = compactBootLines(pairCliArgs(cliArgs));
  if (flags.length > 0) {
    lines.push(`  ${heading("flags")}`);
    for (const line of flags) lines.push(`    ${line}`);
  }

  lines.push("");
  return lines;
}

export function printBootPreview(
  modelId: string,
  port: number,
  cliArgs: readonly string[],
  extras?: BootPreviewExtras,
): void {
  process.stdout.write(`${formatBootPreviewLines(modelId, port, cliArgs, extras).join("\n")}\n`);
}
