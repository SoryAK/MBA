/**
 * MBA adapter discovery and environment-folder selection (ADR-0084 / ADR-0091).
 *
 * Filesystem-facing helpers: scanning the adapter tree, loading rule-class
 * registries, and selecting environment override folders. Split out of
 * resolver.ts (Modularity Auditor: one responsibility per file).
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import type { MbaResolutionContext } from "./types.js";
import { loadAdapterYaml } from "./loader.js";
import { isRuleClassRegistry, type RuleClassRegistry } from "../bcb/rule-classes.js";
import type { AdapterEntry } from "./adapter-identity.js";

/**
 * The four binding file types an environment override folder may contain
 * (ADR-0091). Maps the binding key to its on-disk file name. An environment
 * folder holds only the files it overrides; absent files inherit from lower
 * rungs. A `profile` is deliberately NOT here — environments may only touch
 * dials, never the model's immutable facts.
 */
export const ENV_BINDING_FILES: ReadonlyArray<readonly ["bcb" | "tcb" | "structural" | "server_setup", string]> = [
  ["bcb", "bcb.jsonl"],
  ["tcb", "tcb.jsonl"],
  ["structural", "structural.json"],
  ["server_setup", "server_setup.json"],
];

/**
 * Normalize an environment-folder segment for comparison: lowercase and
 * strip non-alphanumerics, so the folder slug `llamacpp` matches the
 * runtime `llama.cpp` (and `vscode` matches `vscode`).
 */
function normalizeEnvSegment(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Environment-folder selection (ADR-0091).
 *
 * A scope folder (family or model) may contain an `environments/` directory
 * of override folders. The folder NAME is the match key:
 * `harness[+ide[+runtime]]` (e.g. `copilot+vscode+llamacpp`). Segments are
 * joined with `+` — NOT `-` — because model folder names are hyphenated
 * (e.g. `qwen3-coder-30b`) and a hyphen split would misparse them. Partial
 * names are wildcards: `copilot` matches any IDE and runtime. When several
 * folders match, the most-specific (most segments) wins. Returns the
 * selected folder path, or `undefined` when no folder matches (or none
 * exist).
 */
export function selectEnvironmentFolder(
  scopeDir: string,
  ctx: MbaResolutionContext,
): string | undefined {
  const envDir = join(scopeDir, "environments");
  const stats = statSync(envDir, { throwIfNoEntry: false });
  if (!stats || !stats.isDirectory()) return undefined;

  let names: string[];
  try {
    names = readdirSync(envDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return undefined;
  }

  const runtime = ctx.serverRuntime ?? "generic";
  const candidates: { dir: string; segments: number }[] = [];
  for (const name of names) {
    // `+`-separated: hyphens are legal inside segment values (harnesses,
    // IDEs, runtimes, and the model folders that host these are all
    // hyphenated), so `-` cannot be the delimiter.
    const parts = name.split("+").filter(Boolean);
    // Segment order: harness, ide, runtime. Each present segment must match
    // the corresponding context field (normalized, so `llamacpp` matches
    // `llama.cpp`); absent segments are wildcards.
    if (normalizeEnvSegment(parts[0]!) !== normalizeEnvSegment(ctx.harness)) continue;
    if (parts.length > 1 && normalizeEnvSegment(parts[1]!) !== normalizeEnvSegment(ctx.ide ?? "")) continue;
    if (parts.length > 2 && normalizeEnvSegment(parts[2]!) !== normalizeEnvSegment(runtime)) continue;
    candidates.push({ dir: join(envDir, name), segments: parts.length });
  }
  if (candidates.length === 0) return undefined;
  candidates.sort((a, b) => b.segments - a.segments);
  return candidates[0]!.dir;
}

/** Load a rule-class registry file (JSON). Returns an empty registry on any error. */
export function loadRuleClassRegistry(path: string): RuleClassRegistry {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  const classes =
    typeof parsed === "object" && parsed !== null && "classes" in parsed
      ? (parsed as { classes: unknown }).classes
      : parsed;
  if (!isRuleClassRegistry(classes)) {
    throw new Error("invalid rule-class registry");
  }
  return classes;
}

function scanAdapterFiles(dir: string): string[] {
  const out: string[] = [];
  const queue: string[] = [dir];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const stats = statSync(current, { throwIfNoEntry: false });
    if (!stats || !stats.isDirectory()) continue;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(full);
      } else if (entry.isFile() && (entry.name.endsWith(".yaml") || entry.name.endsWith(".yml"))) {
        out.push(full);
      }
    }
  }
  return out;
}

export function loadAdapters(dir: string): AdapterEntry[] {
  const paths = scanAdapterFiles(dir);
  return paths.map((p) => {
    const rel = relative(dir, dirname(p));
    const pathSegments = rel === "" ? [] : rel.split(sep).filter(Boolean);
    return { path: p, adapter: loadAdapterYaml(p), pathSegments };
  });
}
