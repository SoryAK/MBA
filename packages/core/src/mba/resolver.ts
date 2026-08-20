/**
 * MBA adapter resolution and composition.
 *
 * Implements ADR-0084:
 * - scan adapter YAML files under a directory tree
 * - score adapters by specificity against a request context
 * - deep-merge selected adapters (least-specific first)
 * - load bound BCB/TCB/structural config files
 *
 * The mechanics live in sibling modules (Modularity Auditor split):
 * - adapter-identity.ts — identity predicates
 * - adapter-scoring.ts  — specificity scoring and selection
 * - adapter-merge.ts    — deep-merge helpers
 * - adapter-loading.ts  — adapter scan, rule-class registries, env folders
 *
 * This file keeps the request-level helpers (`inferModelFamily`) and the
 * `resolveMbaConfig` orchestrator that composes them.
 */

import { statSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  MbaAlert,
  MbaModelProfile,
  MbaResolutionContext,
  MbaResolutionDiagnostic,
  MbaResolvedConfig,
  MbaServerConfig,
  MbaStructuralConfig,
} from "./types.js";
import {
  expandAlertParams,
  loadRuleBindings,
  loadServerConfig,
  loadStructuralConfig,
  resolveRelativePath,
} from "./loader.js";
import type { AdapterEntry } from "./adapter-identity.js";
import { sortAdapters } from "./adapter-scoring.js";
import {
  bindingsToBcbConfig,
  deepMergeObjects,
  mergeToolCircuitBreakerConfig,
} from "./adapter-merge.js";
import {
  ENV_BINDING_FILES,
  loadAdapters,
  loadRuleClassRegistry,
  selectEnvironmentFolder,
} from "./adapter-loading.js";
import {
  BUILTIN_RULE_CLASSES,
  mergeRuleClassRegistries,
  type RuleClassRegistry,
} from "../bcb/rule-classes.js";
import { defaultToolCircuitBreakerConfig } from "../bcb/default-config.js";
import type { ToolCircuitBreakerConfig } from "../bcb/types.js";

export interface MbaResolverOptions {
  /**
   * Optional base BCB config layer loaded from `.MBA/bcb/tool-circuit-breakers.json`.
   * If omitted, built-in defaults are used.
   */
  readonly globalBcbConfig?: ToolCircuitBreakerConfig;
}

/**
 * Heuristic model-name → family mapping for models whose request name does not
 * exactly match a known family slug. Used only when the caller does not already
 * supply a family hint in the resolution context.
 */
const DEFAULT_MODEL_FAMILY_MAP: Readonly<Record<string, string>> = {
  "Qwen3-Coder-30B": "qwen3-coder",
  qwen3: "qwen3-coder",
  "qwen3-coder": "qwen3-coder",
};

function normalizeModelName(name: string): string {
  // Strip a leading local path or GGUF suffix to get a stable base name.
  // /home/skaba/models/qwen3/Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf
  //   → Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf
  const basename = name.includes("/") ? name.slice(name.lastIndexOf("/") + 1) : name;
  return basename.replace(/\.gguf$/i, "");
}

export function inferModelFamily(ctx: { readonly modelName: string; readonly modelFamily?: string }): string | undefined {
  if (ctx.modelFamily) return ctx.modelFamily;
  const normalized = normalizeModelName(ctx.modelName);
  // Exact match first.
  if (DEFAULT_MODEL_FAMILY_MAP[normalized]) return DEFAULT_MODEL_FAMILY_MAP[normalized];
  // Case-insensitive contains match, e.g. "Qwen3-Coder-30B-A3B-Instruct" → qwen3-coder.
  const lower = normalized.toLowerCase();
  for (const [key, family] of Object.entries(DEFAULT_MODEL_FAMILY_MAP)) {
    if (lower.includes(key.toLowerCase())) return family;
  }
  return undefined;
}

export function resolveMbaConfig(
  mbaDir: string,
  ctx: MbaResolutionContext,
  options: MbaResolverOptions = {},
): MbaResolvedConfig {
  const diagnostics: MbaResolutionDiagnostic[] = [];
  let bcbConfig = options.globalBcbConfig ?? defaultToolCircuitBreakerConfig();
  let structural: MbaStructuralConfig = {};
  let server: MbaServerConfig = {};
  const alerts: MbaAlert[] = [];

  const adapterDir = join(mbaDir, "adapters");
  let entries: AdapterEntry[];
  try {
    entries = loadAdapters(adapterDir);
  } catch {
    entries = [];
  }

  // Cross-check declared lineage against the folder path (ADR-0090). The
  // folder path is the source of truth; a declared lineage that is not a
  // prefix of the path segments is a labeling error. Non-fatal.
  for (const entry of entries) {
    const declared = entry.adapter.identity.model.lineage;
    if (!declared || declared.length === 0) continue;
    const isPrefix = declared.every((seg, i) => entry.pathSegments[i] === seg);
    if (!isPrefix) {
      diagnostics.push({
        kind: "lineage-mismatch",
        message: `adapter ${entry.adapter.metadata.id} declares lineage [${declared.join(", ")}] but lives at ${entry.pathSegments.join("/") || "(root)"}`,
        adapterIds: [entry.adapter.metadata.id],
      });
    }
  }

  // Global rule-class registry (least specific), layered under per-adapter classes.
  let globalClasses: RuleClassRegistry = {};
  try {
    globalClasses = loadRuleClassRegistry(join(mbaDir, "rule-classes.json"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      diagnostics.push({
        kind: "load-error",
        message: `failed to load global rule-classes.json: ${String(err)}`,
      });
    }
  }

  const enrichedCtx: MbaResolutionContext = {
    ...ctx,
    modelFamily: inferModelFamily(ctx),
  };

  const { selected, ambiguous } = sortAdapters(entries, enrichedCtx);
  for (const group of ambiguous) {
    if (group.length > 1) {
      diagnostics.push({
        kind: "ambiguous-resolution",
        message: `multiple adapters tied for highest specificity`,
        adapterIds: group.map((a) => a.metadata.id).sort(),
      });
    }
  }

  // Apply one binding file (bcb/tcb/structural/server_setup) from an already
  // resolved absolute path. `label` is the adapter id for diagnostics;
  // `registry` is the rule-class registry in scope for that adapter. Mutates
  // the outer accumulators.
  const applyBindingFile = (
    bindingPath: string,
    label: string,
    registry: RuleClassRegistry,
    file: "bcb" | "tcb" | "structural" | "server_setup",
  ): void => {
    try {
      if (file === "bcb" || file === "tcb") {
        const { config, unknownClasses } = bindingsToBcbConfig(loadRuleBindings(bindingPath), registry);
        bcbConfig = mergeToolCircuitBreakerConfig(bcbConfig, config);
        for (const name of unknownClasses) {
          diagnostics.push({
            kind: "unknown-rule-class",
            message: `${file} binding for ${label} references unknown rule class "${name}"`,
          });
        }
      } else if (file === "structural") {
        structural = deepMergeObjects(
          structural as Record<string, unknown>,
          loadStructuralConfig(bindingPath) as Record<string, unknown>,
        ) as MbaStructuralConfig;
      } else {
        server = deepMergeObjects(
          server as Record<string, unknown>,
          loadServerConfig(bindingPath) as Record<string, unknown>,
        ) as MbaServerConfig;
      }
    } catch (err) {
      diagnostics.push({
        kind: "load-error",
        message: `failed to load ${file} bindings for ${label}: ${String(err)}`,
      });
    }
  };

  const selectedIds: string[] = [];
  let profile: MbaModelProfile | undefined;

  for (const { path, adapter } of selected) {
    selectedIds.push(adapter.metadata.id);
    const scopeDir = dirname(path);

    // The matched model's immutable profile (ADR-0091). `selected` is sorted
    // least-specific-first, so the last adapter with a profile wins.
    if (adapter.identity.model.profile) {
      profile = adapter.identity.model.profile;
    }

    // Old-style environment adapter (ADR-0084): a separate YAML per
    // (model × environment) carrying identity.environment / identity.server.
    // Still resolves (backward compat) but is deprecated in favor of
    // environment override folders (ADR-0091).
    const isLegacyEnvAdapter =
      adapter.identity.environment !== undefined || adapter.identity.server !== undefined;
    if (isLegacyEnvAdapter) {
      diagnostics.push({
        kind: "env-adapter-deprecated",
        message: `adapter ${adapter.metadata.id} uses the deprecated per-environment YAML shape; migrate to an environments/ override folder (ADR-0091)`,
        adapterIds: [adapter.metadata.id],
      });
    }

    // Rule-class registry for this adapter: built-in ← global ← per-adapter.
    let adapterClasses: RuleClassRegistry = {};
    if (adapter.bindings.ruleClasses) {
      try {
        adapterClasses = loadRuleClassRegistry(
          resolveRelativePath(path, adapter.bindings.ruleClasses),
        );
      } catch (err) {
        diagnostics.push({
          kind: "load-error",
          message: `failed to load rule classes for ${adapter.metadata.id}: ${String(err)}`,
        });
      }
    }
    const { registry, collisions } = mergeRuleClassRegistries(
      BUILTIN_RULE_CLASSES,
      globalClasses,
      adapterClasses,
    );
    for (const name of collisions) {
      diagnostics.push({
        kind: "rule-class-override",
        message: `rule class "${name}" overrides a built-in or global class (${adapter.metadata.id})`,
      });
    }

    // Rung A: the adapter's own binding files (family bindings or model
    // bindings, or — for a legacy env adapter — its environment bindings).
    // Paths are relative to the adapter YAML's directory.
    for (const [file, key] of [
      ["bcb", "bcb"],
      ["tcb", "tcb"],
      ["structural", "structural"],
      ["server_setup", "server_setup"],
    ] as const) {
      const rel = adapter.bindings[key];
      if (rel) {
        applyBindingFile(resolveRelativePath(path, rel), adapter.metadata.id, registry, file);
      }
    }

    // Rung B: the scope's environment override folder (ADR-0091). Only scope
    // adapters (family / model) carry an environments/ folder; a legacy env
    // adapter IS the environment, so it has none. The folder holds only the
    // binding files it overrides; absent files inherit from lower rungs.
    if (!isLegacyEnvAdapter) {
      const envDir = selectEnvironmentFolder(scopeDir, enrichedCtx);
      if (envDir) {
        for (const [file, fileName] of ENV_BINDING_FILES) {
          const candidate = join(envDir, fileName);
          if (statSync(candidate, { throwIfNoEntry: false })) {
            applyBindingFile(candidate, `${adapter.metadata.id} (env)`, registry, file);
          }
        }
      }
    }

    if (adapter.alerts) {
      const expanded = expandAlertParams(adapter.alerts);
      alerts.push(...expanded.alerts);
      diagnostics.push(...expanded.diagnostics);
    }
  }

  // Ceiling validation (ADR-0091): a server_setup dial must not exceed the
  // matched model's immutable profile ceiling. Non-fatal — the dial still
  // applies, but the violation is surfaced.
  if (profile?.params?.maxContextLength !== undefined) {
    const ctxSize = (server["llama.cpp"] as { ctxSize?: number } | undefined)?.ctxSize;
    if (ctxSize !== undefined && ctxSize > profile.params.maxContextLength) {
      diagnostics.push({
        kind: "ceiling-violation",
        message: `server_setup ctxSize ${ctxSize} exceeds the model profile maxContextLength ${profile.params.maxContextLength}`,
      });
    }
  }

  return { bcbConfig, structural, server, alerts, selectedIds, profile, diagnostics };
}

