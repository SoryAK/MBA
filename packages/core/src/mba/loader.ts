/**
 * MBA file loading layer.
 *
 * Responsibilities:
 * - Parse YAML adapter index files.
 * - Parse JSONL rule bindings and JSON structural configs.
 * - Mtime-based caching so live edits work without per-request parse cost.
 * - Last-good semantics: keep the previous successful parse on failure.
 * - Environment interpolation in alert params only.
 */

import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import YAML from "yaml";
import type {
  MbaAdapter,
  MbaAlert,
  MbaResolutionDiagnostic,
  MbaRuleBindingLine,
  MbaServerConfig,
  MbaStructuralConfig,
} from "./types.js";

const SUPPORTED_API_VERSIONS = new Set(["mba.c-yard.dev/v1alpha1"]);

interface CacheEntry<T> {
  mtimeMs: number;
  value: T;
}

const yamlCache = new Map<string, CacheEntry<MbaAdapter>>();
const jsonlCache = new Map<string, CacheEntry<MbaRuleBindingLine[]>>();
const jsonCache = new Map<string, CacheEntry<unknown>>();

function cachedRead<T>(
  path: string,
  cache: Map<string, CacheEntry<T>>,
  parse: (text: string) => T,
): { value: T; fromCache: boolean; error?: Error } {
  const stats = statSync(path, { throwIfNoEntry: false });
  if (!stats) return { value: parse(readFileSync(path, "utf8")), fromCache: false };
  const cached = cache.get(path);
  if (cached && cached.mtimeMs >= stats.mtimeMs) {
    return { value: cached.value, fromCache: true };
  }
  const text = readFileSync(path, "utf8");
  const value = parse(text);
  cache.set(path, { mtimeMs: stats.mtimeMs, value });
  return { value, fromCache: false };
}

function lastGood<T>(path: string, cache: Map<string, CacheEntry<T>>, fresh: () => T): T {
  try {
    return cachedRead(path, cache, fresh).value;
  } catch (err) {
    const cached = cache.get(path);
    if (cached) return cached.value;
    throw err;
  }
}

export function isMbaAdapter(value: unknown): value is MbaAdapter {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.apiVersion !== "mba.c-yard.dev/v1alpha1") return false;
  if (v.kind !== "ModelBehavioralAdapter") return false;
  if (typeof v.metadata !== "object" || v.metadata === null) return false;
  if (typeof (v.metadata as Record<string, unknown>).id !== "string") return false;
  if (typeof v.identity !== "object" || v.identity === null) return false;
  if (typeof (v.identity as Record<string, unknown>).model !== "object" ||
      (v.identity as Record<string, unknown>).model === null) return false;
  if (typeof v.bindings !== "object" || v.bindings === null) return false;
  return true;
}

export function loadAdapterYaml(path: string): MbaAdapter {
  const adapter = lastGood(path, yamlCache, () => {
    const text = readFileSync(path, "utf8");
    const parsed = YAML.parse(text) as unknown;
    if (!isMbaAdapter(parsed)) {
      throw new Error(`invalid MBA adapter shape in ${path}`);
    }
    if (!SUPPORTED_API_VERSIONS.has(parsed.apiVersion)) {
      throw new Error(`unsupported MBA apiVersion ${parsed.apiVersion} in ${path}`);
    }
    return parsed;
  });
  return adapter;
}

export function parseRuleBindings(text: string): MbaRuleBindingLine[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "" && !l.trim().startsWith("//"));
  const out: MbaRuleBindingLine[] = [];
  for (const line of lines) {
    const parsed = JSON.parse(line) as unknown;
    if (typeof parsed !== "object" || parsed === null) continue;
    const r = parsed as Record<string, unknown>;
    if (typeof r.tool !== "string" || typeof r.enabled !== "boolean") continue;
    // A line binds either a single `rule` or one-or-more `rule_class` (snake_case in JSONL).
    const hasRule = typeof r.rule === "string";
    const rawClass = r.rule_class;
    const hasClass =
      typeof rawClass === "string" ||
      (Array.isArray(rawClass) && rawClass.length > 0 && rawClass.every((x) => typeof x === "string"));
    if (!hasRule && !hasClass) continue;
    out.push({
      tool: r.tool,
      ...(hasRule ? { rule: r.rule as string } : {}),
      ...(hasClass ? { ruleClass: rawClass as string | string[] } : {}),
      enabled: r.enabled,
      params: typeof r.params === "object" && r.params !== null ? (r.params as Record<string, unknown>) : undefined,
      overrides:
        typeof r.overrides === "object" && r.overrides !== null
          ? (r.overrides as Record<string, Record<string, unknown>>)
          : undefined,
    });
  }
  return out;
}

export function loadRuleBindings(path: string): MbaRuleBindingLine[] {
  return lastGood(path, jsonlCache, () => parseRuleBindings(readFileSync(path, "utf8")));
}

export function loadStructuralConfig(path: string): MbaStructuralConfig {
  return lastGood(path, jsonCache, () => {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error(`structural config must be an object: ${path}`);
    }
    return parsed as MbaStructuralConfig;
  }) as MbaStructuralConfig;
}

export function loadServerConfig(path: string): MbaServerConfig {
  return lastGood(path, jsonCache, () => {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`server config must be an object: ${path}`);
    }
    return parsed as MbaServerConfig;
  }) as MbaServerConfig;
}

const ENV_VAR_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

function expandEnvInString(value: string): { value: string; missing: string[] } {
  const missing: string[] = [];
  const expanded = value.replace(ENV_VAR_RE, (_match, name) => {
    const env = process.env[name];
    if (env === undefined) {
      missing.push(name);
      return "";
    }
    return env;
  });
  return { value: expanded, missing };
}

function expandEnvInValue(value: unknown): { value: unknown; missing: string[] } {
  if (typeof value === "string") return expandEnvInString(value);
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    const missing: string[] = [];
    for (const item of value) {
      const r = expandEnvInValue(item);
      out.push(r.value);
      missing.push(...r.missing);
    }
    return { value: out, missing };
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    const missing: string[] = [];
    for (const [k, v] of Object.entries(value)) {
      const r = expandEnvInValue(v);
      out[k] = r.value;
      missing.push(...r.missing);
    }
    return { value: out, missing };
  }
  return { value, missing: [] };
}

export function expandAlertParams(alerts: readonly MbaAlert[]): {
  alerts: MbaAlert[];
  diagnostics: MbaResolutionDiagnostic[];
} {
  const out: MbaAlert[] = [];
  const diagnostics: MbaResolutionDiagnostic[] = [];
  for (const alert of alerts) {
    const { value, missing } = expandEnvInValue(alert.params);
    if (missing.length > 0) {
      diagnostics.push({
        kind: "load-error",
        message: `alert sink ${alert.sink} disabled: missing env vars ${missing.join(", ")}`,
      });
      continue;
    }
    out.push({ ...alert, params: value as Record<string, unknown> });
  }
  return { alerts: out, diagnostics };
}

export function resolveRelativePath(adapterPath: string, bindingPath: string): string {
  if (isAbsolute(bindingPath)) return bindingPath;
  return join(dirname(adapterPath), bindingPath);
}
