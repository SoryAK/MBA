/**
 * Adapter YAML migration (local filesystem only).
 *
 * Rewrites old `apiVersion` values to the current canonical value. Operates
 * directly on the adapter tree so it works even when the MBA service is not
 * running.
 *
 * Defaults to dry-run; pass `--write` to mutate files.
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { MBA_API_VERSION } from "../mba/loader.js";

/** Old apiVersion values that should be rewritten to the current canonical. */
export const LEGACY_API_VERSIONS = ["mba.ai/v1alpha1"] as const;

export interface MigrateAdaptersOptions {
  /** Adapter tree root. */
  readonly adapterDir: string;
  /** When true, only report what would change; do not write files. */
  readonly dryRun: boolean;
  /** Optional override of the canonical apiVersion to write. */
  readonly canonicalVersion?: string;
}

export interface MigrateAdaptersResult {
  /** Files that were (or would be) rewritten. */
  readonly changed: string[];
  /** Files that were readable but did not need rewriting. */
  readonly unchanged: string[];
  /** Files that could not be read or parsed. */
  readonly errors: string[];
}

function scanYamlFiles(dir: string, out: string[] = []): string[] {
  const stat = statSync(dir, { throwIfNoEntry: false });
  if (!stat || !stat.isDirectory()) return out;

  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      scanYamlFiles(full, out);
    } else if (entry.isFile() && entry.name.endsWith(".yaml")) {
      out.push(full);
    }
  }
  return out;
}

function rewriteApiVersionLine(text: string, canonical: string): string | null {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const match = line.match(/^(\s*apiVersion\s*:\s*)(.+?)\s*$/);
    if (!match) continue;
    const value = match[2]!;
    if (value === canonical) continue;
    if (!LEGACY_API_VERSIONS.includes(value as (typeof LEGACY_API_VERSIONS)[number])) continue;
    lines[i] = `${match[1]!}${canonical}`;
    return lines.join("\n");
  }
  return null;
}

export function migrateAdapters(options: MigrateAdaptersOptions): MigrateAdaptersResult {
  const canonical = options.canonicalVersion ?? MBA_API_VERSION;
  const changed: string[] = [];
  const unchanged: string[] = [];
  const errors: string[] = [];

  for (const file of scanYamlFiles(options.adapterDir)) {
    try {
      const text = readFileSync(file, "utf8");
      const rewritten = rewriteApiVersionLine(text, canonical);
      if (rewritten === null) {
        unchanged.push(file);
        continue;
      }
      changed.push(file);
      if (!options.dryRun) {
        ensureParentDir(file);
        writeFileSync(file, rewritten, "utf8");
      }
    } catch (err) {
      errors.push(`${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { changed, unchanged, errors };
}

function ensureParentDir(file: string): void {
  const dir = dirname(file);
  const stat = statSync(dir, { throwIfNoEntry: false });
  if (!stat) {
    // This should not happen because we scanned existing files, but keep the
    // typechecker happy and guard against races.
    throw new Error(`parent directory disappeared: ${dir}`);
  }
}
