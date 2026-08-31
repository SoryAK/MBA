/**
 * Model switch mechanics (ADR-0093 Phase 1).
 *
 * Two pure-ish pieces:
 *   - `probeLoadedModel` — asks the upstream llama-server which model is
 *     currently loaded (`GET /v1/models`). Unreachable upstream → `null`
 *     (the probe is advisory; a dead upstream is not an error here).
 *   - `ensureModel` — idempotent "make sure model X is loaded":
 *       already loaded  → `loaded` (no work, ~1ms)
 *       switch disabled → `disabled` (ADR-0093: OFF by default)
 *       unknown id      → `unknown` (rejected before any switch work)
 *       not loaded      → run the injected executor → `switched` / `failed`
 *
 * The executor is INJECTABLE: production boots in-daemon via the server
 * plane (ADR-0097 Phase 2 — stop the model's current server, then
 * `POST /servers/boot`); tests inject a fake. This module never touches the
 * filesystem or spawns processes itself.
 */

import { basename } from "node:path";

import type { CatalogEntry } from "./model-catalog.js";
import { resolveUpstream, type UpstreamEntry } from "./upstream-registry.js";

/** Boots (or re-boots) the upstream so that `id` is the loaded model. */
export type SwitchExecutor = (ctx: {
  readonly id: string;
  readonly modelFile?: string;
  readonly upstreamUrl: string;
}) => Promise<void>;

export type EnsureModelResult =
  | { readonly status: "loaded"; readonly id: string }
  | { readonly status: "switched"; readonly id: string }
  | { readonly status: "disabled"; readonly id: string }
  | { readonly status: "unknown"; readonly id: string }
  | { readonly status: "failed"; readonly id: string; readonly error: string };

export interface EnsureModelInput {
  readonly catalog: readonly CatalogEntry[];
  readonly requestedId: string;
  readonly upstreamUrl: string;
  readonly switchEnabled: boolean;
  readonly executor: SwitchExecutor;
  /** Injectable for tests; defaults to global fetch. */
  readonly fetch?: typeof fetch;
}

/**
 * Read the id of the model currently loaded on the upstream. Returns `null`
 * when the upstream is unreachable, unhealthy, or reports no model — the
 * caller treats `null` as "not loaded", never as a hard failure.
 */
export async function probeLoadedModel(
  upstreamUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const base = upstreamUrl.replace(/\/+$/, "");
  try {
    const res = await fetchImpl(`${base}/v1/models`);
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: Array<{ id?: unknown }> };
    const first = body.data?.[0]?.id;
    return typeof first === "string" && first.length > 0 ? first : null;
  } catch {
    return null;
  }
}

/**
 * Decide whether the upstream-reported model identifier refers to the same
 * model as `modelFile`.
 *
 * llama.cpp reports the model by the exact path it was given via `-m` — NOT
 * by the MBA id. So the probe result is compared against the catalog's
 * resolved absolute `modelFile`, first by exact path, then by basename
 * (covers symlinked/normalized prefixes pointing at the same file).
 *
 * `null` probe (upstream down / no model) or a missing `modelFile` → `false`
 * (we cannot prove the model is loaded).
 */
export function isLoadedPath(probed: string | null, modelFile?: string): boolean {
  if (probed === null || !modelFile) return false;
  if (probed === modelFile) return true;
  return basename(probed) === basename(modelFile);
}

/**
 * Choose the argument for the boot script's `-Model` flag.
 *
 * Prefer the catalog's resolved absolute GGUF path: the boot script's
 * `[[ -f ]]` fast path accepts it verbatim, so the boot is deterministic —
 * no `find` substring match, no collision with sibling models whose names
 * share a prefix (e.g. `qwen3.8-27b` vs `qwen3.8-27b-instruct`). Fall back
 * to the MBA id only when no path is available (the script's `find`
 * fallback still resolves it).
 */
export function modelArg(modelId: string, modelFile?: string): string {
  return modelFile && modelFile.length > 0 ? modelFile : modelId;
}

/**
 * Pick the base URL to probe for a given model (ADR-0097 Phase 1).
 *
 * Fallback order — first rung that yields a target wins:
 *   1. REGISTRY — the upstream resolved from the upstream registry for this
 *      model's `modelFile` (healthiest + most-recently-booted; `healthyIds`
 *      excludes entries that failed their probe — lazy validation, G2).
 *   2. YAML — the adapter's `client.url` (trailing `/v1` stripped: the
 *      probe appends `/v1/models` itself).
 *   3. ENV — `MBA_UPSTREAM_URL` (the legacy single-upstream knob).
 *   4. `null` — no target; the model is "not loaded" for probe purposes.
 *
 * Pure — no I/O; the registry is read by the caller and passed in.
 */
export function resolveProbeTarget(input: {
  readonly modelFile?: string;
  readonly registry: readonly UpstreamEntry[];
  readonly healthyIds?: ReadonlySet<string>;
  readonly yamlUrl?: string;
  readonly envUrl?: string;
}): string | null {
  const { modelFile, registry, healthyIds, yamlUrl, envUrl } = input;
  if (modelFile) {
    const resolved = resolveUpstream(registry, modelFile, healthyIds);
    if (resolved) return `http://127.0.0.1:${resolved.port}`;
  }
  if (yamlUrl && yamlUrl.length > 0) {
    return yamlUrl.replace(/\/v1\/?$/, "");
  }
  if (envUrl && envUrl.length > 0) {
    return envUrl;
  }
  return null;
}

/**
 * Idempotently ensure `requestedId` is the loaded model. See the module
 * header for the state table. Never throws for expected conditions —
 * executor failures are reported as `{ status: "failed" }`.
 */
export async function ensureModel(input: EnsureModelInput): Promise<EnsureModelResult> {
  const { catalog, requestedId, upstreamUrl, switchEnabled, executor, fetch: fetchImpl } = input;

  const entry = catalog.find((e) => e.id === requestedId);
  if (!entry) {
    return { status: "unknown", id: requestedId };
  }
  if (!switchEnabled) {
    return { status: "disabled", id: requestedId };
  }

  const loaded = await probeLoadedModel(upstreamUrl, fetchImpl);
  if (isLoadedPath(loaded, entry.modelFile)) {
    return { status: "loaded", id: requestedId };
  }

  try {
    await executor({ id: requestedId, modelFile: entry.modelFile, upstreamUrl });
    return { status: "switched", id: requestedId };
  } catch (err) {
    return { status: "failed", id: requestedId, error: err instanceof Error ? err.message : String(err) };
  }
}
