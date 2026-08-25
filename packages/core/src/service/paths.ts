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

import { cpSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { homedir as osHomedir } from "node:os";
import { dirname, join } from "node:path";

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
 * The legacy (pre-Phase-4) locations, kept ONLY so `migrate-paths` can find
 * what to move. Do not use these as live defaults.
 */
export function legacyStateDir(ctx: PathContext = livePathContext()): string {
  return join(ctx.homedir, ".mba");
}

export function legacyModelStoreRoot(ctx: PathContext = livePathContext()): string {
  return join(ctx.homedir, "models", "adapters");
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

// --- One-time migration (legacy → OS-aware) ---------------------------------
//
// `migrate-paths` moves MBA's two homes from the old hardcoded locations to
// the OS-aware ones. It is explicit (the user runs it), idempotent (a second
// run finds nothing to move), and conservative (it never overwrites a
// non-empty destination). The pure core below is filesystem-free so the
// decision logic is testable; the CLI wires it to the real paths.

/** The outcome of migrating a single home (state or store). */
export type MigrationOutcome =
  | { readonly status: "moved"; readonly from: string; readonly to: string }
  | { readonly status: "skipped-missing-source"; readonly from: string; readonly to: string }
  | { readonly status: "skipped-destination-exists"; readonly from: string; readonly to: string };

/**
 * Decide what to do for ONE home, given the current state of the two
 * directories. Pure — no filesystem access — so the decision table is
 * directly testable.
 *
 *   - source missing            → nothing to move (fresh install, or already
 *                                 migrated). Skip.
 *   - destination exists non-empty → REFUSE. We will not clobber data the
 *                                 user may have placed there. Skip with a
 *                                 distinct status so the caller can warn.
 *   - otherwise (source present, destination absent or empty) → move.
 */
export function planMigration(
  sourceExists: boolean,
  destinationExists: boolean,
  destinationEmpty: boolean,
  from: string,
  to: string,
): MigrationOutcome {
  if (!sourceExists) {
    return { status: "skipped-missing-source", from, to };
  }
  if (destinationExists && !destinationEmpty) {
    return { status: "skipped-destination-exists", from, to };
  }
  return { status: "moved", from, to };
}

/**
 * Perform the actual move for one home, applying the plan from
 * {@link planMigration}. `sourceExists` / `destinationExists` /
 * `destinationEmpty` are read by the caller (which owns the filesystem
 * probes) and passed in, keeping this function's contract explicit.
 *
 * The move is a `renameSync` when source and destination are on the same
 * filesystem (the common case — both under the user's home), which is a
 * metadata op, not a copy. If they are on different devices, `renameSync`
 * throws EXDEV and we fall back to a recursive copy + delete.
 */
export function executeMigration(
  from: string,
  to: string,
  sourceExists: boolean,
  destinationExists: boolean,
  destinationEmpty: boolean,
): MigrationOutcome {
  const plan = planMigration(sourceExists, destinationExists, destinationEmpty, from, to);
  if (plan.status !== "moved") return plan;
  // renameSync does not create the destination's parents. The store's new home
  // (…/mba/model_hub/adapters) sits under parents that a fresh install has not
  // made yet, so create them first.
  mkdirSync(dirname(to), { recursive: true });
  try {
    renameSync(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    // Cross-device: copy the tree, then remove the source.
    cpSync(from, to, { recursive: true });
    rmSync(from, { recursive: true, force: true });
  }
  return { status: "moved", from, to };
}
