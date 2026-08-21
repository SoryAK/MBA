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
 * The executor is INJECTABLE: production shells out to the boot script
 * (`llama-server-up.sh -Model <id>`); tests inject a fake. This module
 * never touches the filesystem or spawns processes itself.
 */

import type { CatalogEntry } from "./model-catalog.js";

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
  if (loaded === requestedId) {
    return { status: "loaded", id: requestedId };
  }

  try {
    await executor({ id: requestedId, modelFile: entry.modelFile, upstreamUrl });
    return { status: "switched", id: requestedId };
  } catch (err) {
    return { status: "failed", id: requestedId, error: err instanceof Error ? err.message : String(err) };
  }
}
