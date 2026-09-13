import { describe, expect, it } from "vitest";
import { isPidAlive, planStart, planStop, waitUntilDead } from "./start.js";

describe("planStart", () => {
  it("starts when nothing is discovered", () => {
    expect(planStart(null, false, false)).toBe("start");
  });

  it("starts when the recorded pid is dead", () => {
    expect(planStart({ url: "http://127.0.0.1:9", pid: 999 }, false, false)).toBe("start");
  });

  it("starts when the discovery file has no pid", () => {
    expect(planStart({ url: "http://127.0.0.1:9", pid: null }, false, false)).toBe("start");
  });

  it("refuses a second daemon when the recorded pid is live and answering", () => {
    expect(planStart({ url: "http://127.0.0.1:9", pid: 1 }, true, true)).toBe("already-running");
  });

  it("refuses when the pid is live but the control plane is not answering", () => {
    expect(planStart({ url: "http://127.0.0.1:9", pid: 1 }, true, false)).toBe("stale-pid");
  });
});

describe("planStop", () => {
  it("is a no-op when nothing is discovered", () => {
    expect(planStop(null, false, false)).toBe("not-running");
  });

  it("is a no-op when the recorded pid is dead", () => {
    expect(planStop({ url: "http://127.0.0.1:9", pid: 999 }, false, false)).toBe("not-running");
  });

  it("signals when the recorded pid is live and answering", () => {
    expect(planStop({ url: "http://127.0.0.1:9", pid: 1 }, true, true)).toBe("signal");
  });

  it("refuses to signal when the pid is live but not answering", () => {
    expect(planStop({ url: "http://127.0.0.1:9", pid: 1 }, true, false)).toBe("stale-pid");
  });
});

describe("isPidAlive", () => {
  it("sees this process", () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it("treats a never-used pid as dead", () => {
    expect(isPidAlive(2 ** 31 - 1)).toBe(false);
  });

  it("waitUntilDead returns immediately for a dead pid", async () => {
    await expect(waitUntilDead(2 ** 31 - 1, 200)).resolves.toBe(true);
  });
});
