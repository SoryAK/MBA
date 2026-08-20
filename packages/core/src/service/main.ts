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
 */

import { defaultStorePaths, readGlobalConfig, writeServiceInfo } from "./config-store.js";
import { startMbaService } from "./server.js";

const baseDir = process.env.CYARD_MBA_BASE_DIR;
const paths = defaultStorePaths(baseDir);
const legacyTcbPath = process.env.CYARD_MBA_LEGACY_TCB;

// First-boot migration/seed happens here so the store is warm before the
// first request.
const initial = readGlobalConfig(paths, { legacyTcbPath });

const handle = await startMbaService({ paths, legacyTcbPath });
writeServiceInfo(paths, {
  port: handle.port,
  pid: process.pid,
  startedAt: new Date().toISOString(),
});

console.log(`[mba] service listening on ${handle.url}`);
console.log(`[mba] store base: ${paths.baseDir}`);
console.log(`[mba] initial version: ${initial.version}`);
console.log(`[mba] discovery file: ${paths.serviceInfoPath}`);

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
