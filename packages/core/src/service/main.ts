/**
 * MBA service entry point (ADR-0092 Step 2).
 *
 * Boots the global MBA service: binds 127.0.0.1 on an OS-assigned port,
 * writes a discovery file (`~/.cyard/mba/service.json`) so consumers (the
 * proxy) can find it, and stays up until SIGINT/SIGTERM.
 *
 * Run with: `npm run dev -w @mba-ai/core` (or `npm start -w @mba-ai/core`).
 *
 * Env:
 *   CYARD_MBA_BASE_DIR   — store base dir (default `~/.cyard`)
 *   CYARD_MBA_LEGACY_TCB — per-project TCB path to migrate from on first boot
 *   MBA_ADAPTER_DIR      — adapter tree root (default `~/models/adapters`)
 *   MBA_UPSTREAM_URL     — upstream llama-server base URL (e.g. http://127.0.0.1:8080)
 *   MBA_MODEL_SWITCH     — "on" arms model switching (ADR-0093: OFF by default)
 *   MBA_BOOT_SCRIPT      — boot script for the default switch executor
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { defaultStorePaths, readGlobalConfig, writeServiceInfo } from "./config-store.js";
import { startMbaService } from "./server.js";

const baseDir = process.env.CYARD_MBA_BASE_DIR;
const paths = defaultStorePaths(baseDir);
const legacyTcbPath = process.env.CYARD_MBA_LEGACY_TCB;
const adapterDir = process.env.MBA_ADAPTER_DIR ?? join(homedir(), "models", "adapters");
const upstreamUrl = process.env.MBA_UPSTREAM_URL;
const switchEnabled = process.env.MBA_MODEL_SWITCH === "on";

// First-boot migration/seed happens here so the store is warm before the
// first request.
const initial = readGlobalConfig(paths, { legacyTcbPath });

const handle = await startMbaService({
  paths,
  legacyTcbPath,
  adapterDir,
  upstreamUrl,
  switchEnabled,
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

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[mba] ${signal} received, closing…`);
  try {
    await handle.close();
  } finally {
    process.exit(0);
  }
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
