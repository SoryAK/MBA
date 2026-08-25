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

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";

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
  /** PID of the server process. */
  readonly pid: number;
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
  readonly upstreams: UpstreamEntry[];
}

function isUpstreamEntry(value: unknown): value is UpstreamEntry {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.serverType === "string" &&
    typeof v.modelFile === "string" &&
    typeof v.port === "number" &&
    typeof v.pid === "number" &&
    typeof v.startedAt === "string"
  );
}

/**
 * Read the registry. Missing file, corrupt JSON, or a wrong-shape document
 * all yield `[]` — a broken registry must never crash the service, it just
 * degrades to the next fallback rung (YAML → env).
 */
export function readRegistry(path: string): UpstreamEntry[] {
  if (!existsSync(path)) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return [];
  }
  const doc = raw as Partial<UpstreamRegistryFile> | null;
  if (!doc || !Array.isArray(doc.upstreams)) return [];
  return doc.upstreams.filter(isUpstreamEntry);
}

/**
 * Write the registry atomically (temp → rename). Creates the parent dir.
 * The caller is responsible for the merge semantics (`upsertEntry` /
 * `removeByPid`) — this function persists exactly what it is given.
 */
export function writeRegistry(path: string, entries: readonly UpstreamEntry[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const doc: UpstreamRegistryFile = { version: 1, upstreams: [...entries] };
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
