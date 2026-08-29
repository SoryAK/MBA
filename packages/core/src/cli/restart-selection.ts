/**
 * Restart target selection (B2).
 *
 * A model can be served by MORE than one registered server (duplicate boots,
 * manual + daemon). Before re-booting, every matching server must be stopped
 * or the new boot collides on the port. The decision:
 *
 * - 0 matches  → nothing to stop.
 * - 1 match    → stop it, no prompt.
 * - 2+ matches → ask the user "stop all?" when interactive; when non-interactive
 *                (no TTY / piped stdin) stop ALL — a partial stop would leave a
 *                duplicate holding the model (user-locked default, 2026-08-26).
 *
 * Pure: takes the server list, returns the stop targets plus whether the
 * caller should prompt. The caller owns the prompt and the stop calls.
 */

export interface ServerLike {
  readonly id: string;
  readonly modelFile: string;
}

export interface RestartSelection {
  /** Servers to stop when the user confirms (or when no prompt is needed). */
  readonly targets: readonly ServerLike[];
  /** True when the caller must ask "stop all?" before stopping `targets`. */
  readonly prompt: boolean;
}

export function selectRestartTargets(
  servers: readonly ServerLike[],
  modelFile: string,
  interactive: boolean,
): RestartSelection {
  const matches = servers.filter((s) => s.modelFile === modelFile);
  if (matches.length <= 1) {
    return { targets: matches, prompt: false };
  }
  return { targets: matches, prompt: interactive };
}
