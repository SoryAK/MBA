/**
 * MBA service entry point (ADR-0092 Step 2).
 *
 * Boots the global MBA service: binds 127.0.0.1 on an OS-assigned port,
 * writes a discovery file (`<state>/mba/service.json`) so consumers (the
 * proxy) can find it, and stays up until SIGINT/SIGTERM.
 *
 * Run with: `npm run dev -w @mba-ai/core` (or `npm start -w @mba-ai/core`).
 *
 * Env:
 *   MBA_BASE_DIR         — store base dir (default: OS-aware, see service/paths.ts;
 *                          `CYARD_MBA_BASE_DIR` is a deprecated alias)
 *   MBA_ADAPTER_DIR      — adapter tree root (default: OS-aware model store, see service/paths.ts)
 *   MBA_UPSTREAM_URL     — upstream llama-server base URL (e.g. http://127.0.0.1:8080)
 *   MBA_MODEL_SWITCH     — "on" arms model switching (ADR-0093: OFF by default)
 *   MBA_SWITCH_PORT      — port for the in-daemon switch/boot (default 8080)
 *   MBA_ENDPOINT_SYNC    — "off" disables VS Code endpoint auto-sync (default on)
 *   MBA_VSCODE_LM_CONFIG — chatLanguageModels.json path (default: the active
 *                          profile's file under ~/.config/Code/User/profiles)
 *   MBA_VSCODE_LM_API_KEY_REF — apiKey reference for the generated block
 */

import { homedir } from "node:os";
import { join } from "node:path";
import {
  defaultStorePaths,
  migrateLegacyBaseDir,
  readGlobalConfig,
  writeServiceInfo,
} from "./config-store.js";
import { defaultModelStoreRoot, defaultStateDir, ensureDir } from "./paths.js";
import { buildCtxSizeResolver } from "./ctx-size-resolver.js";
import { syncVsCodeEndpoints, watchAdapterDir } from "./model-endpoint-sync.js";
import { startMbaService } from "./server.js";
import { killAllOwnedGroups, ownedGroupCount, type LifecycleSeams } from "../mba/index.js";

// `CYARD_MBA_BASE_DIR` is a deprecated alias kept for existing setups.
const baseDir = process.env.MBA_BASE_DIR ?? process.env.CYARD_MBA_BASE_DIR;
const paths = defaultStorePaths(baseDir);
const adapterDir = process.env.MBA_ADAPTER_DIR ?? defaultModelStoreRoot();
// MBA owns the model store root: a fresh install gets a real directory on
// first boot instead of a dangling default string (ADR-0097 Phase 4).
ensureDir(adapterDir);
const upstreamUrl = process.env.MBA_UPSTREAM_URL;
const switchEnabled = process.env.MBA_MODEL_SWITCH === "on";
const endpointSyncEnabled = process.env.MBA_ENDPOINT_SYNC !== "off";
const vscodeLmConfig =
  process.env.MBA_VSCODE_LM_CONFIG ??
  join(homedir(), ".config", "Code", "User", "profiles", "51cf1714", "chatLanguageModels.json");
const vscodeLmApiKeyRef =
  process.env.MBA_VSCODE_LM_API_KEY_REF ?? "${input:chat.lm.secret.11180837}";

// One-time migration from the legacy `~/.cyard` base dir. Only when the
// default location is in use — an explicit MBA_BASE_DIR is the user's choice.
if (!baseDir) {
  const migrated = migrateLegacyBaseDir();
  if (migrated.length > 0) {
    console.log(`[mba] migrated ${migrated.length} file(s) from ~/.cyard to ${defaultStateDir()}`);
  }
}

// First-boot seed happens here so the store is warm before the first request.
const initial = readGlobalConfig(paths);

// G1: one shared lifecycle seams instance for the daemon's lifetime. The
// owned-group registry lives on it, so the exit handler can kill every
// server process group the daemon booted.
const lifecycleSeams: LifecycleSeams = {};

const handle = await startMbaService({
  paths,
  adapterDir,
  upstreamUrl,
  switchEnabled,
  lifecycleSeams,
});
writeServiceInfo(paths, {
  port: handle.port,
  pid: process.pid,
  startedAt: new Date().toISOString(),
});

console.log(`[mba] service listening on ${handle.url}`);
console.log(`[mba] store base: ${paths.baseDir}`);
console.log(`[mba] initial version: ${initial.version}`);
console.log(`[mba] discovery file: ${paths.serviceInfoPath}`);
console.log(`[mba] model plane: adapters=${adapterDir} upstream=${upstreamUrl ?? "(unset)"} switch=${switchEnabled ? "on" : "off"}`);

// VS Code endpoint auto-sync (ADR-0093 Phase 4): seed once at boot, then
// keep the generated block in step with the adapter tree.
let stopEndpointWatch: (() => void) | null = null;
if (endpointSyncEnabled) {
  // Option C: the boot sync and the watcher share the same resolver so the
  // inherited context size (when a YAML omits `client.contextSize`) matches
  // the one-shot CLI and the server recipe.
  const syncOpts = {
    adapterDir,
    configPath: vscodeLmConfig,
    apiKeyRef: vscodeLmApiKeyRef,
    resolveCtxSize: buildCtxSizeResolver(adapterDir),
  };
  try {
    const boot = syncVsCodeEndpoints(syncOpts);
    if (boot.created || boot.updated) {
      console.log(
        `[mba] endpoint sync: ${boot.created ? "created" : "updated"} ${vscodeLmConfig} ` +
          `(${boot.models.length} model${boot.models.length === 1 ? "" : "s"})`,
      );
    }
  } catch (err) {
    console.warn(`[mba] endpoint sync failed at boot: ${String(err)}`);
  }
  stopEndpointWatch = watchAdapterDir(adapterDir, syncOpts, (msg) => console.log(msg));
  console.log(`[mba] endpoint sync: watching ${adapterDir} → ${vscodeLmConfig}`);
} else {
  console.log(`[mba] endpoint sync: off`);
}

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[mba] ${signal} received, closing…`);
  stopEndpointWatch?.();
  try {
    // G1: kill every server group this daemon booted before exiting.
    const owned = ownedGroupCount(lifecycleSeams);
    if (owned > 0) {
      console.log(`[mba] killing ${owned} owned server group(s)…`);
    }
    await killAllOwnedGroups(lifecycleSeams);
    await handle.close();
  } finally {
    process.exit(0);
  }
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
