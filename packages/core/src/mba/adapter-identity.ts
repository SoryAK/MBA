/**
 * MBA adapter identity predicates (ADR-0084 / ADR-0090).
 *
 * Pure functions that decide whether an adapter's declared identity matches
 * a request context. Split out of resolver.ts (Modularity Auditor: one
 * responsibility per file).
 */

import type {
  MbaAdapter,
  MbaModelDna,
  MbaResolutionContext,
} from "./types.js";
import { satisfiesVersionRange } from "./version.js";

/**
 * A scanned adapter file and its folder-path lineage.
 *
 * `pathSegments` is the adapter's directory relative to the adapters root,
 * split into segments. For a family adapter this IS its lineage
 * (`adapters/qwen/qwen3-coder/family.yaml` → `[qwen, qwen3-coder]`); for a
 * leaf it is lineage + environment segments (`.../copilot-vscode/llamacpp/`
 * → `[qwen, qwen3-coder, copilot-vscode, llamacpp]`). ADR-0090.
 */
export interface AdapterEntry {
  readonly path: string;
  readonly adapter: MbaAdapter;
  readonly pathSegments: readonly string[];
}

export function hasDnaIdentity(adapter: MbaAdapter): boolean {
  return !!adapter.identity.model.dna?.digest;
}

export function hasNameIdentity(adapter: MbaAdapter): boolean {
  return !!adapter.identity.model.name && !hasDnaIdentity(adapter);
}

export function hasFamilyIdentity(adapter: MbaAdapter): boolean {
  return !!adapter.identity.model.family && !hasDnaIdentity(adapter) && !hasNameIdentity(adapter);
}

export function dnaMatches(dna: MbaModelDna | undefined, adapterDna: MbaModelDna | undefined): boolean {
  if (!dna || !adapterDna) return false;
  if (!adapterDna.digest) return false;
  return adapterDna.digest === dna.digest;
}

export function nameMatches(name: string, adapter: MbaAdapter): boolean {
  return !!adapter.identity.model.name && adapter.identity.model.name === name;
}

export function familyMatches(family: string | undefined, adapter: MbaAdapter): boolean {
  if (!family) return false;
  return !!adapter.identity.model.family && adapter.identity.model.family === family;
}

export function environmentMatches(ctx: MbaResolutionContext, adapter: MbaAdapter): boolean {
  const env = adapter.identity.environment ?? {};
  if (env.harness !== undefined && env.harness !== null && env.harness !== ctx.harness) return false;
  if (env.ide !== undefined && env.ide !== null && env.ide !== (ctx.ide ?? "")) return false;
  return true;
}

export function serverMatches(ctx: MbaResolutionContext, adapter: MbaAdapter): boolean {
  const server = adapter.identity.server ?? {};
  const runtime = ctx.serverRuntime ?? "generic";
  if (server.runtime !== undefined && server.runtime !== null && server.runtime !== runtime) {
    return false;
  }
  if (server.version !== undefined && server.version !== null && server.version !== "") {
    if (!satisfiesVersionRange(runtime, server.version, ctx.serverVersion)) return false;
  }
  return true;
}
