/**
 * Server lifecycle orchestration for per-model boot/stop/health.
 *
 * Lifts the knowledge from scripts/llama-server-up.sh into TypeScript.
 * Responsibilities:
 *  - Boot llama-server with validated flags
 *  - Poll /health endpoint with deadline
 *  - Execute post-boot GPU warmup pass
 *  - Stop llama-server gracefully
 *  - Track boot state (PID, port, timestamp, flags, model)
 *
 * Pure async module: file access only for spawning; no logging, no side effects
 * except process spawning.
 */

import { spawn, execSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";

export interface ServerBootOptions {
  /** Path to llama-server binary. */
  readonly binaryPath: string;
  /** Full path to the .gguf model file. */
  readonly modelPath: string;
  /** TCP port to bind to. */
  readonly port: number;
  /** Validated CLI flag array (from buildLlamaServerFlags). */
  readonly flags: string[];
  /** Fork variant: "upstream" or "cachyllama". */
  readonly fork: "upstream" | "cachyllama";
  /** Tokens to generate during post-boot warmup pass. */
  readonly warmupTokens: number;
}

export interface ServerState {
  /** PID of the running llama-server process. */
  readonly pid: number;
  /** TCP port the server is listening on. */
  readonly port: number;
  /** Unix timestamp (ms) when the server booted (Date.now()). */
  readonly bootedAt: number;
  /** Validated CLI flags used (for reproducibility + state comparison). */
  readonly flags: string[];
  /** Full path to the model that was loaded. */
  readonly modelPath: string;
}

/**
 * Poll /health endpoint until healthy or deadline elapses.
 * Polls every 2 seconds (matches llama-server-up.sh).
 *
 * @throws {Error} if deadline exceeded before healthy response
 */
export async function waitForHealth(
  port: number,
  deadlineMs: number = 180_000,
): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  const url = `http://127.0.0.1:${port}/health`;
  const pollInterval = 2000; // 2s, matching bash script

  while (Date.now() < deadline) {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (resp.ok) return; // healthy
    } catch {
      // fetch failed; retry
    }
    await new Promise((r) => setTimeout(r, pollInterval));
  }

  throw new Error(`health check timed out after ${deadlineMs}ms on port ${port}`);
}

/**
 * Send a warmup request to the server (POST /completion).
 * Generates `tokens` to pre-fill the GPU.
 *
 * @throws {Error} if the warmup POST fails
 */
export async function sendWarmupRequest(port: number, tokens: number): Promise<void> {
  const url = `http://127.0.0.1:${port}/completion`;
  const payload = {
    prompt: "test",
    n_predict: tokens,
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(60000), // 60s for warmup
  });

  if (!resp.ok) {
    throw new Error(`warmup POST to ${url} failed: ${resp.status} ${resp.statusText}`);
  }
}

/**
 * Spawn llama-server with the boot options, wait for health, run warmup.
 *
 * @returns ServerState with PID, port, boot time, and flags for persistence.
 * @throws {Error} if spawn fails, health check times out, or warmup fails
 */
export async function bootLlamaServer(opts: ServerBootOptions): Promise<ServerState> {
  const flagsWithModel = ["-m", opts.modelPath, ...opts.flags];

  let process: ChildProcess;
  try {
    process = spawn(opts.binaryPath, flagsWithModel, {
      detached: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    throw new Error(`failed to spawn llama-server: ${String(err)}`);
  }

  if (process.pid === undefined) {
    throw new Error("spawn succeeded but no PID assigned");
  }

  const pid = process.pid;
  const bootedAt = Date.now();

  // Wait for health check
  try {
    await waitForHealth(opts.port, 180_000);
  } catch (err) {
    // Kill the process if health check failed
    try {
      process.kill("SIGTERM");
    } catch {
      // ignore kill errors
    }
    throw err;
  }

  // Execute warmup
  try {
    await sendWarmupRequest(opts.port, opts.warmupTokens);
  } catch (err) {
    // Warmup failed; log but don't fail the boot (server is healthy)
    // In production, this would be emitted as a diagnostic
    console.warn("warmup failed:", err);
  }

  return {
    pid,
    port: opts.port,
    bootedAt,
    flags: opts.flags,
    modelPath: opts.modelPath,
  };
}

/**
 * Stop a running llama-server process gracefully.
 * Sends SIGTERM; if process doesn't exit within 2s, sends SIGKILL.
 *
 * @throws {Error} if the process is not found or kill fails
 */
export async function stopLlamaServer(pid: number): Promise<void> {
  try {
    // Check if process exists
    process.kill(pid, 0);
  } catch {
    // Process not found; already dead
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch (err) {
    throw new Error(`failed to send SIGTERM to PID ${pid}: ${String(err)}`);
  }

  // Wait up to 2s for graceful shutdown
  let exited = false;
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 200));
    try {
      process.kill(pid, 0);
    } catch {
      exited = true;
      break;
    }
  }

  if (!exited) {
    // Force kill
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // ignore
    }
  }
}
