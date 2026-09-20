import { describe, expect, it } from "vitest";
import { withHouseLock } from "./house-lock.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("withHouseLock", () => {
  it("runs overlapping work on one key in order", async () => {
    const order: number[] = [];
    await Promise.all([
      withHouseLock("sessions", async () => {
        await delay(30);
        order.push(1);
      }),
      withHouseLock("sessions", async () => {
        order.push(2);
      }),
    ]);
    expect(order).toEqual([1, 2]);
  });

  it("does not make different keys wait on each other", async () => {
    let sessionsReleased = false;
    const registry = withHouseLock("registry", async () => {
      await delay(5);
      return sessionsReleased;
    });
    await withHouseLock("sessions", async () => {
      sessionsReleased = true;
    });
    expect(await registry).toBe(true);
  });

  it("releases the key when the mutation throws", async () => {
    await expect(
      withHouseLock("tcb", async () => {
        throw new Error("nope");
      }),
    ).rejects.toThrow(/nope/);
    await expect(withHouseLock("tcb", async () => "ok")).resolves.toBe("ok");
  });
});
