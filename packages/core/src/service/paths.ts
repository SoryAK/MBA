/**
 * OS-aware path resolution for MBA's two on-disk homes (ADR-0097 Phase 4).
 *
 * MBA owns two locations, and both are now resolved from ONE place instead of
 * the old copy-pasted `~/.mba` / `~/models/adapters` strings:
 *
 *   - STATE  — small, config-ish (service.json, upstreams.json, TCB config).
 *   - STORE  — the big model data (model_hub/adapters + family lineage).
 *
 * Each follows the host OS's standard "where does an app put its files"
 * convention, so a fresh install gets a working location with no setup:
 *
 *   | OS      | STATE                              | STORE                                        |
 *   |---------|------------------------------------|----------------------------------------------|
 *   | Linux   | $XDG_CONFIG_HOME/mba (~/.config)   | $XDG_DATA_HOME/mba/model_hub/adapters        |
 *   | macOS   | ~/Library/Application Support/mba  | ~/Library/Application Support/mba/model_hub  |
 *   | Windows | %APPDATA%/mba                      | %LOCALAPPDATA%/mba/model_hub/adapters        |
 *
 * macOS collapses both into the same base — Apple has one "app support"
 * district, not separate config/data districts. That is correct, not a bug.
 *
 * Pure-ish: all inputs (platform, env, homedir) are injectable so tests can
 * exercise the full platform matrix without touching the real filesystem or
 * the real process. No globals read at module scope.
 */

import { mkdirSync } from "node:fs";
import { homedir as osHomedir } from "node:os";
import { join } from "node:path";

/** The subset of `process.platform` values MBA cares about. */
export type Platform = "darwin" | "win32" | "linux" | "other";

/** Injectable inputs so the resolvers stay pure and testable. */
export interface PathContext {
  readonly platform: Platform;
  readonly env: NodeJS.ProcessEnv;
  readonly homedir: string;
}

/** Build a PathContext from the live process (the production default). */
export function livePathContext(): PathContext {
  return {
    platform: normalizePlatform(process.platform),
    env: process.env,
    homedir: osHomedir(),
  };
}

/** Map the full `process.platform` union onto MBA's four-bucket model. */
export function normalizePlatform(p: string): Platform {
  if (p === "darwin") return "darwin";
  if (p === "win32") return "win32";
  if (p === "linux") return "linux";
  return "other";
}

/**
 * The OS-standard base dir for MBA's STATE.
 *
 * Linux honors $XDG_CONFIG_HOME (fallback ~/.config). Windows uses %APPDATA%.
 * macOS uses ~/Library/Application Support. Unknown platforms fall back to
 * ~/.config so there is always a sane answer.
 */
export function defaultStateDir(ctx: PathContext = livePathContext()): string {
  switch (ctx.platform) {
    case "darwin":
      return join(ctx.homedir, "Library", "Application Support", "mba");
    case "win32":
      return join(requireAppData(ctx.env), "mba");
    case "linux":
    case "other":
    default: {
      const xdg = ctx.env.XDG_CONFIG_HOME;
      const base = xdg && xdg.length > 0 ? xdg : join(ctx.homedir, ".config");
      return join(base, "mba");
    }
  }
}

/**
 * The OS-standard root for MBA's model STORE (the `model_hub/adapters` tree
 * plus family lineage). This is the big-data location — the 58G on a working
 * install — and is what the pull feature will file new models into.
 *
 * Linux honors $XDG_DATA_HOME (fallback ~/.local/share). Windows uses
 * %LOCALAPPDATA%. macOS shares the Application Support base with state.
 */
export function defaultModelStoreRoot(ctx: PathContext = livePathContext()): string {
  switch (ctx.platform) {
    case "darwin":
      return join(ctx.homedir, "Library", "Application Support", "mba", "model_hub", "adapters");
    case "win32":
      return join(requireLocalAppData(ctx.env), "mba", "model_hub", "adapters");
    case "linux":
    case "other":
    default: {
      const xdg = ctx.env.XDG_DATA_HOME;
      const base = xdg && xdg.length > 0 ? xdg : join(ctx.homedir, ".local", "share");
      return join(base, "mba", "model_hub", "adapters");
    }
  }
}

/**
 * Windows %APPDATA% (roaming). Throws if unset — there is no sane fallback on
 * Windows, and a missing %APPDATA% means the environment is broken.
 */
function requireAppData(env: NodeJS.ProcessEnv): string {
  const v = env.APPDATA;
  if (!v || v.length === 0) {
    throw new Error("APPDATA is not set — cannot resolve the Windows state dir");
  }
  return v;
}

/**
 * Windows %LOCALAPPDATA% (per-user, non-roaming — the right home for big data).
 * Throws if unset, for the same reason as requireAppData.
 */
function requireLocalAppData(env: NodeJS.ProcessEnv): string {
  const v = env.LOCALAPPDATA;
  if (!v || v.length === 0) {
    throw new Error("LOCALAPPDATA is not set — cannot resolve the Windows store dir");
  }
  return v;
}

/**
 * Create a directory (and any missing parents) if it does not already exist.
 * This is the "MBA owns its locations" guarantee: a fresh install gets a real,
 * ready-to-use directory on first run instead of a dangling default string.
 * Idempotent — safe to call on every boot.
 */
export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}
