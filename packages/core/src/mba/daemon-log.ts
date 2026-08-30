/**
 * Daemon trace logger.
 *
 * The MBA daemon runs under systemd --user with stdout/stderr wired to the
 * journal socket, so `console.log` from the boot path is invisible in any
 * file a human can `tail`. This module mirrors every trace line to a real
 * file — `~/.local/share/mba/logs/mba-daemon.log`, alongside the per-port
 * `llama-server-<port>.log` files — so the whole boot sequence (recipe →
 * port check → spawn → health polls → warmup → outcome) is inspectable.
 *
 * Gated by `MBA_TRACE` (default ON while boot debugging is active; set
 * `MBA_TRACE=off` to silence). Writes are synchronous and low-frequency
 * (one-shot step lines + health status *changes*, not every poll), so the
 * hot path is unaffected.
 *
 * Standalone on purpose: no imports from other mba modules, so it can be
 * used anywhere without creating an import cycle.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/** Resolve the daemon log path once (lazy, so import has no side effects). */
let logPath: string | undefined;
function resolveLogPath(): string {
  if (!logPath) {
    const dir = join(homedir(), ".local", "share", "mba", "logs");
    mkdirSync(dir, { recursive: true });
    logPath = join(dir, "mba-daemon.log");
  }
  return logPath;
}

/** Whether tracing is enabled (`MBA_TRACE=off` disables; default on). */
function traceEnabled(): boolean {
  return process.env.MBA_TRACE !== "off";
}

/**
 * Append one timestamped trace line to the daemon log and echo it to the
 * journal. Safe to call unconditionally — it is a no-op when `MBA_TRACE=off`
 * or when the file cannot be written (a logging failure must never break a
 * boot).
 */
export function daemonLog(msg: string): void {
  if (!traceEnabled()) return;
  const line = `[${new Date().toISOString()}] ${msg}`;
  // Journal copy (harmless if the socket is gone).
  console.log(`[mba] ${msg}`);
  try {
    appendFileSync(resolveLogPath(), line + "\n");
  } catch {
    // Never let a logging failure break the boot path.
  }
}
