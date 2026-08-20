/**
 * mba_model_registry — light listing of the MBA model adapters.
 *
 * Offline by design: reads the adapters already loaded at server boot from
 * .MBA/adapters (no service round-trip). For per-model full reports (resolved
 * config, structural rules, server flags) use mba_resolve_config with the
 * model id — this tool intentionally does not duplicate that.
 */
import type { LoadedAdapter } from "../adapter/loader.js";

export interface ModelRegistryEntry {
  readonly id: string;
  readonly name?: string;
  readonly family?: string;
  readonly modelFamily?: string;
  readonly modelName?: string;
  readonly modelFile?: string;
  readonly bindings: {
    readonly bcb?: unknown;
    readonly tcb?: unknown;
    readonly structural?: unknown;
    readonly server_setup?: unknown;
  };
}

export interface ModelRegistryOutput {
  readonly count: number;
  readonly models: ModelRegistryEntry[];
}

export function createModelRegistryHandler(
  adapters: LoadedAdapter[],
): () => ModelRegistryOutput {
  return () => {
    const models: ModelRegistryEntry[] = adapters.map((loaded) => {
      const a = loaded.adapter;
      return {
        id: a.metadata.id,
        name: a.metadata.name,
        family: a.metadata.family,
        modelFamily: a.identity.model.family,
        modelName: a.identity.model.name,
        modelFile: a.identity.model.file,
        bindings: {
          bcb: a.bindings.bcb,
          tcb: a.bindings.tcb,
          structural: a.bindings.structural,
          server_setup: a.bindings.server_setup,
        },
      };
    });
    return { count: models.length, models };
  };
}
