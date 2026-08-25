/**
 * mba_set_model_config — set a single dial on a model's config via the service.
 *
 * Thin wrapper over POST /models/config. The service owns validation, the
 * atomic write, and the restart-required report; this tool never touches the
 * adapter files directly.
 */
import {
  fetchSetModelConfig,
  type MbaModelDialFile,
  type MbaServiceClientOptions,
  type MbaSetModelConfigResult,
} from "../service-client.js";

export interface SetModelConfigInput {
  /** Model id from the adapter tree (see mba_list_models). */
  readonly id: string;
  /** Which file the field lives in: the llama.cpp boot flags or the client block. */
  readonly file: MbaModelDialFile;
  /** Field name within that file (e.g. ctxSize, gpuLayers, contextSize, vision). */
  readonly field: string;
  /** New value. Type-checked by the service against the field's kind. */
  readonly value: unknown;
}

export type SetModelConfigOutput =
  | (MbaSetModelConfigResult & { readonly error?: undefined })
  | { readonly error: string };

export function createSetModelConfigHandler(
  clientOpts: MbaServiceClientOptions = {},
): (input: SetModelConfigInput) => Promise<SetModelConfigOutput> {
  return async (input) => {
    const res = await fetchSetModelConfig(clientOpts, {
      id: input.id,
      file: input.file,
      field: input.field,
      value: input.value,
    });
    if (!res.ok) return { error: res.error };
    return res.data;
  };
}
