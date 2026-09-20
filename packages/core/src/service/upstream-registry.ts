/**
 * Upstream model-server registry (ADR-0097 Phase 1).
 *
 * The "guest book" of running model servers: every upstream that is (or was)
 * booted signs in here — which model file, which server type, which port,
 * which PID. The service is the SINGLE WRITER (same rule as the config
 * store); Phase 1 only reads and resolves, the boot/stop writers land in
 * Phase 2.
 *
 * Design:
 *   - FILE IS TRUTH. `~/.mba/mba/upstreams.json` (same home as
 *     `service.json`, same discovery-file idiom). Atomic write-temp → rename.
 *   - MERGE, NEVER CLOBBER. `upsertEntry` replaces by `id` and keeps the
 *     other entries — booting a second server appends, it does not evict.
 *   - SERIALIZED MUTATIONS. `updateRegistry` queues overlapping RMW so a
 *     boot or stop cannot erase a sibling that signed in while it waited.
 *   - TYPED READS. Missing, valid-empty, and corrupt are different facts.
 *     Corrupt must not look like an empty registry (that used to enable the
 *     static `MBA_UPSTREAM_URL` fallback).
 *   - LAZY VALIDATION (G2). `resolveUpstream` accepts an optional
 *     `healthyIds` set: entries whose health probe failed are excluded at
 *     read time. No background sweeper, no timers — a stale entry costs one
 *     failed probe and then falls through to the next rung.
 *   - RESOLVE RULE. Among entries matching the model: healthiest first,
 *     then most-recently-booted, tie → lowest port. Losers stay in the
 *     registry and stay visible — resolution never deletes.
 *
 * Pure-ish: fs I/O is confined to `readRegistry`/`writeRegistry` and takes
 * an explicit path so tests point at a temp dir. The resolve/upsert/remove
 * functions are pure.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { withHouseLock } from "./house-lock.js";

/** One running (or recently running) model server. */
export interface UpstreamEntry {
  /** Stable per-instance id (e.g. `llama-cpp-8080`). Upsert key. */
  readonly id: string;
  /** Server type — the `server_setup.json` keying (e.g. `llama.cpp`). */
  readonly serverType: string;
  /** Absolute GGUF path the server was booted with. */
  readonly modelFile: string;
  /** TCP port the server listens on (127.0.0.1). */
  readonly port: number;
  /**
   * llama.cpp fork used at boot (`upstream` | `llama.cpp`). Needed after boot
   * to re-derive the G3 KV dir (`kv/<fork>/slots`). Absent on ollama.
   */
  readonly fork?: "upstream" | "llama.cpp";
  /**
   * PID of the server process. Present for process-per-model types
   * (llama.cpp — the G1 owned group); absent for API-managed types
   * (ollama — the daemon owns the process, we only load/unload the model).
   */
  readonly pid?: number;
  /** ISO timestamp of the boot. Recency input for the resolve rule. */
  readonly startedAt: string;
  /** Server stdout log path (informational). */
  readonly logOut?: string;
  /** Server stderr log path (informational). */
  readonly logErr?: string;
}

/** On-disk registry document. */
interface UpstreamRegistryFile {
  readonly version: number;
  readonly upstreams: unknown[];
}

const REGISTRY_VERSION = 1;

export type RegistryReadResult =
  | { readonly kind: "missing"; readonly entries: readonly UpstreamEntry[] }
  | { readonly kind: "valid"; readonly entries: readonly UpstreamEntry[] }
  | {
      readonly kind: "corrupt";
      readonly entries: readonly UpstreamEntry[];
      readonly error: string;
    };

function isUpstreamEntry(value: unknown): value is UpstreamEntry {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.serverType === "string" &&
    typeof v.modelFile === "string" &&
    typeof v.port === "number" &&
    (v.fork === undefined || v.fork === "upstream" || v.fork === "llama.cpp") &&
    (v.pid === undefined || typeof v.pid === "number") &&
    typeof v.startedAt === "string"
  );
}

function corruptRegistry(error: string): RegistryReadResult {
  return { kind: "corrupt", entries: [], error };
}

/**
 * Read the registry. Missing and valid-empty are open (no booted servers).
 * Corrupt JSON, wrong shape, or an invalid entry fail closed — callers must
 * not treat that as `[]` and fall through to a static upstream.
 */
export function readRegistry(path: string): RegistryReadResult {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return { kind: "missing", entries: [] };
    }
    return corruptRegistry("upstream registry could not be read");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    return corruptRegistry("upstream registry is not valid JSON");
  }
  const doc = raw as Partial<UpstreamRegistryFile> | null;
  if (
    !doc ||
    typeof doc !== "object" ||
    doc.version !== REGISTRY_VERSION ||
    !Array.isArray(doc.upstreams)
  ) {
    return corruptRegistry("upstream registry has an unsupported shape or version");
  }
  const entries: UpstreamEntry[] = [];
  for (const [index, item] of doc.upstreams.entries()) {
    if (!isUpstreamEntry(item)) {
      return corruptRegistry(`upstream registry contains an invalid upstream at index ${index}`);
    }
    entries.push(item);
  }
  return { kind: "valid", entries };
}

/**
 * Write the registry atomically (temp → rename). Creates the parent dir.
 * The caller is responsible for the merge semantics (`upsertEntry` /
 * `removeByPid`) — this function persists exactly what it is given.
 */
/**
 * Read-modify-write under the house lock. Boot and stop await between
 * the guest-book read and the write; this queue keeps both entries.
 * Corrupt state is returned and not overwritten.
 */
export async function updateRegistry(
  path: string,
  fn: (
    entries: readonly UpstreamEntry[],
  ) => readonly UpstreamEntry[] | Promise<readonly UpstreamEntry[]>,
): Promise<RegistryReadResult> {
  return withHouseLock(path, async () => {
    const state = readRegistry(path);
    if (state.kind === "corrupt") return state;
    const next = await fn(state.entries);
    writeRegistry(path, next);
    return { kind: "valid", entries: next };
  });
}

export function writeRegistry(path: string, entries: readonly UpstreamEntry[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const doc: UpstreamRegistryFile = { version: REGISTRY_VERSION, upstreams: [...entries] };
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(doc, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}

/**
 * Merge one entry into the list: replace by `id` (position preserved),
 * append when new. Never clobbers the other entries.
 */
export function upsertEntry(
  entries: readonly UpstreamEntry[],
  entry: UpstreamEntry,
): UpstreamEntry[] {
  const idx = entries.findIndex((e) => e.id === entry.id);
  if (idx === -1) return [...entries, entry];
  const next = [...entries];
  next[idx] = entry;
  return next;
}

/** Remove the entry with the given PID (stop path). No-op when absent. */
export function removeByPid(entries: readonly UpstreamEntry[], pid: number): UpstreamEntry[] {
  return entries.filter((e) => e.pid !== pid);
}

/** Remove the entry with the given id (type-agnostic stop path). No-op when absent. */
export function removeById(entries: readonly UpstreamEntry[], id: string): UpstreamEntry[] {
  return entries.filter((e) => e.id !== id);
}

/**
 * Does `entry.modelFile` refer to the same weights file as `modelFile`?
 * Exact path first, then basename — the same tolerance as `isLoadedPath`
 * (symlinked/normalized prefixes pointing at the same file).
 */
function sameModelFile(entryFile: string, modelFile: string): boolean {
  return entryFile === modelFile || basename(entryFile) === basename(modelFile);
}

/**
 * All entries matching `modelFile`, in resolve order:
 * most-recently-booted first (`startedAt` descending), tie → lowest port.
 *
 * The lazy-validation loop (G2) walks this list probing each candidate;
 * `resolveUpstream` is its single-winner view. Pure — no I/O, no mutation.
 */
export function listUpstreams(
  entries: readonly UpstreamEntry[],
  modelFile: string,
): UpstreamEntry[] {
  return entries
    .filter((e) => sameModelFile(e.modelFile, modelFile))
    .sort((a, b) => {
      const byTime = b.startedAt.localeCompare(a.startedAt);
      return byTime !== 0 ? byTime : a.port - b.port;
    });
}

/**
 * Resolve which upstream serves `modelFile`.
 *
 * Rule: among entries matching the model —
 *   1. healthy entries only (when `healthyIds` is provided; an entry absent
 *      from the set failed its probe and is treated as stale),
 *   2. most-recently-booted first (`startedAt` descending),
 *   3. tie → lowest port.
 *
 * Returns `null` when nothing matches (or everything matched is unhealthy).
 * Pure — no I/O, no mutation; losers are not removed.
 */
export function resolveUpstream(
  entries: readonly UpstreamEntry[],
  modelFile: string,
  healthyIds?: ReadonlySet<string>,
): UpstreamEntry | null {
  const candidates = healthyIds
    ? listUpstreams(entries, modelFile).filter((e) => healthyIds.has(e.id))
    : listUpstreams(entries, modelFile);
  return candidates[0] ?? null;
}
