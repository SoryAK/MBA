/**
 * Shared resolve context for connect (stage) and boot (recipe).
 *
 * When a model is paired, boot uses that session's harness + ide so the
 * environment folder matches the client that connected. No pairing → the
 * historical default (copilot + vscode + llamacpp).
 */

import { compactHarnessKey, normalizeHarness } from "../mba/envelope.js";
import type { RecipeResolutionContext } from "./recipe-resolution.js";
import type { ClientSession } from "./sessions.js";
import type { OperatorClient } from "./operator-clients.js";

export const DEFAULT_RESOLVE_ENV: RecipeResolutionContext = {
  harness: "copilot",
  ide: "vscode",
  serverRuntime: "llamacpp",
};

/** IDE used when connect/boot omit it, so env folders like copilot+vscode match. */
export function defaultIdeForHarness(harness: string): string {
  const known = normalizeHarness(harness);
  if (known === "cursor") return "cursor";
  if (known === "claude-code") return "cli";
  return "vscode";
}

/**
 * Status/list label. Hide a redundant ide (`cursor+cursor`) and the shipped
 * default (`copilot+vscode` → `copilot`). Keep `harness+ide` when the ide
 * is a real extra.
 */
export function formatClientLabel(harness: string, ide?: string): string {
  if (!ide) return harness;
  if (compactHarnessKey(ide) === compactHarnessKey(harness)) return harness;
  if (ide === defaultIdeForHarness(harness)) return harness;
  return `${harness}+${ide}`;
}

function sessionForModel(
  sessions: readonly ClientSession[],
  modelId: string,
): ClientSession | undefined {
  const matches = sessions.filter((s) => s.modelId === modelId);
  if (matches.length === 0) return undefined;
  return [...matches].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

/**
 * Env folder key for this model: newest pairing, else the shipped default.
 */
export function resolveEnvContext(opts: {
  readonly sessions?: readonly ClientSession[];
  readonly modelId: string;
  readonly operatorClients?: readonly OperatorClient[];
}): RecipeResolutionContext {
  const session = sessionForModel(opts.sessions ?? [], opts.modelId);
  if (!session) return DEFAULT_RESOLVE_ENV;
  const added = opts.operatorClients?.find((c) => c.name === session.harness);
  const ide =
    (session.ide && session.ide.length > 0 ? session.ide : undefined) ??
    added?.ide ??
    defaultIdeForHarness(session.harness);
  return {
    harness: session.harness,
    ide,
    serverRuntime: DEFAULT_RESOLVE_ENV.serverRuntime,
  };
}
