/**
 * Contract tests for server-lifecycle orchestration (Step 4).
 *
 * Tests focus on the pure fetch-based logic (health check, warmup).
 * Process spawning/management is tested via integration on boot.
 */

import { describe, expect, it, vi, afterEach } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import {
  waitForHealth,
  sendWarmupRequest,
  bootLlamaServer,
  stopLlamaServer,
  killProcessGroup,
  killAllOwnedGroups,
  trackOwnedGroup,
  ownedGroupCount,
  type LifecycleSeams,
} from "./server-lifecycle.js";

/** A fake ChildProcess: records the pid, swallows events, no real process. */
function fakeChild(pid: number): ChildProcess {
  return {
    pid,
    kill: vi.fn(),
    on: vi.fn(),
    once: vi.fn(),
    unref: vi.fn(),
    stdout: null,
    stderr: null,
    stdin: null,
  } as unknown as ChildProcess;
}

/** Build a spawn seam that returns a fixed fake child and records the options. */
function spawnSeam(pid: number) {
  const calls: Array<{ binary: string; args: string[]; opts: unknown }> = [];
  const spawnImpl = vi.fn((_binary: string, args: string[], opts: unknown) => {
    calls.push({ binary: _binary, args, opts });
    return fakeChild(pid);
  });
  return { spawnImpl, calls };
}

/**
 * A controllable clock: `advance(ms)` moves time forward. Lets tests run
 * multi-minute health waits in microseconds.
 */
function fakeClock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe("bootLlamaServer (process-group ownership, ADR-0097 Phase 2)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the CHILD pid, not the daemon pid", async () => {
    const { spawnImpl, calls } = spawnSeam(424242);
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200 })) as unknown as typeof fetch;

    const state = await bootLlamaServer(
      {
        binaryPath: "/bin/llama-server",
        modelPath: "/models/qwen.gguf",
        port: 8080,
        flags: ["--ctx-size", "1000"],
        fork: "upstream",
        warmupTokens: 0,
      },
        { spawnImpl: spawnImpl as never, fetchImpl, mkdirImpl: vi.fn() },
    );

    expect(state.pid).toBe(424242);
    expect(state.pid).not.toBe(process.pid);
    // -m <model> is prepended to the recipe flags (deployment facts may also be present)
    const args = calls[0]!.args;
    const mIdx = args.indexOf("-m");
    expect(mIdx).toBeGreaterThanOrEqual(0);
    expect(args[mIdx + 1]).toBe("/models/qwen.gguf");
    // The recipe tuning flags are preserved after the model.
    expect(args).toContain("--ctx-size");
    expect(args).toContain("1000");
  });

  it("spawns detached so the server owns its own process group (G1)", async () => {
    const { spawnImpl, calls } = spawnSeam(424242);
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200 })) as unknown as typeof fetch;

    await bootLlamaServer(
      {
        binaryPath: "/bin/llama-server",
        modelPath: "/models/qwen.gguf",
        port: 8080,
        flags: [],
        fork: "upstream",
        warmupTokens: 0,
      },
        { spawnImpl: spawnImpl as never, fetchImpl, mkdirImpl: vi.fn() },
    );

    expect((calls[0]!.opts as { detached?: boolean }).detached).toBe(true);
  });

  it("prepends --host 127.0.0.1 and --port from the boot context", async () => {
    const { spawnImpl, calls } = spawnSeam(424242);
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200 })) as unknown as typeof fetch;

    await bootLlamaServer(
      {
        binaryPath: "/bin/llama-server",
        modelPath: "/models/qwen.gguf",
        port: 9123,
        flags: ["--ctx-size", "1000"],
        fork: "upstream",
        warmupTokens: 0,
      },
        { spawnImpl: spawnImpl as never, fetchImpl, mkdirImpl: vi.fn() },
    );

    const args = calls[0]!.args;
    expect(args).toContain("--host");
    expect(args).toContain("127.0.0.1");
    expect(args).toContain("--port");
    expect(args).toContain("9123");
  });

  it("on health timeout, kills the CHILD group — never the daemon", async () => {
    const { spawnImpl } = spawnSeam(424242);
    const fetchImpl = vi.fn(async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;
    // First liveness probe: alive (so SIGTERM is sent); second: gone (fast exit).
    let probes = 0;
    const killImpl = vi.fn((pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === 0) {
        probes++;
        return probes === 1;
      }
      return true;
    });

    await expect(
      bootLlamaServer(
        {
          binaryPath: "/bin/llama-server",
          modelPath: "/models/qwen.gguf",
          port: 8080,
          flags: [],
          fork: "upstream",
          warmupTokens: 0,
        },
        {
          spawnImpl: spawnImpl as never,
          fetchImpl,
          killImpl: killImpl as never,
          now: () => Date.now(),
          healthDeadlineMs: 100, // short stall window so the timeout fires fast
          mkdirImpl: vi.fn(),
        },
      ),
    ).rejects.toThrow(/stalled/);

    // The cleanup must target the child's group (-424242), not the daemon.
    expect(killImpl).toHaveBeenCalledWith(-424242, "SIGTERM");
    expect(killImpl).not.toHaveBeenCalledWith(process.pid, expect.anything());
    expect(killImpl).not.toHaveBeenCalledWith("SIGTERM"); // no-arg kill (old bug)
  });

  it("waits for warmup to complete before resolving (Perf #2)", async () => {
    const { spawnImpl } = spawnSeam(424242);
    let warmupCalled = false;
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith("/health")) return { ok: true, status: 200 };
      if (u.endsWith("/completion")) {
        warmupCalled = true;
        return { ok: true, status: 200 };
      }
      return { ok: false, status: 404 };
    }) as unknown as typeof fetch;

    const state = await bootLlamaServer(
      {
        binaryPath: "/bin/llama-server",
        modelPath: "/models/qwen.gguf",
        port: 8080,
        flags: [],
        fork: "upstream",
        warmupTokens: 350,
      },
      { spawnImpl: spawnImpl as never, fetchImpl, mkdirImpl: vi.fn() },
    );

    expect(warmupCalled).toBe(true);
    expect(state.pid).toBe(424242);
  });

  it("reports the model-load duration (loadMs) in the returned state", async () => {
    const clock = fakeClock(1_000_000);
    const { spawnImpl } = spawnSeam(424242);
    let healthCalls = 0;
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith("/health")) {
        healthCalls++;
        // First poll: server not up yet (connection refused) → one 2s sleep.
        // Second poll: healthy.
        if (healthCalls === 1) throw new Error("connection refused");
        return { ok: true, status: 200 };
      }
      if (u.endsWith("/completion")) return { ok: true, status: 200 };
      return { ok: false, status: 404 };
    }) as unknown as typeof fetch;

    const state = await bootLlamaServer(
      {
        binaryPath: "/bin/llama-server",
        modelPath: "/models/qwen.gguf",
        port: 8080,
        flags: [],
        fork: "upstream",
        warmupTokens: 0,
      },
      {
        spawnImpl: spawnImpl as never,
        fetchImpl,
        now: clock.now,
        sleepImpl: (ms) => { clock.advance(ms); return Promise.resolve(); },
        mkdirImpl: vi.fn(),
      },
    );

    // The health poll slept 2s before the first "ok" — that is the load time.
    expect(state.loadMs).toBe(2000);
    expect(state.bootedAt).toBe(1_000_000);
  });

  it("creates the per-model kv/<fork>/slots dir before spawn (self-healing G3)", async () => {
    // llama-server hard-fails when --slot-save-path is not an existing
    // directory; boot must create it so models pulled before the pull-time
    // scaffold (or with a hand-edited store) still boot.
    const modelDir = join(
      tmpdir(),
      `mba-lifecycle-test-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    mkdirSync(modelDir, { recursive: true });
    const modelPath = join(modelDir, "model.gguf");
    writeFileSync(modelPath, "fake");
    try {
      const { spawnImpl } = spawnSeam(424242);
      const fetchImpl = vi.fn(async () => ({ ok: true, status: 200 })) as unknown as typeof fetch;

      await bootLlamaServer(
        {
          binaryPath: "/bin/llama-server",
          modelPath,
          port: 8080,
          flags: [],
          fork: "upstream",
          warmupTokens: 0,
        },
        { spawnImpl: spawnImpl as never, fetchImpl },
      );

      expect(existsSync(join(modelDir, "kv", "upstream", "slots"))).toBe(true);
    } finally {
      rmSync(modelDir, { recursive: true, force: true });
    }
  });
});

describe("stopLlamaServer (group kill, G1)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it(
    "sends SIGTERM to the process group (-pid), then SIGKILL if it lingers",
    async () => {
      // The group never dies: every liveness probe reports "alive", so the
      // 2s grace window fully elapses and SIGKILL is issued.
      const killImpl = vi.fn((pid: number, signal?: NodeJS.Signals | number) =>
        signal === 0 ? true : true,
      );

      await stopLlamaServer(424242, { killImpl: killImpl as never });

      // Graceful group kill first…
      expect(killImpl).toHaveBeenCalledWith(-424242, "SIGTERM");
      // …and a force group kill because it lingered past the 2s window.
      expect(killImpl).toHaveBeenCalledWith(-424242, "SIGKILL");
    },
    5000, // the 2s grace window runs in real time
  );

  it("resolves immediately when the group is already gone", async () => {
    const killImpl = vi.fn(() => false); // signal 0 → not found

    await stopLlamaServer(999999, { killImpl: killImpl as never });

    // No SIGTERM/SIGKILL issued — only the liveness probe.
    expect(killImpl).toHaveBeenCalledTimes(1);
    expect(killImpl).toHaveBeenCalledWith(-999999, 0);
  });
});

describe("killProcessGroup / killAllOwnedGroups (G1 daemon-exit handler)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it(
    "killProcessGroup sends SIGTERM to -pid and SIGKILL after the grace window",
    async () => {
      // The group never dies: every liveness probe reports "alive", so the
      // 2s grace window fully elapses and SIGKILL is issued.
      const killImpl = vi.fn((pid: number, signal?: NodeJS.Signals | number) =>
        signal === 0 ? true : true,
      );

      await killProcessGroup(424242, { killImpl: killImpl as never });

      expect(killImpl).toHaveBeenCalledWith(-424242, "SIGTERM");
      expect(killImpl).toHaveBeenCalledWith(-424242, "SIGKILL");
    },
    5000, // the 2s grace window runs in real time
  );

  it(
    "killAllOwnedGroups kills every tracked group and clears the set",
    async () => {
      // Both groups are alive (probe → true) so each gets a SIGTERM; they
      // linger, so each also gets a SIGKILL after the grace window.
      const killImpl = vi.fn((pid: number, signal?: NodeJS.Signals | number) =>
        signal === 0 ? true : true,
      );
      const seams: LifecycleSeams = { killImpl: killImpl as never };

      // Track two groups, then shut them all down.
      trackOwnedGroup(111, seams);
      trackOwnedGroup(222, seams);

      await killAllOwnedGroups(seams);

      expect(killImpl).toHaveBeenCalledWith(-111, "SIGTERM");
      expect(killImpl).toHaveBeenCalledWith(-222, "SIGTERM");
      // Set is cleared after the sweep.
      expect(ownedGroupCount(seams)).toBe(0);
    },
    5000, // two sequential 2s grace windows run in real time
  );
});



describe("waitForHealth", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("succeeds when /health returns 200 on first poll", async () => {
    const mockFetch = vi.fn(async () => ({ ok: true, status: 200 }));
    globalThis.fetch = mockFetch as any;

    await waitForHealth(8080, 10000);

    expect(mockFetch).toHaveBeenCalledWith(
      "http://127.0.0.1:8080/health",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("retries on fetch failure, then succeeds", async () => {
    let callCount = 0;
    const mockFetch = vi.fn(async () => {
      callCount++;
      if (callCount === 1) {
        throw new Error("connection refused");
      }
      return { ok: true, status: 200 };
    });
    globalThis.fetch = mockFetch as any;

    await waitForHealth(8080, 10000);

    expect(mockFetch.mock.calls.length).toBeGreaterThan(1);
  });

  it("keeps polling on ok:false responses with an unparseable body (stall-based)", async () => {
    // A 503 that keeps answering is progress — the stall window keeps
    // extending, so the wait must NOT time out (old fixed-deadline behavior
    // killed slow APU loads here).
    const clock = fakeClock();
    let calls = 0;
    const mockFetch = vi.fn(async () => {
      calls++;
      if (calls < 20) return { ok: false, status: 503 }; // no json() — unparseable
      return { ok: true, status: 200 };
    });

    // The stall window (10s) must exceed the 2s poll interval: each response
    // extends the window, so a responding server never stalls.
    await waitForHealth(8080, 10_000, {
      fetchImpl: mockFetch as never,
      now: clock.now,
      sleepImpl: (ms) => { clock.advance(ms); return Promise.resolve(); },
    });

    // 20 polls, 19 sleeps × 2s = 38s of fake time — far past the 10s stall
    // window — and the wait still succeeded (a responding server is making
    // progress). The final poll returns without a trailing sleep.
    expect(calls).toBe(20);
    expect(clock.now()).toBeGreaterThanOrEqual(38_000);
  });

  it("succeeds past the old deadline while /health reports 'loading model' (stall-based)", async () => {
    // APU reality: a 17GB load into shared RAM takes >180s. The old fixed
    // deadline killed the child mid-load; the stall-based deadline must not.
    const clock = fakeClock();
    let calls = 0;
    const mockFetch = vi.fn(async () => {
      calls++;
      // Still loading for the first 100 polls (200s at 2s intervals), then ready.
      return calls < 100
        ? { ok: false, status: 503, json: async () => ({ status: "loading model" }) }
        : { ok: true, status: 200, json: async () => ({ status: "ok" }) };
    });

    await waitForHealth(8080, 180_000, {
      fetchImpl: mockFetch as never,
      now: clock.now,
      sleepImpl: (ms) => { clock.advance(ms); return Promise.resolve(); },
    });

    // ~200s of "loading model" elapsed (100 polls, 99 sleeps × 2s = 198s) —
    // well past the 180s fixed deadline — and the wait still succeeded.
    expect(calls).toBe(100);
    expect(clock.now()).toBeGreaterThanOrEqual(198_000);
  });

  it("fails fast when /health reports 'error', with the server's message", async () => {
    const mockFetch = vi.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => ({ status: "error", message: "failed to load model: out of memory" }),
    }));

    await expect(
      waitForHealth(8080, 10_000, { fetchImpl: mockFetch as never }),
    ).rejects.toThrow(/failed to load model: out of memory/);

    // One poll is enough — no retry loop on an explicit error.
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("times out when the server stops answering /health (crashed or wedged)", async () => {
    // A server that answers "loading model" once and then goes silent has
    // stalled: the stall window (180s) elapses after the last response.
    const clock = fakeClock();
    let calls = 0;
    const mockFetch = vi.fn(async () => {
      calls++;
      if (calls === 1) {
        return { ok: false, status: 503, json: async () => ({ status: "loading model" }) };
      }
      throw new Error("connection refused"); // silent from here on
    });

    await expect(
      waitForHealth(8080, 180_000, {
        fetchImpl: mockFetch as never,
        now: clock.now,
        sleepImpl: (ms) => { clock.advance(ms); return Promise.resolve(); },
      }),
    ).rejects.toThrow(/stalled/);

    // 180s of silence after the last response. Call 1 answers at t=0 and sets
    // the deadline to 180s; each refused poll sleeps 2s without extending it.
    // The stall check fires at the top of the loop once now() >= 180s, so the
    // total is 1 answer + 89 refused = 90 calls.
    expect(calls).toBe(90);
    expect(clock.now()).toBeGreaterThanOrEqual(180_000);
  });

  it("never times out while the server keeps answering 'loading model' (slow APU load)", async () => {
    // The wedge case is indistinguishable from a slow load via /health alone
    // (both answer "loading model"); the bound is the stall window on
    // SILENCE, not on load duration. A 10-minute load that keeps answering
    // must succeed.
    const clock = fakeClock();
    let calls = 0;
    const mockFetch = vi.fn(async () => {
      calls++;
      return calls < 300
        ? { ok: false, status: 503, json: async () => ({ status: "loading model" }) }
        : { ok: true, status: 200, json: async () => ({ status: "ok" }) };
    });

    await waitForHealth(8080, 180_000, {
      fetchImpl: mockFetch as never,
      now: clock.now,
      sleepImpl: (ms) => { clock.advance(ms); return Promise.resolve(); },
    });

    // 300 polls, 299 sleeps × 2s = 598s (~10 min) of loading — no timeout.
    // The final poll returns without a trailing sleep.
    expect(calls).toBe(300);
    expect(clock.now()).toBe(598_000);
  });

  it("keeps polling on unknown health statuses until 'ok'", async () => {
    const clock = fakeClock();
    let calls = 0;
    const mockFetch = vi.fn(async () => {
      calls++;
      // An unrecognized status (e.g. a future llama.cpp state) must not fail
      // the boot — it is treated as "still working".
      return calls === 1
        ? { ok: false, status: 503, json: async () => ({ status: "busy" }) }
        : { ok: true, status: 200, json: async () => ({ status: "ok" }) };
    });

    await waitForHealth(8080, 10_000, {
      fetchImpl: mockFetch as never,
      now: clock.now,
      sleepImpl: (ms) => { clock.advance(ms); return Promise.resolve(); },
    });

    expect(calls).toBe(2);
  });
});

describe("sendWarmupRequest", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("POSTs to /completion with n_predict", async () => {
    const mockFetch = vi.fn(async (_url: string, init?: { body?: string }) => ({ ok: true, status: 200 }));
    globalThis.fetch = mockFetch as any;

    await sendWarmupRequest(8080, 350);

    expect(mockFetch).toHaveBeenCalledWith(
      "http://127.0.0.1:8080/completion",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }),
    );
    const callArgs = mockFetch.mock.calls[0]!;
    const body = JSON.parse(callArgs[1]!.body!);
    expect(body.n_predict).toBe(350);
  });

  it("throws on non-200 response", async () => {
    const mockFetch = vi.fn(async () => ({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
    }));
    globalThis.fetch = mockFetch as any;

    await expect(sendWarmupRequest(8080, 350)).rejects.toThrow(/failed.*500/);
  });

  it("includes the prompt in the request body", async () => {
    const mockFetch = vi.fn(async (_url: string, init?: { body?: string }) => ({ ok: true }));
    globalThis.fetch = mockFetch as any;

    await sendWarmupRequest(8080, 42);

    const callArgs = mockFetch.mock.calls[0]!;
    const body = JSON.parse(callArgs[1]!.body!);
    expect(body).toHaveProperty("prompt");
    expect(body).toHaveProperty("n_predict", 42);
  });
});
