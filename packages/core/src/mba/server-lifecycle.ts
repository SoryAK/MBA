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

import { spawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { dirname, join } from "node:path";
import { createWriteStream, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { daemonLog } from "./daemon-log.js";

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
  /**
   * Model-load duration in ms (spawn → /health "ok"). Ollama-style
   * observability: slow loads (APU shared-RAM) become visible instead of
   * looking like hangs.
   */
  readonly loadMs: number;
}

/**
 * Injectable seams for the lifecycle module. Every field is optional; when
 * absent the real Node implementation is used. Tests supply fakes to avoid
 * spawning real processes or hitting the network.
 */
export interface LifecycleSeams {
  /** Spawn a child process. Defaults to `node:child_process` `spawn`. */
  readonly spawnImpl?: (
    binary: string,
    args: string[],
    opts: SpawnOptions,
  ) => ChildProcess;
  /** HTTP client. Defaults to global `fetch`. */
  readonly fetchImpl?: typeof fetch;
  /**
   * Signal a process (or process group when pid is negative).
   * Contract: return `true` if the process was alive / the signal was
   * delivered, `false` if the process was not found. A signal of `0` is a
   * liveness probe (no signal is sent).
   */
  readonly killImpl?: (pid: number, signal?: NodeJS.Signals | number) => boolean;
  /** Clock. Defaults to `Date.now`. */
  readonly now?: () => number;
  /**
   * Health-check STALL window in ms: the max time to wait for the next
   * /health response after the last one. A load that keeps answering
   * "loading model" never hits it; a stuck load does. Defaults to 180_000
   * (boot script parity).
   */
  readonly healthDeadlineMs?: number;
  /**
   * Check whether a TCP port is free (no listener). Defaults to a real
   * `node:net` probe. Return `true` if the port is free, `false` if occupied.
   */
  readonly portCheckImpl?: (port: number) => Promise<boolean>;
  /**
   * Create a directory recursively (G3 slot-save dir, log dir). Defaults to
   * `node:fs` `mkdirSync`. Tests supply a no-op to avoid real filesystem
   * writes.
   */
  readonly mkdirImpl?: (path: string, opts: { recursive: boolean }) => void;
  /**
   * Sleep for `ms` (poll interval). Defaults to `setTimeout`. Tests supply a
   * fake that advances a controllable clock so multi-minute waits run in
   * microseconds.
   */
  readonly sleepImpl?: (ms: number) => Promise<void>;
}

/** Resolve a seam to its real default. */
export function resolveSeams(seams?: LifecycleSeams): Required<LifecycleSeams> {
  return {
    spawnImpl: seams?.spawnImpl ?? spawn,
    fetchImpl: seams?.fetchImpl ?? fetch,
    killImpl:
      seams?.killImpl ??
      ((pid: number, signal?: NodeJS.Signals | number) => {
        process.kill(pid, signal);
        return true;
      }),
    now: seams?.now ?? Date.now,
    healthDeadlineMs: seams?.healthDeadlineMs ?? 180_000,
    portCheckImpl: seams?.portCheckImpl ?? defaultPortCheck,
    mkdirImpl: seams?.mkdirImpl ?? ((p, o) => mkdirSync(p, o)),
    sleepImpl: seams?.sleepImpl ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
  };
}

/**
 * Default port check: attempt to bind a TCP socket to the port. If the bind
 * succeeds, the port is free; if it fails with EADDRINUSE, the port is occupied.
 */
async function defaultPortCheck(port: number): Promise<boolean> {
  const net = await import("node:net");
  return new Promise<boolean>((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

/**
 * Model-specific KV slot-save path (G3): `<dirname(modelPath)>/kv/<fork>/slots`.
 * Mirrors the boot script's `SLOT_SAVE_PATH="${local_model_dir}/kv/${FORK}/slots"`.
 */
export function slotSavePath(modelPath: string, fork: "upstream" | "cachyllama"): string {
  return join(dirname(modelPath), "kv", fork, "slots");
}

/**
 * Poll /health endpoint until the model is loaded, or the load STALLS.
 *
 * llama-server's /health contract (verified live, mirrors Ollama's
 * WaitUntilRunning):
 *   200 {"status":"ok"}           → model loaded, ready
 *   503 {"status":"loading model"} → still loading (progress)
 *   503 {"status":"error"}         → load failed (fail fast, no retry)
 *
 * The deadline is STALL-based, not wall-clock: `deadlineMs` is the maximum
 * time to wait for the NEXT health response after the last one. A slow load
 * (e.g. a 17GB model into shared RAM on an APU) keeps answering "loading
 * model" and therefore never hits the deadline; a genuinely stuck load stops
 * answering and times out. Connection failures (server not up yet, or went
 * silent) are NOT activity — they do not extend the window, so a dead or
 * wedged server fails the boot instead of hanging forever.
 *
 * @throws {Error} if the load stalls (no health response for `deadlineMs`)
 *   or /health reports an explicit error
 */
export async function waitForHealth(
  port: number,
  deadlineMs: number = 180_000,
  seams?: LifecycleSeams,
): Promise<void> {
  const { fetchImpl, now, sleepImpl } = resolveSeams(seams);
  const url = `http://127.0.0.1:${port}/health`;
  const pollInterval = 2000; // 2s, matching bash script
  const startedAt = now();

  // Trace: log on status CHANGES only (not every 2s poll), so a 10-minute
  // load produces a handful of lines, not hundreds.
  let lastLogged = "";
  const logStatus = (status: string) => {
    if (status !== lastLogged) {
      lastLogged = status;
      daemonLog(
        `[health:${port}] ${status} (t+${Math.round((now() - startedAt) / 1000)}s)`,
      );
    }
  };

  // The deadline is STALL-based (Ollama WaitUntilRunning parity): it is the
  // max time to wait for the NEXT health response after the last one.
  // A server that keeps answering "loading model" is alive and working —
  // each response extends the window. A server that stops answering
  // (crashed, wedged) hits the window and the boot fails instead of
  // hanging forever. Connection failures do NOT extend the window.
  let deadline = now() + deadlineMs;
  for (;;) {
    // Stall check FIRST: if the last activity (a health response or a
    // connection attempt) is older than the window, the load has stalled.
    if (now() >= deadline) {
      daemonLog(
        `[health:${port}] STALLED — no health progress for ${deadlineMs}ms (t+${Math.round((now() - startedAt) / 1000)}s)`,
      );
      throw new Error(
        `llama-server load stalled on port ${port}: no health progress for ${deadlineMs}ms`,
      );
    }
    try {
      const resp = await fetchImpl(url, { signal: AbortSignal.timeout(5000) });
      deadline = now() + deadlineMs; // a response is activity
      if (resp.ok) {
        logStatus("ok — healthy");
        return; // healthy
      }
      // Parse the status body; a malformed body degrades to "keep polling".
      let body: { status?: unknown; message?: unknown };
      try {
        body = (await resp.json()) as { status?: unknown; message?: unknown };
      } catch {
        body = {};
      }
      if (body.status === "error") {
        const detail =
          typeof body.message === "string" && body.message.length > 0
            ? `: ${body.message}`
            : "";
        daemonLog(`[health:${port}] ERROR from server${detail}`);
        throw new Error(`llama-server reported a load error on port ${port}${detail}`);
      }
      // "loading model" (and any unrecognized status) → still working.
      logStatus(
        typeof body.status === "string" && body.status.length > 0
          ? body.status
          : `http ${resp.status} (unparseable body)`,
      );
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("llama-server reported")) {
        throw err; // explicit load error — fail fast
      }
      // fetch failed (connection refused, timeout) — server not up yet or
      // went silent. NOT load progress: the deadline is not extended, so a
      // server that stops answering hits the stall window and fails.
      logStatus(
        `fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    await sleepImpl(pollInterval);
  }
}

/**
 * Send a warmup request to the server (POST /completion).
 * Generates `tokens` to pre-fill the GPU.
 *
 * @throws {Error} if the warmup POST fails
 */
export async function sendWarmupRequest(
  port: number,
  tokens: number,
  seams?: LifecycleSeams,
): Promise<void> {
  const { fetchImpl } = resolveSeams(seams);
  const url = `http://127.0.0.1:${port}/completion`;
  const payload = {
    prompt: "test",
    n_predict: tokens,
  };

  const resp = await fetchImpl(url, {
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
 * Deployment facts (`--host`, `--port`, `--slot-save-path`, `-m <model>`) are
 * prepended here; `opts.flags` carries only the tuning recipe. The server is
 * spawned `detached` so it owns its own process group (G1), and the boot
 * resolves only after warmup completes (Perf #2).
 *
 * @returns ServerState with the CHILD pid, port, boot time, and flags.
 * @throws {Error} if spawn fails, health check times out, or warmup fails
 */
export async function bootLlamaServer(
  opts: ServerBootOptions,
  seams?: LifecycleSeams,
): Promise<ServerState> {
  const { spawnImpl, fetchImpl, killImpl, now, healthDeadlineMs, mkdirImpl, sleepImpl } =
    resolveSeams(seams);

  // G3: llama-server hard-fails when --slot-save-path is not an existing
  // directory. Self-heal: create it here so models pulled before the
  // pull-time scaffold (or with a hand-edited store) still boot.
  const slotPath = slotSavePath(opts.modelPath, opts.fork);
  mkdirImpl(slotPath, { recursive: true });

  // Deployment facts first, then the tuning recipe.
  const args = [
    "--host",
    "127.0.0.1",
    "--port",
    String(opts.port),
    "--slot-save-path",
    slotPath,
    "-m",
    opts.modelPath,
    ...opts.flags,
  ];

  // Create log directory if it doesn't exist.
  const logDir = join(homedir(), ".local", "share", "mba", "logs");
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, `llama-server-${opts.port}.log`);

  let child: ChildProcess;
  try {
    child = spawnImpl(opts.binaryPath, args, {
      detached: true, // own process group → group-killable (G1)
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    daemonLog(`[boot:${opts.port}] spawn FAILED: ${String(err)}`);
    throw new Error(`failed to spawn llama-server: ${String(err)}`);
  }

  if (child.pid === undefined) {
    daemonLog(`[boot:${opts.port}] spawn succeeded but no PID assigned`);
    throw new Error("spawn succeeded but no PID assigned");
  }

  const pid = child.pid;
  const bootedAt = now();
  daemonLog(
    `[boot:${opts.port}] spawned pid ${pid}: ${opts.binaryPath} ${args.join(" ")}`,
  );

  // Read stdout/stderr pipes and write to log file to prevent buffer fill-up.
  const logStream = createWriteStream(logPath, { flags: "a" });
  child.stdout?.on("data", (chunk: Buffer) => logStream.write(chunk));
  child.stderr?.on("data", (chunk: Buffer) => logStream.write(chunk));
  child.stdout?.on("end", () => logStream.end());
  child.stderr?.on("end", () => logStream.end());

  // Detach from the daemon's event loop so the daemon can exit independently.
  child.unref?.();

  // Wait for health check; on failure, kill the CHILD group (never the daemon).
  daemonLog(
    `[boot:${opts.port}] waiting for health (stall deadline ${healthDeadlineMs}ms)`,
  );
  try {
    await waitForHealth(opts.port, healthDeadlineMs, { fetchImpl, now, sleepImpl });
  } catch (err) {
    daemonLog(
      `[boot:${opts.port}] health FAILED after ${now() - bootedAt}ms — killing group ${pid}: ${String(err)}`,
    );
    await killProcessGroup(pid, { killImpl });
    throw err;
  }
  const loadMs = now() - bootedAt;
  daemonLog(`[boot:${opts.port}] healthy — model loaded in ${loadMs}ms`);

  // Execute warmup; boot resolves only after it completes (Perf #2).
  daemonLog(`[boot:${opts.port}] warmup (${opts.warmupTokens} tokens)`);
  try {
    await sendWarmupRequest(opts.port, opts.warmupTokens, { fetchImpl });
  } catch (err) {
    // Warmup failed; the server is healthy but not warmed. Kill + fail so the
    // caller does not register a cold server as ready.
    daemonLog(
      `[boot:${opts.port}] warmup FAILED — killing group ${pid}: ${String(err)}`,
    );
    await killProcessGroup(pid, { killImpl });
    throw new Error(`warmup failed: ${String(err)}`);
  }
  daemonLog(`[boot:${opts.port}] warmup done — boot complete`);

  // Track the group so the daemon-exit handler can sweep it (G1).
  trackOwnedGroup(pid, { killImpl });

  return {
    pid,
    port: opts.port,
    bootedAt,
    flags: opts.flags,
    modelPath: opts.modelPath,
    loadMs,
  };
}

/**
 * Stop a running llama-server process group gracefully.
 * Sends SIGTERM to the group (`-pid`); if it lingers past the 2s grace window,
 * sends SIGKILL to the group. Resolves immediately if the group is already gone.
 */
export async function stopLlamaServer(pid: number, seams?: LifecycleSeams): Promise<void> {
  await killProcessGroup(pid, seams);
}

/**
 * Kill a process group: SIGTERM to `-pid`, then SIGKILL after the grace window
 * if it lingers. A no-op if the group is already gone.
 */
export async function killProcessGroup(pid: number, seams?: LifecycleSeams): Promise<void> {
  const { killImpl } = resolveSeams(seams);
  const group = -pid;

  // Liveness probe: signal 0. If the group is already gone, nothing to do.
  if (!killImpl(group, 0)) {
    return;
  }

  // Graceful group kill.
  killImpl(group, "SIGTERM");

  // Wait up to 2s for graceful shutdown (10 × 200ms).
  let exited = false;
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (!killImpl(group, 0)) {
      exited = true;
      break;
    }
  }

  if (!exited) {
    // Force group kill.
    killImpl(group, "SIGKILL");
  }
}

/**
 * Per-seams registry of owned process-group pids. The daemon-exit handler
 * (G1) sweeps every tracked group on shutdown. Kept on the seams object so
 * tests can isolate their own registry; the daemon passes a single shared
 * seams instance for its lifetime.
 */
const OWNED_GROUPS_KEY = Symbol.for("mba.ownedGroups");

type SeamsWithRegistry = LifecycleSeams & { [OWNED_GROUPS_KEY]?: Set<number> };

function ownedGroupSet(seams?: LifecycleSeams): Set<number> {
  const target = (seams ?? {}) as SeamsWithRegistry;
  if (!target[OWNED_GROUPS_KEY]) {
    target[OWNED_GROUPS_KEY] = new Set<number>();
  }
  return target[OWNED_GROUPS_KEY]!;
}

/** Record a process group as owned by this daemon (called after a successful boot). */
export function trackOwnedGroup(pid: number, seams?: LifecycleSeams): void {
  ownedGroupSet(seams).add(pid);
}

/** Number of process groups currently tracked as owned. */
export function ownedGroupCount(seams?: LifecycleSeams): number {
  return ownedGroupSet(seams).size;
}

/**
 * Kill every tracked process group and clear the registry (G1 daemon-exit
 * handler). Called on daemon SIGTERM/exit so no owned server outlives the
 * daemon.
 */
export async function killAllOwnedGroups(seams?: LifecycleSeams): Promise<void> {
  const set = ownedGroupSet(seams);
  const pids = [...set];
  set.clear();
  for (const pid of pids) {
    await killProcessGroup(pid, seams);
  }
}
