/**
 * Model catalog reader (ADR-0093 Phase 1).
 *
 * Scans the central model home's adapter tree (the OS-aware model store,
 * see service/paths.ts) and
 * returns the switchable models: leaf adapters that declare a weights file
 * (`identity.model.file`). Lineage-level adapters (e.g. `family.yaml`) are
 * config, not switchable models, and are excluded.
 *
 * Deliberately standalone: this is a lightweight reader in `@mba-ai/core`,
 * not the mcp-server's full `loadAdapters` (which also parses profiles and
 * warms the GGUF metadata cache). The catalog only needs the four facts a
 * switch decision requires: id, name, family, modelFile.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import YAML from "yaml";

export interface CatalogEntry {
  /** Adapter `metadata.id` — the canonical switch id. */
  readonly id: string;
  /** Adapter `metadata.name` (falls back to `id`). */
  readonly name: string;
  /** Adapter `metadata.family` (may be undefined). */
  readonly family?: string;
  /** Absolute path to the weights file, or undefined if undeclared. */
  readonly modelFile?: string;
  /**
   * Adapter `client.url` (e.g. `http://127.0.0.1:8080/v1`) — the YAML rung
   * of the probe fallback (registry → YAML → env). May carry a trailing
   * `/v1`; `resolveProbeTarget` strips it before probing.
   */
  readonly clientUrl?: string;
  /** Absolute path to the adapter YAML file itself. */
  readonly yamlPath: string;
}

function isAdapter(value: unknown): value is {
  metadata: { id: string; name?: string; family?: string };
  identity: { model?: { file?: unknown } | null };
  client?: { url?: unknown } | null;
} {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.apiVersion !== "mba.c-yard.dev/v1alpha1") return false;
  if (v.kind !== "ModelBehavioralAdapter") return false;
  if (typeof v.metadata !== "object" || v.metadata === null) return false;
  if (typeof (v.metadata as Record<string, unknown>).id !== "string") return false;
  if (typeof v.identity !== "object" || v.identity === null) return false;
  return true;
}

function scanYamlFiles(dir: string, out: string[] = []): string[] {
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

/**
 * Read the switchable-model catalog from an adapter tree.
 *
 * - Missing or non-directory `adapterDir` → `[]` (the service can boot
 *   before any model has been pulled).
 * - Adapters without `identity.model.file` (lineage-level config) are
 *   skipped, not errors.
 * - A YAML file that fails the adapter shape check throws — a corrupt
 *   adapter is a real problem, not an empty catalog.
 */
export function readModelCatalog(adapterDir: string): CatalogEntry[] {
  const stat = statSync(adapterDir, { throwIfNoEntry: false });
  if (!stat || !stat.isDirectory()) {
    return [];
  }

  const entries: CatalogEntry[] = [];
  for (const file of scanYamlFiles(adapterDir)) {
    const raw = YAML.parse(readFileSync(file, "utf8")) as unknown;
    if (!isAdapter(raw)) {
      throw new Error(`invalid MBA adapter shape in ${file}`);
    }
    const modelFile = raw.identity.model?.file;
    if (typeof modelFile !== "string" || modelFile.length === 0) {
      continue; // lineage-level adapter, not a switchable model
    }
    const meta = raw.metadata;
    const clientUrl = raw.client?.url;
    entries.push({
      id: meta.id,
      name: meta.name ?? meta.id,
      family: meta.family,
      modelFile: isAbsolute(modelFile) ? modelFile : resolve(dirname(file), modelFile),
      clientUrl: typeof clientUrl === "string" && clientUrl.length > 0 ? clientUrl : undefined,
      yamlPath: file,
    });
  }
  return entries;
}
