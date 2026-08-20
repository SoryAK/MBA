/**
 * mba_resolve_config — read the effective global MBA config from the service.
 *
 * Thin wrapper over GET /resolve_config. The optional `model` parameter is
 * passed through for per-model resolution context; the global TCB layer and
 * rule-class registry are model-independent.
 */
import {
  fetchResolveConfig,
  type MbaServiceClientOptions,
  type MbaResolveConfigResult,
} from "../service-client.js";

export interface ResolveConfigInput {
  readonly model?: string;
}

export type ResolveConfigOutput =
  | (MbaResolveConfigResult & { readonly error?: undefined })
  | { readonly error: string };

export function createResolveConfigHandler(
  clientOpts: MbaServiceClientOptions = {},
): (input: ResolveConfigInput) => Promise<ResolveConfigOutput> {
  return async (input) => {
    const res = await fetchResolveConfig(clientOpts, input.model);
    if (!res.ok) return { error: res.error };
    return res.data;
  };
}
