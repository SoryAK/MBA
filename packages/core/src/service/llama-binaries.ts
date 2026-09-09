/**
 * llama-server catalog for boot (host GPU backend, not a model fact).
 *
 * MBA does not compile llama.cpp. It finds `llama-server` binaries the
 * operator already built (PATH, common trees, then a bounded name walk),
 * tags each by the ggml backend next to it (cuda / hip / vulkan / metal /
 * cpu), and persists the list so boot does not recrawl. The daemon rescans
 * occasionally (15 minutes, `MBA_LLAMA_CATALOG_TTL_MS`) so new builds appear
 * and missing ones drop. Last choice lives in MBA state so the daemon does
 * not need a restart when the operator switches. `MBA_LLAMA_SERVER_BIN`
 * still wins when set.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir as osHomedir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import type { MachineInfo } from "./machine-info.js";
import type { MbaStorePaths } from "./config-store.js";

export const LLAMA_SERVER_CHOICE_FILENAME = "llama-server.json";
export const LLAMA_SERVER_CATALOG_FILENAME = "llama-servers.json";

/** Depth from $HOME (and similar operator trees) when scanning by name. */
export const LLAMA_SERVER_WALK_DEPTH = 10;
/** Shallower walk for /opt and /usr/local. */
export const LLAMA_SERVER_SYSTEM_WALK_DEPTH = 5;

export const DEFAULT_LLAMA_SERVER_SYSTEM_ROOTS: readonly string[] = ["/opt", "/usr/local", "/usr/bin"];

/** How long a catalog scan stays fresh. `MBA_LLAMA_CATALOG_TTL_MS=0` disables. */
export const LLAMA_SERVER_CATALOG_TTL_MS = 15 * 60 * 1000;

export type LlamaBackend = "cuda" | "hip" | "vulkan" | "metal" | "cpu";
export type GpuVendor = "nvidia" | "amd" | "apple";

export interface LlamaServerBinary {
  readonly path: string;
  readonly backend: LlamaBackend;
  readonly nickname?: string;
}

export interface LlamaServerChoice {
  readonly path: string;
  readonly backend: LlamaBackend;
  readonly updatedAt: string;
}

export interface LlamaServerCatalogFile {
  readonly scannedAt: string;
  readonly entries: readonly LlamaServerBinary[];
  readonly ignored: readonly LlamaServerBinary[];
}

export interface LlamaBinaryScan {
  readonly homedir?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly exists?: (path: string) => boolean;
  /**
   * Walk `homedir` (and `extraRoots`) for files named llama-server.
   * Off by default so resolve/boot stay cheap; daemon start turns it on.
   */
  readonly discover?: boolean;
  readonly extraRoots?: readonly string[];
  /** Extra absolute paths (persisted catalog rows). */
  readonly extraPaths?: readonly string[];
  /** Clock for staleness (tests). */
  readonly now?: number;
  /** Override `MBA_LLAMA_CATALOG_TTL_MS` / the 15-minute default. */
  readonly ttlMs?: number;
}

export interface LlamaServerSelection {
  readonly catalog: readonly LlamaServerBinary[];
  readonly selected?: LlamaServerBinary;
  readonly recommended?: LlamaBackend;
  readonly warning?: string;
  /** True when `selected` is the operator's saved default, not a guess. */
  readonly pinned?: boolean;
}

const BACKEND_LIBS: ReadonlyArray<{ readonly backend: LlamaBackend; readonly names: readonly string[] }> = [
  { backend: "cuda", names: ["libggml-cuda.so", "libggml-cuda.so.0", "libggml-cuda.dylib", "ggml-cuda.dll"] },
  { backend: "hip", names: ["libggml-hip.so", "libggml-hip.so.0", "libggml-hip.dylib", "ggml-hip.dll"] },
  { backend: "vulkan", names: ["libggml-vulkan.so", "libggml-vulkan.so.0", "libggml-vulkan.dylib", "ggml-vulkan.dll"] },
  { backend: "metal", names: ["libggml-metal.dylib", "ggml-metal.metal"] },
];

const BACKEND_SORT: Readonly<Record<LlamaBackend, number>> = {
  cuda: 0,
  hip: 1,
  vulkan: 2,
  metal: 3,
  cpu: 4,
};

const BIN_NAMES = new Set(["llama-server", "llama-server.exe"]);

/** Directories that are never llama.cpp build trees and are expensive to walk. */
const SKIP_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  ".cache",
  ".npm",
  ".nvm",
  ".pnpm-store",
  ".pnpm",
  ".yarn",
  "__pycache__",
  ".venv",
  "venv",
  ".Trash",
  "Trash",
  ".steam",
  "steamapps",
  ".wine",
  "snap",
  ".cursor-server",
  ".cursor",
  "Caches",
  "model_hub",
  ".mozilla",
  ".thunderbird",
  "flatpak",
  ".cargo",
  ".rustup",
  ".gradle",
  ".m2",
  ".nuget",
  "lost+found",
  ".thumbnails",
  ".nv",
  ".var",
  ".docker",
  ".vscode",
  ".vscode-server",
  "site-packages",
  ".tox",
  ".mypy_cache",
  ".pytest_cache",
  ".next",
  ".turbo",
]);

function liveExists(path: string): boolean {
  return existsSync(path);
}

function liveRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** State file for the last llama-server the operator booted. */
export function llamaServerChoicePath(paths: MbaStorePaths): string {
  return join(paths.baseDir, "mba", LLAMA_SERVER_CHOICE_FILENAME);
}

export function llamaServerCatalogPath(paths: MbaStorePaths): string {
  return join(paths.baseDir, "mba", LLAMA_SERVER_CATALOG_FILENAME);
}

export function readLlamaServerChoice(paths: MbaStorePaths): LlamaServerChoice | undefined {
  const file = llamaServerChoicePath(paths);
  if (!existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const rec = parsed as Record<string, unknown>;
    if (typeof rec.path !== "string" || rec.path.length === 0) return undefined;
    if (!isLlamaBackend(rec.backend)) return undefined;
    const updatedAt = typeof rec.updatedAt === "string" ? rec.updatedAt : "";
    return { path: rec.path, backend: rec.backend, updatedAt };
  } catch {
    return undefined;
  }
}

export function writeLlamaServerChoice(paths: MbaStorePaths, choice: LlamaServerBinary): void {
  const file = llamaServerChoicePath(paths);
  mkdirSync(dirname(file), { recursive: true });
  const body: LlamaServerChoice = {
    path: choice.path,
    backend: choice.backend,
    updatedAt: new Date().toISOString(),
  };
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(body, null, 2) + "\n", "utf8");
  renameSync(tmp, file);
}

export function readLlamaServerCatalog(paths: MbaStorePaths): LlamaServerCatalogFile | undefined {
  const file = llamaServerCatalogPath(paths);
  if (!existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const rec = parsed as Record<string, unknown>;
    const scannedAt = typeof rec.scannedAt === "string" ? rec.scannedAt : "";
    if (!Array.isArray(rec.entries)) return undefined;
    const entries = rec.entries.map(parseCatalogBinary).filter((b): b is LlamaServerBinary => b !== undefined);
    const ignored = Array.isArray(rec.ignored)
      ? rec.ignored.map(parseCatalogBinary).filter((b): b is LlamaServerBinary => b !== undefined)
      : [];
    return { scannedAt, entries, ignored };
  } catch {
    return undefined;
  }
}

export function writeLlamaServerCatalog(
  paths: MbaStorePaths,
  catalog: {
    readonly entries: readonly LlamaServerBinary[];
    readonly ignored?: readonly LlamaServerBinary[];
    readonly scannedAt?: string;
  },
): void {
  const file = llamaServerCatalogPath(paths);
  mkdirSync(dirname(file), { recursive: true });
  const body: LlamaServerCatalogFile = {
    scannedAt: catalog.scannedAt ?? new Date().toISOString(),
    entries: catalog.entries.map(serializeCatalogBinary),
    ignored: (catalog.ignored ?? []).map(serializeCatalogBinary),
  };
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(body, null, 2) + "\n", "utf8");
  renameSync(tmp, file);
}

export function llamaServerCatalogTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.MBA_LLAMA_CATALOG_TTL_MS;
  if (raw === undefined || raw === "") return LLAMA_SERVER_CATALOG_TTL_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return LLAMA_SERVER_CATALOG_TTL_MS;
  return n;
}

/** True when a full name-walk should run again. `ttlMs <= 0` never goes stale. */
export function isLlamaServerCatalogStale(
  catalog: LlamaServerCatalogFile | undefined,
  now: number = Date.now(),
  ttlMs: number = LLAMA_SERVER_CATALOG_TTL_MS,
): boolean {
  if (ttlMs <= 0) return false;
  if (!catalog || catalog.scannedAt.length === 0) return true;
  const scanned = Date.parse(catalog.scannedAt);
  if (!Number.isFinite(scanned)) return true;
  return now - scanned >= ttlMs;
}

function isLlamaBackend(value: unknown): value is LlamaBackend {
  return value === "cuda" || value === "hip" || value === "vulkan" || value === "metal" || value === "cpu";
}

export function normalizeLlamaServerNickname(raw: string): string | undefined {
  const t = raw.trim().replace(/\s+/g, " ");
  if (t.length === 0) return undefined;
  return t.slice(0, 40);
}

function parseCatalogBinary(row: unknown): LlamaServerBinary | undefined {
  if (typeof row !== "object" || row === null || Array.isArray(row)) return undefined;
  const item = row as Record<string, unknown>;
  if (typeof item.path !== "string" || item.path.length === 0) return undefined;
  if (!isLlamaBackend(item.backend)) return undefined;
  const nickname =
    typeof item.nickname === "string" ? normalizeLlamaServerNickname(item.nickname) : undefined;
  return nickname ? { path: item.path, backend: item.backend, nickname } : { path: item.path, backend: item.backend };
}

function serializeCatalogBinary(b: LlamaServerBinary): LlamaServerBinary {
  return b.nickname ? { path: b.path, backend: b.backend, nickname: b.nickname } : { path: b.path, backend: b.backend };
}

function nicknameMap(file: LlamaServerCatalogFile | undefined): Map<string, string> {
  const nicks = new Map<string, string>();
  if (!file) return nicks;
  for (const row of [...file.entries, ...file.ignored]) {
    if (row.nickname) nicks.set(liveRealpath(row.path), row.nickname);
  }
  return nicks;
}

function withNickname(b: LlamaServerBinary, nicks: Map<string, string>): LlamaServerBinary {
  const nickname = nicks.get(liveRealpath(b.path));
  return nickname ? { ...b, nickname } : { path: b.path, backend: b.backend };
}

export function decorateLlamaServers(
  live: readonly LlamaServerBinary[],
  file: LlamaServerCatalogFile | undefined,
): LlamaServerBinary[] {
  const ignored = new Set((file?.ignored ?? []).map((e) => liveRealpath(e.path)));
  const nicks = nicknameMap(file);
  return live.filter((b) => !ignored.has(liveRealpath(b.path))).map((b) => withNickname(b, nicks));
}

/**
 * Backend of a llama-server from sibling ggml libs (the wrapper binary
 * itself is tiny; cuda/hip/vulkan live next to it).
 */
export function inspectLlamaBackend(binPath: string, exists: (path: string) => boolean = liveExists): LlamaBackend {
  const dir = dirname(binPath);
  for (const row of BACKEND_LIBS) {
    if (row.names.some((name) => exists(join(dir, name)))) return row.backend;
  }
  return "cpu";
}

/** Ollama ships its own llama-server; MBA boots a standalone llama.cpp build. */
export function isBundledOllamaLlamaServer(path: string): boolean {
  const n = path.replace(/\\/g, "/").toLowerCase();
  return /(^|\/)ollama(\/|$)/.test(n);
}

function posixParts(path: string): string[] {
  return path.replace(/\\/g, "/").split("/").filter(Boolean);
}

/** Known install locations. PATH entries come first after the env override. */
export function llamaServerCandidatePaths(homedir: string, env: NodeJS.ProcessEnv): string[] {
  const out: string[] = [];
  const override = env.MBA_LLAMA_SERVER_BIN;
  if (override && override.length > 0) out.push(override);

  const pathEnv = env.PATH ?? env.Path ?? "";
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    out.push(join(dir, "llama-server"), join(dir, "llama-server.exe"));
  }

  out.push(
    join(homedir, ".local", "bin", "llama-server"),
    join(homedir, "llama.cpp", "build", "bin", "llama-server"),
    join(homedir, "llama.cpp", "build-cuda", "bin", "llama-server"),
    join(homedir, "llama.cpp", "build-hip", "bin", "llama-server"),
    join(homedir, "llama.cpp", "build-vulkan", "bin", "llama-server"),
    join(homedir, "llama-cuda", "build", "bin", "llama-server"),
    join(homedir, "llama-hip", "build", "bin", "llama-server"),
    "/usr/local/bin/llama-server",
    "/usr/bin/llama-server",
  );
  return out;
}

function inodeKey(path: string): string | undefined {
  try {
    const st = statSync(path);
    return `${st.dev}:${st.ino}`;
  } catch {
    return undefined;
  }
}

/**
 * Bounded directory walk for files named llama-server. Follows a symlinked
 * root (so a linked $HOME still works) but does not recurse into symlink
 * directories. Skips noisy trees (node_modules, .git, .cache, …).
 */
export function walkLlamaServerFiles(root: string, maxDepth: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (stack.length > 0) {
    const { dir, depth } = stack.pop()!;
    if (depth > maxDepth) continue;
    const key = inodeKey(dir);
    if (key !== undefined) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    let entries;
    try {
      if (!statSync(dir).isDirectory()) continue;
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const child = join(dir, ent.name);
      if (ent.isSymbolicLink()) {
        if (BIN_NAMES.has(ent.name)) out.push(child);
        continue;
      }
      if (ent.isDirectory()) {
        if (SKIP_DIR_NAMES.has(ent.name)) continue;
        stack.push({ dir: child, depth: depth + 1 });
        continue;
      }
      if (BIN_NAMES.has(ent.name)) out.push(child);
    }
  }
  return out;
}

function systemWalkDepth(root: string): number {
  const n = root.replace(/\\/g, "/").replace(/\/+$/, "");
  if (n === "/usr/bin" || n.endsWith("/usr/bin")) return 1;
  return LLAMA_SERVER_SYSTEM_WALK_DEPTH;
}

/** Name-scan roots: $HOME plus optional system prefixes. */
export function discoverLlamaServerPaths(scan: LlamaBinaryScan = {}): string[] {
  const homedir = scan.homedir ?? osHomedir();
  const extraRoots = scan.extraRoots ?? [];
  const found: string[] = [];
  found.push(...walkLlamaServerFiles(homedir, LLAMA_SERVER_WALK_DEPTH));
  for (const root of extraRoots) {
    if (!root || root === homedir) continue;
    found.push(...walkLlamaServerFiles(root, systemWalkDepth(root)));
  }
  return found;
}

function collectRawPaths(scan: LlamaBinaryScan): string[] {
  const homedir = scan.homedir ?? osHomedir();
  const env = scan.env ?? process.env;
  const raw = [
    ...llamaServerCandidatePaths(homedir, env),
    ...(scan.extraPaths ?? []),
  ];
  if (scan.discover) {
    raw.push(...discoverLlamaServerPaths(scan));
  }
  return raw;
}

function sortCatalog(catalog: LlamaServerBinary[]): LlamaServerBinary[] {
  return [...catalog].sort((a, b) => {
    const byBackend = BACKEND_SORT[a.backend] - BACKEND_SORT[b.backend];
    if (byBackend !== 0) return byBackend;
    return a.path.localeCompare(b.path);
  });
}

export function listLlamaServers(scan: LlamaBinaryScan = {}): LlamaServerBinary[] {
  const exists = scan.exists ?? liveExists;
  const seen = new Set<string>();
  const catalog: LlamaServerBinary[] = [];
  for (const raw of collectRawPaths(scan)) {
    if (!exists(raw)) continue;
    if (isBundledOllamaLlamaServer(raw)) continue;
    const resolved = liveRealpath(raw);
    if (isBundledOllamaLlamaServer(resolved)) continue;
    if (posixParts(resolved).some((p) => SKIP_DIR_NAMES.has(p))) continue;
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    catalog.push({ path: resolved, backend: inspectLlamaBackend(resolved, exists) });
  }
  return sortCatalog(catalog);
}

/**
 * Walk the machine, write `llama-servers.json`, return the live list.
 * Cheap PATH / known-tree hits are merged in so a scan never hides them.
 */
export function refreshLlamaServerCatalog(
  paths: MbaStorePaths,
  scan: LlamaBinaryScan = {},
): LlamaServerBinary[] {
  const extraRoots = scan.extraRoots ?? DEFAULT_LLAMA_SERVER_SYSTEM_ROOTS;
  const previous = readLlamaServerCatalog(paths);
  const live = listLlamaServers({ ...scan, discover: true, extraRoots });
  const ignoredPaths = new Set((previous?.ignored ?? []).map((e) => liveRealpath(e.path)));
  const nicks = nicknameMap(previous);
  const entries = live.filter((b) => !ignoredPaths.has(liveRealpath(b.path))).map((b) => withNickname(b, nicks));
  const ignored = (previous?.ignored ?? []).map((row) => {
    const found = live.find((b) => samePath(b.path, row.path));
    const nickname = row.nickname ?? nicks.get(liveRealpath(row.path));
    const base = found ?? { path: liveRealpath(row.path), backend: row.backend };
    return nickname ? { ...base, nickname } : { path: base.path, backend: base.backend };
  });
  writeLlamaServerCatalog(paths, { entries, ignored });
  return entries;
}

function catalogPathKey(entries: readonly LlamaServerBinary[]): string {
  return entries.map((e) => e.path).join("\0");
}

/** Drop catalog rows whose files are gone. Does not walk. Keeps `scannedAt`. */
export function pruneMissingLlamaServerCatalog(
  paths: MbaStorePaths,
  exists: (path: string) => boolean = liveExists,
): LlamaServerBinary[] {
  const current = readLlamaServerCatalog(paths);
  if (!current) return [];
  const kept = current.entries.filter(
    (e) => exists(e.path) && !isBundledOllamaLlamaServer(e.path),
  );
  if (kept.length !== current.entries.length) {
    writeLlamaServerCatalog(paths, {
      entries: kept,
      ignored: current.ignored,
      scannedAt: current.scannedAt,
    });
  }
  return kept;
}

/**
 * If the saved scan is older than the TTL, walk again. Otherwise just drop
 * ghosts. A missing file is left alone so tests and a daemon that has not
 * scanned yet do not crawl $HOME on every resolve.
 */
export function ensureLlamaServerCatalog(
  paths: MbaStorePaths,
  scan: LlamaBinaryScan = {},
): LlamaServerBinary[] {
  const existing = readLlamaServerCatalog(paths);
  if (!existing) return [];
  const now = scan.now ?? Date.now();
  const ttlMs = scan.ttlMs ?? llamaServerCatalogTtlMs(scan.env);
  if (isLlamaServerCatalogStale(existing, now, ttlMs)) {
    return refreshLlamaServerCatalog(paths, scan);
  }
  return pruneMissingLlamaServerCatalog(paths, scan.exists);
}

/** Repeat `refreshLlamaServerCatalog` every TTL. No-op when TTL is 0. */
export function startLlamaServerCatalogRefresh(
  paths: MbaStorePaths,
  opts: {
    readonly ttlMs?: number;
    readonly scan?: LlamaBinaryScan;
    readonly onRefresh?: (catalog: LlamaServerBinary[], changed: boolean) => void;
    readonly onError?: (err: unknown) => void;
  } = {},
): () => void {
  const ttlMs = opts.ttlMs ?? llamaServerCatalogTtlMs(opts.scan?.env);
  if (ttlMs <= 0) return () => {};
  const timer = setInterval(() => {
    try {
      const before = catalogPathKey(readLlamaServerCatalog(paths)?.entries ?? []);
      const catalog = refreshLlamaServerCatalog(paths, opts.scan);
      opts.onRefresh?.(catalog, before !== catalogPathKey(catalog));
    } catch (err) {
      opts.onError?.(err);
    }
  }, ttlMs);
  timer.unref();
  return () => clearInterval(timer);
}

const NVIDIA_RE = /nvidia|geforce|rtx|gtx|quadro|tesla|titan/i;
const AMD_RE = /\bamd\b|radeon|strix|instinct|ryzen ai/i;
const APPLE_RE = /\bapple\b|\bm[1-4](?:\s|$)|metal/i;

export function gpuVendors(info: MachineInfo | undefined): ReadonlySet<GpuVendor> {
  const out = new Set<GpuVendor>();
  if (!info) return out;
  if (info.os === "darwin") out.add("apple");
  for (const gpu of info.gpus ?? []) {
    const name = gpu.name ?? "";
    if (NVIDIA_RE.test(name)) out.add("nvidia");
    if (AMD_RE.test(name)) out.add("amd");
    if (APPLE_RE.test(name)) out.add("apple");
  }
  return out;
}

export function recommendBackend(
  vendors: ReadonlySet<GpuVendor>,
  catalog: readonly LlamaServerBinary[],
): LlamaBackend | undefined {
  const have = new Set(catalog.map((b) => b.backend));
  if (vendors.has("nvidia") && have.has("cuda")) return "cuda";
  if (vendors.has("amd") && have.has("hip")) return "hip";
  if (vendors.has("apple") && have.has("metal")) return "metal";
  if (vendors.size > 0 && have.has("vulkan")) return "vulkan";
  return catalog[0]?.backend;
}

export function binaryMismatchWarning(
  backend: LlamaBackend,
  vendors: ReadonlySet<GpuVendor>,
): string | undefined {
  if (vendors.size === 0) return undefined;
  if (backend === "cuda" && !vendors.has("nvidia")) return "CUDA build; no NVIDIA GPU detected";
  if (backend === "hip" && !vendors.has("amd")) return "HIP build; no AMD GPU detected";
  if (backend === "metal" && !vendors.has("apple")) return "Metal build; not an Apple GPU host";
  if (backend === "cpu") return "CPU-only llama-server; GPU is present";
  return undefined;
}

function samePath(a: string, b: string): boolean {
  return liveRealpath(a) === liveRealpath(b);
}

function emptyCatalog(): LlamaServerCatalogFile {
  return { scannedAt: "", entries: [], ignored: [] };
}

function findBinaryIndex(rows: readonly LlamaServerBinary[], path: string): number {
  return rows.findIndex((b) => samePath(b.path, path));
}

/**
 * HTTP boot may only spawn a path the operator already listed. Ignored
 * catalog rows are refused. An empty catalog still allows a first-boot
 * `llama-server` path (PATH / `MBA_LLAMA_SERVER_BIN`) so the scan can catch up.
 */
export function llamaBootBinaryError(paths: MbaStorePaths, binaryPath: string): string | undefined {
  if (!BIN_NAMES.has(basename(binaryPath))) {
    return "body.binaryPath must be a llama-server binary";
  }
  const file = readLlamaServerCatalog(paths);
  if (findBinaryIndex(file?.ignored ?? [], binaryPath) >= 0) {
    return "body.binaryPath is ignored — restore it in the catalog first";
  }
  const live = file?.entries ?? [];
  if (live.length === 0) return undefined;
  if (findBinaryIndex(live, binaryPath) < 0) {
    return "body.binaryPath must be a live catalog llama-server";
  }
  return undefined;
}

export function nicknameLlamaServer(
  paths: MbaStorePaths,
  path: string,
  nicknameRaw: string,
): LlamaServerCatalogFile {
  const current = readLlamaServerCatalog(paths) ?? emptyCatalog();
  const nickname = normalizeLlamaServerNickname(nicknameRaw);
  const patch = (row: LlamaServerBinary): LlamaServerBinary =>
    nickname ? { path: row.path, backend: row.backend, nickname } : { path: row.path, backend: row.backend };
  const ei = findBinaryIndex(current.entries, path);
  if (ei >= 0) {
    const entries = current.entries.slice();
    entries[ei] = patch(entries[ei]!);
    const next = { ...current, entries };
    writeLlamaServerCatalog(paths, next);
    return next;
  }
  const ii = findBinaryIndex(current.ignored, path);
  if (ii >= 0) {
    const ignored = current.ignored.slice();
    ignored[ii] = patch(ignored[ii]!);
    const next = { ...current, ignored };
    writeLlamaServerCatalog(paths, next);
    return next;
  }
  throw new Error(`llama-server not in catalog: ${path}`);
}

export function ignoreLlamaServer(paths: MbaStorePaths, path: string): LlamaServerCatalogFile {
  const current = readLlamaServerCatalog(paths) ?? emptyCatalog();
  if (findBinaryIndex(current.ignored, path) >= 0) return current;
  const ei = findBinaryIndex(current.entries, path);
  if (ei < 0) throw new Error(`llama-server not in catalog: ${path}`);
  const moved = current.entries[ei]!;
  const next = {
    ...current,
    entries: current.entries.filter((_, i) => i !== ei),
    ignored: [...current.ignored, moved],
  };
  writeLlamaServerCatalog(paths, next);
  return next;
}

export function restoreLlamaServer(paths: MbaStorePaths, path: string): LlamaServerCatalogFile {
  const current = readLlamaServerCatalog(paths) ?? emptyCatalog();
  const ii = findBinaryIndex(current.ignored, path);
  if (ii < 0) throw new Error(`llama-server is not removed: ${path}`);
  const moved = current.ignored[ii]!;
  const ignored = current.ignored.filter((_, i) => i !== ii);
  const entries =
    findBinaryIndex(current.entries, path) >= 0 || !liveExists(moved.path)
      ? current.entries
      : sortCatalog([...current.entries, moved]);
  const next = { ...current, entries, ignored };
  writeLlamaServerCatalog(paths, next);
  return next;
}

export function useLlamaServer(paths: MbaStorePaths, path: string): LlamaServerCatalogFile {
  const current = readLlamaServerCatalog(paths) ?? emptyCatalog();
  const ei = findBinaryIndex(current.entries, path);
  if (ei < 0) throw new Error(`llama-server not in catalog: ${path}`);
  const row = current.entries[ei]!;
  writeLlamaServerChoice(paths, { path: row.path, backend: row.backend });
  return current;
}

export function llamaServerCatalogView(paths: MbaStorePaths): {
  readonly scannedAt: string;
  readonly binaries: readonly LlamaServerBinary[];
  readonly ignored: readonly LlamaServerBinary[];
  readonly selected?: string;
} {
  const file = readLlamaServerCatalog(paths);
  const choice = readLlamaServerChoice(paths);
  const binaries = file?.entries ?? [];
  const selected =
    choice && binaries.some((b) => samePath(b.path, choice.path)) ? choice.path : undefined;
  return {
    scannedAt: file?.scannedAt ?? "",
    binaries,
    ignored: file?.ignored ?? [],
    selected,
  };
}

/**
 * Choose which catalog entry to spawn. Last successful boot wins; then
 * `MBA_LLAMA_SERVER_BIN`; then a backend that matches detected GPUs; then
 * the first catalog row.
 *
 * Pass `paths` so a persisted scan (written at daemon start) is merged in
 * without walking the disk again. A stale catalog triggers one more walk.
 * Ignored builds stay out of the picker; nicknames ride along from the file.
 */
export function selectLlamaServer(opts: {
  readonly lastPath?: string;
  readonly machineInfo?: MachineInfo;
  readonly scan?: LlamaBinaryScan;
  readonly paths?: MbaStorePaths;
}): LlamaServerSelection {
  const env = opts.scan?.env ?? process.env;
  if (opts.paths) ensureLlamaServerCatalog(opts.paths, opts.scan);
  const file = opts.paths ? readLlamaServerCatalog(opts.paths) : undefined;
  const extraPaths = [
    ...(opts.scan?.extraPaths ?? []),
    ...(file?.entries ?? []).map((e) => e.path),
  ];
  const catalog = decorateLlamaServers(listLlamaServers({ ...opts.scan, extraPaths }), file);
  const vendors = gpuVendors(opts.machineInfo);
  const recommended = recommendBackend(vendors, catalog);

  const override = env.MBA_LLAMA_SERVER_BIN;
  let selected: LlamaServerBinary | undefined;
  if (opts.lastPath && opts.lastPath.length > 0) {
    selected = catalog.find((b) => samePath(b.path, opts.lastPath!));
  }
  if (!selected && override && override.length > 0) {
    selected =
      catalog.find((b) => samePath(b.path, override)) ??
      (opts.scan?.exists?.(override) || liveExists(override)
        ? { path: liveRealpath(override), backend: inspectLlamaBackend(override, opts.scan?.exists ?? liveExists) }
        : { path: override, backend: inspectLlamaBackend(override, opts.scan?.exists ?? liveExists) });
  }
  if (!selected && recommended) {
    selected = catalog.find((b) => b.backend === recommended);
  }
  if (!selected) selected = catalog[0];

  const warning = selected ? binaryMismatchWarning(selected.backend, vendors) : undefined;
  const pinned = Boolean(opts.lastPath && selected && samePath(selected.path, opts.lastPath));
  return { catalog, selected, recommended, warning, pinned };
}
