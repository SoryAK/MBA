/**
 * Option C fallback context-size resolver (ADR-0093 Phase 4 refinement).
 *
 * For a catalog entry whose `client` block omits `contextSize`, resolve the
 * effective server recipe (same `resolveMbaConfig` +
 * `sanitizeLlamaCppServerFlags` path as `resolve-server-recipe.ts`) and
 * return its `ctxSize` — so the endpoint advertises the same window the
 * server actually boots with. Returns undefined on any resolution problem;
 * the sync then falls back to the historical default rather than failing the
 * whole pass.
 *
 * Shared by the one-shot CLI (`sync-endpoints.ts`) and the service watcher
 * (`main.ts`) so both paths agree on the inherited value.
 */

import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import YAML from "yaml";
import { resolveMbaConfig, sanitizeLlamaCppServerFlags } from "../mba/index.js";
import { readModelCatalog } from "./model-catalog.js";
import type { CtxSizeResolver } from "./model-endpoint-sync.js";

export function buildCtxSizeResolver(adapterDir: string): CtxSizeResolver {
  const mbaBaseDir = dirname(adapterDir);
  const byId = new Map(readModelCatalog(adapterDir).map((e) => [e.id, e]));
  return (entry) => {
    const catalogEntry = byId.get(entry.id);
    if (!catalogEntry) return undefined;
    try {
      // The resolver matches on identity.model.name (exact equality), so feed
      // it the declared identity name, not the catalog's human label.
      const raw = YAML.parse(readFileSync(catalogEntry.yamlPath, "utf8")) as {
        identity?: { model?: { name?: string; family?: string } };
      };
      const modelName = raw.identity?.model?.name ?? entry.name;
      const resolved = resolveMbaConfig(mbaBaseDir, {
        modelName,
        modelFamily: raw.identity?.model?.family,
        harness: "copilot",
        ide: "vscode",
        serverRuntime: "llamacpp",
      });
      const { flags } = sanitizeLlamaCppServerFlags(resolved.server["llama.cpp"]);
      return flags.ctxSize;
    } catch {
      return undefined;
    }
  };
}
