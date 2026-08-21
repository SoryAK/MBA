/**
 * mba_ensure_model — the user-triggered model switch (ADR-0093 Phase 2).
 *
 * Thin wrapper over POST /models/ensure on the global MBA service. This is
 * the side door: the user (or any MCP host) asks for a model, the service
 * makes sure it is loaded. The proxy never triggers a switch — it only
 * gates on DNA (Phase 3).
 *
 * The service is OFF by default: until `MBA_MODEL_SWITCH=on` is set on the
 * service, this tool returns the 409 "disabled" message.
 */
import {
  fetchEnsureModel,
  type MbaEnsureModelResult,
  type MbaServiceClientOptions,
} from "../service-client.js";

export type EnsureModelOutput =
  | (MbaEnsureModelResult & { readonly error?: undefined })
  | { readonly error: string };

export function createEnsureModelHandler(
  clientOpts: MbaServiceClientOptions = {},
): (input: { id: string }) => Promise<EnsureModelOutput> {
  return async ({ id }) => {
    const res = await fetchEnsureModel(clientOpts, id);
    if (!res.ok) return { error: res.error };
    return res.data;
  };
}
