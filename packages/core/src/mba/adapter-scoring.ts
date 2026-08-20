/**
 * MBA adapter scoring and selection (ADR-0084 / ADR-0090).
 *
 * Pure functions that score adapters by specificity against a request
 * context and order them least-specific-first for the merge. Split out of
 * resolver.ts (Modularity Auditor: one responsibility per file).
 */

import type { MbaAdapter, MbaResolutionContext } from "./types.js";
import {
  dnaMatches,
  environmentMatches,
  familyMatches,
  nameMatches,
  serverMatches,
  type AdapterEntry,
} from "./adapter-identity.js";

/**
 * The request's lineage, root → leaf. Explicit `modelLineage` wins; otherwise
 * derived from the family hint as a single segment.
 */
function requestLineage(ctx: MbaResolutionContext): readonly string[] {
  if (ctx.modelLineage && ctx.modelLineage.length > 0) return ctx.modelLineage;
  if (ctx.modelFamily) return [ctx.modelFamily];
  return [];
}

/**
 * Score an adapter against the request context. Higher = more specific.
 * Returns `null` when the adapter does not match at all.
 *
 * Model-specificity ladder (ADR-0090):
 *   DNA (100) > name (50) > family (25) > lineage prefix (25 × depth ratio).
 * A family adapter whose folder-path lineage is a prefix of the request's
 * lineage matches at a score proportional to how deep the prefix reaches —
 * a branch `[qwen, qwen3-coder]` scores 25 (== family), a trunk `[qwen]`
 * scores lower, so the merge order is trunk → branch → leaf.
 */
export function scoreAdapter(
  entry: AdapterEntry,
  ctx: MbaResolutionContext,
): number | null {
  const adapter = entry.adapter;
  if (!environmentMatches(ctx, adapter)) return null;
  if (!serverMatches(ctx, adapter)) return null;

  let modelScore = 0;
  if (ctx.modelDna && dnaMatches(ctx.modelDna, adapter.identity.model.dna)) {
    modelScore = 100;
  } else if (nameMatches(ctx.modelName, adapter)) {
    modelScore = 50;
  } else if (familyMatches(ctx.modelFamily, adapter)) {
    modelScore = 25;
  } else {
    const lineage = familyPathLineage(entry);
    if (lineage) {
      const req = requestLineage(ctx);
      if (lineagePrefix(lineage, req)) {
        modelScore = 25 * (lineage.length / req.length);
      }
    }
    if (modelScore === 0) return null;
  }

  const env = adapter.identity.environment ?? {};
  const server = adapter.identity.server ?? {};
  const harnessScore = env.harness !== undefined && env.harness !== null ? 8 : 0;
  const ideScore = env.ide !== undefined && env.ide !== null ? 4 : 0;
  const runtimeScore = server.runtime !== undefined && server.runtime !== null ? 2 : 0;
  const versionScore =
    server.version !== undefined && server.version !== null && server.version !== "" ? 1 : 0;

  return modelScore + harnessScore + ideScore + runtimeScore + versionScore;
}

/**
 * The canonical request lineage for ancestor matching. The request context
 * rarely knows its own full lineage (the bouncer only has a model name +
 * family hint), so we recover it from the leaf: the adapter matched by exact
 * name lives at `<lineage...>/<environment...>` in the folder tree, and its
 * declared `identity.model.lineage` marks where the lineage segments end and
 * the environment segments begin. The folder path is the source of truth; the
 * declaration only supplies the depth. When the declaration is missing or
 * disagrees with the path, fall back to the declared value (the mismatch is
 * already surfaced as a diagnostic by `resolveMbaConfig`).
 */
function effectiveRequestLineage(
  entries: readonly AdapterEntry[],
  ctx: MbaResolutionContext,
): readonly string[] {
  if (ctx.modelLineage && ctx.modelLineage.length > 0) return ctx.modelLineage;

  const leaf = entries.find(
    (e) =>
      nameMatches(ctx.modelName, e.adapter) &&
      environmentMatches(ctx, e.adapter) &&
      serverMatches(ctx, e.adapter),
  );
  if (leaf) {
    const declared = leaf.adapter.identity.model.lineage;
    if (declared && declared.length > 0) {
      // Trust the folder path for the segment values, the declaration for the
      // depth (where lineage ends and environment begins).
      const pathLineage = leaf.pathSegments.slice(0, declared.length);
      const pathAgrees = pathLineage.every((seg, i) => seg === declared[i]);
      return pathAgrees ? pathLineage : declared;
    }
    // No declaration: the whole folder path is lineage (no environment nesting).
    if (leaf.pathSegments.length > 0) return leaf.pathSegments;
  }

  if (ctx.modelFamily) return [ctx.modelFamily];
  return [];
}

export function sortAdapters(
  entries: readonly AdapterEntry[],
  ctx: MbaResolutionContext,
): { selected: AdapterEntry[]; ambiguous: MbaAdapter[][] } {
  // Two-pass: the leaf's folder path reveals the request's full lineage,
  // which ancestor (trunk/branch) adapters need to prefix-match.
  const lineageCtx: MbaResolutionContext = {
    ...ctx,
    modelLineage: effectiveRequestLineage(entries, ctx),
  };
  const scored = entries
    .map((e) => ({ entry: e, score: scoreAdapter(e, lineageCtx) }))
    .filter((e): e is { entry: AdapterEntry; score: number } => e.score !== null);

  scored.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score;
    return a.entry.adapter.metadata.id.localeCompare(b.entry.adapter.metadata.id);
  });

  // Detect exact-score ties at the highest specificity tier. Only the top tier
  // can create an ambiguous-resolution situation because lower tiers are
  // overridden by the merge anyway.
  const groups = new Map<number, MbaAdapter[]>();
  for (const e of scored) {
    const list = groups.get(e.score) ?? [];
    list.push(e.entry.adapter);
    groups.set(e.score, list);
  }
  const topScore = scored.at(-1)?.score;
  const ambiguous: MbaAdapter[][] = [];
  if (topScore !== undefined) {
    const topGroup = groups.get(topScore);
    if (topGroup) ambiguous.push(topGroup);
  }

  return { selected: scored.map((e) => e.entry), ambiguous };
}

/**
 * The lineage a family adapter represents, derived from its folder path.
 * Only family adapters (identity.model.family set, no name) mark lineage
 * rungs; leaves and DNA adapters do not.
 */
function familyPathLineage(entry: AdapterEntry): readonly string[] | undefined {
  const { model } = entry.adapter.identity;
  if (!model.family || model.name || model.dna?.digest) return undefined;
  return entry.pathSegments;
}

/**
 * True when `candidate` (an adapter's path lineage) is a prefix of `request`
 * (the request's lineage). A trunk `[qwen]` matches any Qwen model; a branch
 * `[qwen, qwen3-coder]` matches only qwen3-coder models.
 */
function lineagePrefix(candidate: readonly string[], request: readonly string[]): boolean {
  if (candidate.length === 0 || candidate.length > request.length) return false;
  return candidate.every((seg, i) => seg === request[i]);
}
