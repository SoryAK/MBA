/**
 * Bounded walk + fuzzy rank for local GGUF files (mba migrate).
 *
 * The CLI lists; the daemon writes. Scan never copies and never hashes
 * whole files — listing 18 GiB weights by sha256 would stall the picker.
 * Already-in-hub skip is path or inode (a hardlinked adopt shares inode).
 */

import { readdirSync, realpathSync, statSync } from "node:fs";
import { homedir as osHomedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { parseGgufMetadata } from "./gguf-metadata.js";
import { quantFromFilename } from "./gguf-profile.js";

/** Depth from the scan root. HuggingFace hub layout is ~5; keep a little headroom. */
export const GGUF_WALK_DEPTH = 8;

const SKIP_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  ".svn",
  ".hg",
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
]);

export interface FoundGguf {
  readonly path: string;
  readonly fileName: string;
  readonly bytes: number;
  readonly quant?: string;
  readonly ggufName?: string;
}

export interface CatalogSkip {
  readonly paths: ReadonlySet<string>;
  readonly inodes: ReadonlySet<string>;
}

function inodeKey(path: string): string | undefined {
  try {
    const st = statSync(path);
    return `${st.dev}:${st.ino}`;
  } catch {
    return undefined;
  }
}

function realOrAbs(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function ggufGeneralName(path: string): string | undefined {
  try {
    const meta = parseGgufMetadata(path);
    const n = meta.fields["general.name"];
    return typeof n === "string" && n.length > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Paths and inodes already in the adapter catalog (`GET /models` `modelFile`).
 * A later adopt that hardlinked into the hub matches on inode.
 */
export function catalogSkipFromModelFiles(
  modelFiles: readonly (string | undefined)[],
): CatalogSkip {
  const paths = new Set<string>();
  const inodes = new Set<string>();
  for (const file of modelFiles) {
    if (!file || file.length === 0) continue;
    paths.add(realOrAbs(file));
    const key = inodeKey(file);
    if (key) inodes.add(key);
  }
  return { paths, inodes };
}

export function isAlreadyInHub(path: string, skip: CatalogSkip): boolean {
  if (skip.paths.has(realOrAbs(path))) return true;
  const key = inodeKey(path);
  return key !== undefined && skip.inodes.has(key);
}

/** Default find roots: HF hub cache and ~/models. Missing dirs are omitted. */
export function defaultFindRoots(homedir = osHomedir()): string[] {
  return [join(homedir, ".cache", "huggingface", "hub"), join(homedir, "models")].filter((dir) => {
    try {
      return statSync(dir).isDirectory();
    } catch {
      return false;
    }
  });
}

function pushGguf(out: FoundGguf[], path: string): void {
  let bytes = 0;
  try {
    const st = statSync(path);
    if (!st.isFile()) return;
    bytes = st.size;
  } catch {
    return;
  }
  const fileName = basename(path);
  out.push({
    path: resolve(path),
    fileName,
    bytes,
    quant: quantFromFilename(fileName),
    ggufName: ggufGeneralName(path),
  });
}

/**
 * Walk `root` for `*.gguf`. Follows a symlinked root and symlink files;
 * does not recurse into symlink directories. Skips noisy trees.
 */
export function scanGgufs(
  root: string,
  opts?: { maxDepth?: number },
): FoundGguf[] {
  const maxDepth = opts?.maxDepth ?? GGUF_WALK_DEPTH;
  const out: FoundGguf[] = [];
  const seen = new Set<string>();
  let start: string;
  try {
    start = realpathSync(root);
  } catch {
    return [];
  }
  const stack: Array<{ dir: string; depth: number }> = [{ dir: start, depth: 0 }];
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
        if (ent.name.toLowerCase().endsWith(".gguf")) pushGguf(out, child);
        continue;
      }
      if (ent.isDirectory()) {
        if (SKIP_DIR_NAMES.has(ent.name)) continue;
        stack.push({ dir: child, depth: depth + 1 });
        continue;
      }
      if (ent.isFile() && ent.name.toLowerCase().endsWith(".gguf")) {
        pushGguf(out, child);
      }
    }
  }
  return out;
}

/**
 * Subsequence score. 0 = no match. Higher is better.
 * Empty query matches everything with score 1.
 */
export function fuzzyScore(haystack: string, query: string): number {
  if (query.length === 0) return 1;
  const h = haystack.toLowerCase();
  const q = query.toLowerCase();
  let hi = 0;
  let score = 0;
  let consecutive = 0;
  let first = -1;
  for (let qi = 0; qi < q.length; qi++) {
    const found = h.indexOf(q.charAt(qi), hi);
    if (found < 0) return 0;
    if (first < 0) first = found;
    if (found === hi) consecutive += 1;
    else consecutive = 1;
    score += consecutive * 8;
    if (found === 0 || /[^a-z0-9]/.test(h.charAt(found - 1))) score += 4;
    hi = found + 1;
  }
  return score * 1000 - first * 2 - h.length;
}

export function rankGgufs(files: readonly FoundGguf[], query: string): FoundGguf[] {
  const q = query.trim();
  const scored = files.map((file) => {
    const parent = basename(dirname(file.path));
    const s = Math.max(
      fuzzyScore(file.fileName, q),
      fuzzyScore(parent, q),
      file.ggufName ? fuzzyScore(file.ggufName, q) : 0,
    );
    return { file, s };
  });
  return scored
    .filter((row) => row.s > 0)
    .sort((a, b) => b.s - a.s || a.file.fileName.localeCompare(b.file.fileName))
    .map((row) => row.file);
}
