/**
 * Resolve the live reasoning dial for a request's model (ADR-0105).
 *
 * Used when AMPI is about to compact. Unknown (no adapter / resolve fail)
 * means "try"; compact no-ops if the transcript has no span.
 */

import type { ReasoningGate } from "../cm/reasoning.js";
import { readModelCatalog } from "./model-catalog.js";
import { resolveRecipe } from "./recipe-resolution.js";

export function reasoningGateForModel(
  model: string | undefined,
  adapterDir: string | undefined,
): ReasoningGate | undefined {
  if (!model || !adapterDir) return undefined;
  try {
    const catalog = readModelCatalog(adapterDir);
    const hit = catalog.find((entry) => entry.id === model);
    const modelFile = hit?.modelFile ?? model;
    const recipe = resolveRecipe(modelFile, adapterDir, {
      harness: "copilot",
      ide: "vscode",
      serverRuntime: "llamacpp",
    });
    return {
      reasoningBudget: recipe.flags.reasoningBudget,
      reasoningPreserve: recipe.flags.reasoningPreserve,
    };
  } catch {
    return undefined;
  }
}
