/**
 * mba_list_models — the model plane listing (ADR-0093 Phase 2).
 *
 * Thin wrapper over GET /models on the global MBA service. Returns every
 * switchable model from the central adapter tree with its live `loaded`
 * state (probed from the upstream llama-server).
 */
import {
  fetchModels,
  type MbaModelEntry,
  type MbaServiceClientOptions,
} from "../service-client.js";

export type ListModelsOutput =
  | { readonly models: MbaModelEntry[]; readonly error?: undefined }
  | { readonly error: string };

export function createListModelHandler(
  clientOpts: MbaServiceClientOptions = {},
): () => Promise<ListModelsOutput> {
  return async () => {
    const res = await fetchModels(clientOpts);
    if (!res.ok) return { error: res.error };
    return { models: res.data.models };
  };
}
