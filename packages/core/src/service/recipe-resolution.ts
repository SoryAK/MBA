/**
 * Shared server-recipe resolution chain (R1 extraction).
 *
 * Both the one-shot `resolve-server-recipe` CLI (sourced by the C-Yard boot
 * script) and the in-daemon `resolveBootRecipe` (server plane) need the SAME
 * effective recipe for a weights file — the 4-rung merge the proxy uses at
 * runtime. Before this extraction the two entry points each re-implemented the
 * chain (catalog lookup → declared identity → `resolveMbaConfig` →
 * `sanitizeLlamaCppServerFlags` → `buildLlamaServerFlags`), so a fix to one
 * could silently drift from the other. This module is the single source of the
 * chain; both entry points are now thin wrappers over `resolveRecipe`.
 *
 * Pure-ish: fs I/O is confined to the catalog + adapter-YAML reads. It throws
 * when no adapter under `adapterDir` declares `modelFile` — each wrapper maps
 * that to its own error surface (CLI `fail()` / route 404).
 */

import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import YAML from "yaml";
import {
  buildLlamaServerFlags,
  resolveMbaConfig,
  sanitizeLlamaCppServerFlags,
  type MbaResolvedConfig,
} from "../mba/index.js";
import { readModelCatalog, type CatalogEntry } from "./model-catalog.js";

/** The resolution context knobs (harness/ide/runtime) for env-folder selection. */
export interface RecipeResolutionContext {
  readonly harness: string;
  readonly ide: string;
  readonly serverRuntime: string;
}

/** The fully-resolved recipe for one weights file. */
export interface ResolvedRecipe {
  /** Adapter `metadata.id` (the canonical model id). */
  readonly modelId: string;
  /** Absolute GGUF path the server will load. */
  readonly modelFile: string;
  /** Adapters root the catalog was read from. */
  readonly adapterDir: string;
  /** Absolute path to the matching adapter YAML. */
  readonly yamlPath: string;
  /** Catalog `name` (metadata.name, falls back to id) — the human label. */
  readonly catalogName: string;
  /** Declared `identity.model.name` (exact-equality key for the resolver). */
  readonly declaredName?: string;
  /** Declared `identity.model.family`. */
  readonly declaredFamily?: string;
  /** The raw 4-rung merge result (profile, selectedIds, diagnostics, …). */
  readonly resolved: MbaResolvedConfig;
  /** Fully-populated, in-range LlamaCppServerFlags (post-sanitize). */
  readonly flags: ReturnType<typeof sanitizeLlamaCppServerFlags>["flags"];
  /** Flags dropped by the sanitizer (out of range / unknown). */
  readonly dropped: ReturnType<typeof sanitizeLlamaCppServerFlags>["dropped"];
  /** Flags clamped by the sanitizer. */
  readonly clamped: ReturnType<typeof sanitizeLlamaCppServerFlags>["clamped"];
  /** Tuning CLI args (from `buildLlamaServerFlags`) — deployment facts excluded. */
  readonly cliArgs: string[];
}

/**
 * Resolve the effective llama.cpp recipe for `modelFile` from the adapter tree.
 *
 * @throws {Error} when no adapter under `adapterDir` declares `modelFile`
 *   (the model is not in the MBA tree).
 */
export function resolveRecipe(
  modelFile: string,
  adapterDir: string,
  ctx: RecipeResolutionContext,
): ResolvedRecipe {
  const catalog = readModelCatalog(adapterDir);
  const entry: CatalogEntry | undefined = catalog.find((c) => c.modelFile === modelFile);
  if (!entry) {
    throw new Error(`no adapter under ${adapterDir} declares model file ${modelFile}`);
  }

  // The resolver matches on identity.model.name (exact equality), so feed it
  // the declared name, not the .gguf basename (which may carry a quant suffix
  // the declared name omits).
  let declaredName: string | undefined;
  let declaredFamily: string | undefined;
  try {
    const raw = YAML.parse(readFileSync(entry.yamlPath, "utf8")) as {
      identity?: { model?: { name?: string; family?: string } };
    };
    declaredName = raw.identity?.model?.name;
    declaredFamily = raw.identity?.model?.family;
  } catch {
    // Unreadable/malformed YAML — fall through to the catalog name below.
  }

  // resolveMbaConfig wants the MBA *base* dir (parent of `adapters/`); the
  // catalog wants the adapters dir itself. Keep the two distinct.
  const mbaBaseDir = dirname(adapterDir);
  const resolved = resolveMbaConfig(mbaBaseDir, {
    modelName: declaredName ?? entry.name,
    modelFamily: declaredFamily,
    harness: ctx.harness,
    ide: ctx.ide,
    serverRuntime: ctx.serverRuntime,
  });

  const { flags, dropped, clamped } = sanitizeLlamaCppServerFlags(resolved.server["llama.cpp"]);
  const cliArgs = buildLlamaServerFlags(flags);

  return {
    modelId: entry.id,
    modelFile,
    adapterDir,
    yamlPath: entry.yamlPath,
    catalogName: entry.name,
    declaredName,
    declaredFamily,
    resolved,
    flags,
    dropped,
    clamped,
    cliArgs,
  };
}
