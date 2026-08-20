/**
 * MBA config merging (ADR-0084).
 *
 * Pure deep-merge helpers that compose adapter binding layers
 * least-specific-first. Split out of resolver.ts (Modularity Auditor: one
 * responsibility per file).
 */

import type { MbaRuleBindingLine } from "./types.js";
import { expandRuleClass, type RuleClassRegistry } from "../bcb/rule-classes.js";
import { isToolCircuitBreakerConfig } from "../bcb/is-config.js";
import type { ToolCircuitBreakerConfig } from "../bcb/types.js";

export function deepMergeObjects<T extends Record<string, unknown>>(base: T, override: T): T {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      typeof out[key] === "object" &&
      out[key] !== null &&
      !Array.isArray(out[key])
    ) {
      out[key] = deepMergeObjects(out[key] as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      out[key] = value;
    }
  }
  return out as T;
}

function mergeToolRuleSet(
  base: Record<string, unknown> | undefined,
  override: Record<string, unknown>,
): Record<string, unknown> {
  return deepMergeObjects(base ?? {}, override);
}

export function mergeToolCircuitBreakerConfig(
  base: ToolCircuitBreakerConfig,
  override: ToolCircuitBreakerConfig,
): ToolCircuitBreakerConfig {
  const tools = { ...base.tools } as Record<string, Record<string, unknown> | undefined>;
  for (const [tool, rules] of Object.entries(override.tools)) {
    if (!rules) {
      tools[tool] = rules;
      continue;
    }
    tools[tool] = mergeToolRuleSet(tools[tool], rules as Record<string, unknown>);
  }
  return { tools };
}

export function bindingsToBcbConfig(
  lines: readonly MbaRuleBindingLine[],
  registry: RuleClassRegistry,
): { config: ToolCircuitBreakerConfig; unknownClasses: readonly string[] } {
  const tools: Record<string, Record<string, unknown> | undefined> = {};
  const unknownClasses: string[] = [];
  for (const line of lines) {
    const ruleSet = tools[line.tool] ?? {};
    if (line.ruleClass) {
      const names = Array.isArray(line.ruleClass) ? line.ruleClass : [line.ruleClass];
      let merged: Record<string, unknown> = { ...ruleSet };
      for (const name of names) {
        const classDef = registry[name];
        if (!classDef) {
          unknownClasses.push(name);
          continue;
        }
        merged = { ...merged, ...expandRuleClass(classDef, line.enabled, line.overrides) };
      }
      tools[line.tool] = merged;
      continue;
    }
    if (!line.rule) continue;
    const params = (line.params ?? {}) as Record<string, unknown>;
    const ruleBody = line.enabled ? { enabled: true, ...params } : { enabled: false };
    tools[line.tool] = {
      ...ruleSet,
      [line.rule]: ruleBody,
    };
  }
  const config = { tools };
  if (!isToolCircuitBreakerConfig(config)) {
    throw new Error("MBA rule binding produced an invalid ToolCircuitBreakerConfig");
  }
  return { config, unknownClasses };
}
