/**
 * `mba start` / `mba stop` — background daemon (systemd --user when available).
 * `--foreground` is this process. Every other `mba` verb stays a thin client.
 */

import { fail, readServiceDiscovery } from "./client.js";
import {
  hasUserSystemd,
  installUserUnit,
  spawnDetachedDaemon,
  startUserUnit,
  stopUserUnit,
  systemdUnitActive,
} from "./systemd-user.js";

export type StartPlan = "start" | "already-running" | "stale-pid";
export type StopPlan = "signal" | "not-running" | "stale-pid";

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "EPERM" || code === "EACCES";
  }
}

export async function isServiceAnswering(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/status`, { signal: AbortSignal.timeout(800) });
    return res.ok;
  } catch {
    return false;
  }
}

export function planStart(
  disc: { url: string; pid: number | null } | null,
  pidAlive: boolean,
  answering: boolean,
): StartPlan {
  if (!disc || disc.pid === null || !pidAlive) return "start";
  if (answering) return "already-running";
  return "stale-pid";
}

export function planStop(
  disc: { url: string; pid: number | null } | null,
  pidAlive: boolean,
  answering: boolean,
): StopPlan {
  if (!disc || disc.pid === null || !pidAlive) return "not-running";
  if (answering) return "signal";
  return "stale-pid";
}

const STOP_WAIT_MS = 10_000;
const START_WAIT_MS = 20_000;
const POLL_MS = 50;

export async function waitUntilDead(pid: number, timeoutMs: number = STOP_WAIT_MS): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  return !isPidAlive(pid);
}

async function waitUntilAnswering(timeoutMs: number = START_WAIT_MS): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const disc = readServiceDiscovery();
    if (disc && (await isServiceAnswering(disc.url))) return disc.url;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  const disc = readServiceDiscovery();
  if (disc && (await isServiceAnswering(disc.url))) return disc.url;
  return null;
}

export async function cmdStart(foreground: boolean = false): Promise<void> {
  const disc = readServiceDiscovery();
  const pidAlive = typeof disc?.pid === "number" ? isPidAlive(disc.pid) : false;
  const answering = disc && pidAlive ? await isServiceAnswering(disc.url) : false;
  const plan = planStart(disc, pidAlive, answering);

  if (plan === "already-running" && disc) {
    process.stdout.write(`[mba] already running at ${disc.url}\n`);
    return;
  }
  if (plan === "stale-pid" && disc?.pid !== null && disc?.pid !== undefined) {
    fail(
      `service.json pid ${disc.pid} is alive but not answering at ${disc.url} — not starting a second daemon`,
    );
  }

  if (foreground) {
    await import("../service/main.js");
    return;
  }

  if (hasUserSystemd()) {
    try {
      installUserUnit();
      startUserUnit();
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }
    const url = await waitUntilAnswering();
    if (!url) fail("daemon unit started but is not answering yet — mba status");
    process.stdout.write(`[mba] started at ${url}\n`);
    return;
  }

  spawnDetachedDaemon();
  const url = await waitUntilAnswering();
  if (!url) fail("daemon spawned but is not answering yet — try mba start --foreground");
  process.stdout.write(`[mba] started at ${url}\n`);
}

export async function cmdStop(): Promise<void> {
  if (hasUserSystemd() && systemdUnitActive()) {
    try {
      stopUserUnit();
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }
    const disc = readServiceDiscovery();
    if (typeof disc?.pid === "number") {
      const dead = await waitUntilDead(disc.pid);
      if (!dead) fail(`pid ${disc.pid} still running after systemctl stop`);
    }
    process.stdout.write("[mba] stopped\n");
    return;
  }

  const disc = readServiceDiscovery();
  const pidAlive = typeof disc?.pid === "number" ? isPidAlive(disc.pid) : false;
  const answering = disc && pidAlive ? await isServiceAnswering(disc.url) : false;
  const plan = planStop(disc, pidAlive, answering);

  if (plan === "not-running") {
    process.stdout.write("[mba] not running\n");
    return;
  }
  if (plan === "stale-pid" && disc?.pid !== null && disc?.pid !== undefined) {
    fail(
      `service.json pid ${disc.pid} is alive but not answering at ${disc.url} — not sending SIGTERM`,
    );
  }

  const pid = disc?.pid;
  if (typeof pid !== "number") {
    process.stdout.write("[mba] not running\n");
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch (err) {
    fail(`could not signal pid ${pid}: ${err instanceof Error ? err.message : String(err)}`);
  }

  const dead = await waitUntilDead(pid);
  if (!dead) fail(`pid ${pid} still running after SIGTERM`);
  process.stdout.write("[mba] stopped\n");
}
