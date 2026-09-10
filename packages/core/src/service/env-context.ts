/**
 * Shared resolve context for connect (stage) vs boot (recipe).
 *
 * Boot is always bare: family + model dials only. A prior pairing does not
 * pick an environment overlay — that is how operators ended up generating
 * Copilot/Cursor configs without choosing them. Connect attaches a client
 * (card + token). Env folders still apply when a caller passes an explicit
 * harness (stage, proxy fingerprint, `resolve-server-recipe --harness`).
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

/** Boot / advertised-ctx recipe: no `environments/` overlay. */
export const BARE_BOOT_ENV: RecipeResolutionContext = {
  harness: "none",
  ide: "none",
  serverRuntime: "llamacpp",
  applyEnvFolders: false,
};

export function isBareBootEnv(env: {
  readonly harness: string;
  readonly applyEnvFolders?: boolean;
}): boolean {
  return env.applyEnvFolders === false || env.harness === "none";
}

/** JSON `env` on POST /servers/resolve — three strings, no internal flags. */
export function bootEnvJson(env: RecipeResolutionContext): {
  readonly harness: string;
  readonly ide: string;
  readonly serverRuntime: string;
} {
  return {
    harness: env.harness,
    ide: env.ide,
    serverRuntime: env.serverRuntime,
  };
}

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
export function extraIde(harness: string, ide?: string): string | undefined {
  if (!ide) return undefined;
  if (compactHarnessKey(ide) === compactHarnessKey(harness)) return undefined;
  if (ide === defaultIdeForHarness(harness)) return undefined;
  return ide;
}

export function formatClientLabel(harness: string, ide?: string): string {
  const extra = extraIde(harness, ide);
  return extra ? `${harness}+${extra}` : harness;
}

/**
 * Overlay folder to create when this pairing needs extra dials.
 * Harness only (`cursor`). Add `+ide` / `+runtime` only when that combo
 * differs from the harness default — never a nested directory tree.
 */
export function overlayFolderName(opts: {
  readonly harness: string;
  readonly ide?: string;
  readonly serverRuntime?: string;
}): string {
  const parts = [opts.harness];
  const extra = extraIde(opts.harness, opts.ide);
  if (extra) parts.push(extra);
  if (opts.serverRuntime && opts.serverRuntime !== DEFAULT_RESOLVE_ENV.serverRuntime) {
    parts.push(opts.serverRuntime);
  }
  return parts.join("+");
}

/** `cli` for Claude Code; `ide` for Cursor / Copilot / Continue / extras. */
export function harnessKind(harness: string): "cli" | "ide" {
  return defaultIdeForHarness(harness) === "cli" ? "cli" : "ide";
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
 * Newest pairing for this model, else the connect/stage default
 * (copilot + vscode + llamacpp). Boot does not call this.
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
