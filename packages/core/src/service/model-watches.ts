/**
 * Per-model known watches (read_file clamp / eof / loop).
 *
 * Empty model `tcb.jsonl` means inherit (global seed + family), not off.
 * Writes go through this block so the CLI never edits JSONL itself.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import YAML from "yaml";
import { defaultToolCircuitBreakerConfig } from "../bcb/default-config.js";
import type { ToolCircuitBreakerConfig } from "../bcb/types.js";
import { mergeToolCircuitBreakerConfig } from "../mba/adapter-merge.js";
import { selectEnvironmentFolder } from "../mba/adapter-loading.js";
import type { MbaResolutionContext } from "../mba/types.js";
import { findModelFiles } from "./model-config.js";

export type WatchId = "clamp" | "eof" | "loop";
export type WatchMode = "inherit" | "off" | "on";

export interface KnownWatch {
  readonly id: WatchId;
  readonly tool: string;
  readonly rule: string;
  readonly label: string;
}

export const KNOWN_WATCHES: readonly KnownWatch[] = [
  { id: "clamp", tool: "read_file", rule: "readClamp", label: "overshoot clamp" },
  { id: "eof", tool: "read_file", rule: "eofOverflow", label: "past-EOF stop" },
  { id: "loop", tool: "read_file", rule: "repeatRun", label: "read-loop mop" },
];

export interface WatchRow {
  readonly id: WatchId;
  readonly label: string;
  readonly tool: string;
  readonly rule: string;
  readonly mode: WatchMode;
  readonly effective: boolean;
}

export interface ModelWatches {
  readonly modelId: string | null;
  readonly tcbPath?: string;
  readonly watches: readonly WatchRow[];
}

export interface SetWatchResult {
  readonly modelId: string;
  readonly watch: WatchId;
  readonly before: WatchMode;
  readonly after: WatchMode;
}

const WATCH_ALIASES: Record<string, WatchId> = {
  clamp: "clamp",
  eof: "eof",
  loop: "loop",
  readclamp: "clamp",
  eofoverflow: "eof",
  repeatrun: "loop",
};

export function parseWatchId(raw: string): WatchId | null {
  return WATCH_ALIASES[raw.trim().toLowerCase()] ?? null;
}

export function parseWatchMode(raw: string): WatchMode | null {
  const v = raw.trim().toLowerCase();
  if (v === "inherit" || v === "off" || v === "on") return v;
  return null;
}

function knownWatch(id: WatchId): KnownWatch {
  return KNOWN_WATCHES.find((w) => w.id === id)!;
}

function globalEnabled(watch: KnownWatch): boolean {
  const tools = defaultToolCircuitBreakerConfig().tools as Record<
    string,
    Record<string, { enabled?: boolean } | undefined> | undefined
  >;
  return tools[watch.tool]?.[watch.rule]?.enabled !== false;
}

function readJsonlRows(path: string): Record<string, unknown>[] {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  const rows: Record<string, unknown>[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("//")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
    const row = parsed as Record<string, unknown>;
    if (typeof row.tool !== "string") continue;
    rows.push(row);
  }
  return rows;
}

function lineForWatch(rows: readonly Record<string, unknown>[], watch: KnownWatch): Record<string, unknown> | undefined {
  return rows.find((r) => r.tool === watch.tool && r.rule === watch.rule);
}

function declaredMode(rows: readonly Record<string, unknown>[], watch: KnownWatch): WatchMode {
  const line = lineForWatch(rows, watch);
  if (!line) return "inherit";
  return line.enabled === false ? "off" : "on";
}

function overlayEnabled(rows: readonly Record<string, unknown>[], watch: KnownWatch): boolean | null {
  const line = lineForWatch(rows, watch);
  if (!line) return null;
  return line.enabled !== false;
}

function effectiveEnabled(
  modelRows: readonly Record<string, unknown>[],
  familyRows: readonly Record<string, unknown>[],
  watch: KnownWatch,
): boolean {
  const model = overlayEnabled(modelRows, watch);
  if (model !== null) return model;
  const family = overlayEnabled(familyRows, watch);
  if (family !== null) return family;
  return globalEnabled(watch);
}

function tcbPathForYaml(yamlPath: string): string {
  const modelDir = dirname(yamlPath);
  const raw = YAML.parse(readFileSync(yamlPath, "utf8")) as Record<string, unknown> | null;
  const bindings = raw?.bindings as Record<string, unknown> | undefined;
  const rel = typeof bindings?.tcb === "string" ? bindings.tcb : null;
  if (!rel) return join(modelDir, "tcb.jsonl");
  return isAbsolute(rel) ? rel : resolve(modelDir, rel);
}

function familyTcbPath(modelYamlPath: string): string {
  return join(dirname(dirname(modelYamlPath)), "tcb.jsonl");
}

function rowsToWatches(
  modelRows: readonly Record<string, unknown>[],
  familyRows: readonly Record<string, unknown>[],
): WatchRow[] {
  return KNOWN_WATCHES.map((w) => ({
    id: w.id,
    label: w.label,
    tool: w.tool,
    rule: w.rule,
    mode: declaredMode(modelRows, w),
    effective: effectiveEnabled(modelRows, familyRows, w),
  }));
}

export function defaultWatches(): ModelWatches {
  return {
    modelId: null,
    watches: rowsToWatches([], []),
  };
}

export function readModelWatches(adapterDir: string, modelId: string): ModelWatches | null {
  const files = findModelFiles(adapterDir, modelId);
  if (!files) return null;
  const tcbPath = tcbPathForYaml(files.yamlPath);
  const modelRows = readJsonlRows(tcbPath);
  const familyRows = readJsonlRows(familyTcbPath(files.yamlPath));
  return {
    modelId,
    tcbPath,
    watches: rowsToWatches(modelRows, familyRows),
  };
}

export interface WatchOverlayEnv {
  readonly harness: string;
  readonly ide?: string;
  readonly serverRuntime?: string;
}

function mergeTcbFile(
  base: ToolCircuitBreakerConfig,
  path: string,
): ToolCircuitBreakerConfig {
  if (!existsSync(path)) return base;
  let next = base;
  for (const row of readJsonlRows(path)) {
    const rule = typeof row.rule === "string" ? row.rule : undefined;
    if (!rule) continue;
    const overlay: Record<string, unknown> = { ...row };
    delete overlay.tool;
    delete overlay.rule;
    next = mergeToolCircuitBreakerConfig(next, {
      tools: { [row.tool as string]: { [rule]: overlay } },
    } as ToolCircuitBreakerConfig);
  }
  return next;
}

function envTcbPath(scopeDir: string, env: WatchOverlayEnv, modelId: string): string | undefined {
  const ctx: MbaResolutionContext = {
    modelName: modelId,
    harness: env.harness,
    ide: env.ide,
    serverRuntime: env.serverRuntime,
  };
  const folder = selectEnvironmentFolder(scopeDir, ctx);
  if (!folder) return undefined;
  return join(folder, "tcb.jsonl");
}

/**
 * Live TCB for one model: HQ global, then family / model `tcb.jsonl`,
 * then matching `environments/` overlays. Empty `{}` is inherit.
 */
export function overlayTcbForModel(
  base: ToolCircuitBreakerConfig,
  adapterDir: string,
  modelId: string,
  env?: WatchOverlayEnv,
): ToolCircuitBreakerConfig {
  const files = findModelFiles(adapterDir, modelId);
  if (!files) return base;
  const modelDir = dirname(files.yamlPath);
  const familyDir = dirname(modelDir);
  let next = mergeTcbFile(base, familyTcbPath(files.yamlPath));
  if (env) {
    const familyEnv = envTcbPath(familyDir, env, modelId);
    if (familyEnv) next = mergeTcbFile(next, familyEnv);
  }
  next = mergeTcbFile(next, tcbPathForYaml(files.yamlPath));
  if (env) {
    const modelEnv = envTcbPath(modelDir, env, modelId);
    if (modelEnv) next = mergeTcbFile(next, modelEnv);
  }
  return next;
}

function atomicWriteText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, path);
}

function writeJsonl(path: string, rows: readonly Record<string, unknown>[]): void {
  if (rows.length === 0) {
    atomicWriteText(path, "{}\n");
    return;
  }
  atomicWriteText(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

export function setModelWatch(
  adapterDir: string,
  modelId: string,
  watchId: WatchId,
  mode: WatchMode,
): SetWatchResult | { error: string; status: 400 | 404 } {
  const files = findModelFiles(adapterDir, modelId);
  if (!files) return { error: `unknown model: ${modelId}`, status: 404 };
  const watch = knownWatch(watchId);
  const tcbPath = tcbPathForYaml(files.yamlPath);
  const rows = readJsonlRows(tcbPath);
  const before = declaredMode(rows, watch);

  let next: Record<string, unknown>[];
  if (mode === "inherit") {
    next = rows.filter((r) => !(r.tool === watch.tool && r.rule === watch.rule));
  } else {
    const enabled = mode === "on";
    const idx = rows.findIndex((r) => r.tool === watch.tool && r.rule === watch.rule);
    if (idx >= 0) {
      next = rows.map((r, i) => (i === idx ? { ...r, enabled } : r));
    } else {
      next = [...rows, { tool: watch.tool, rule: watch.rule, enabled }];
    }
  }

  writeJsonl(tcbPath, next);
  return { modelId, watch: watchId, before, after: mode };
}
