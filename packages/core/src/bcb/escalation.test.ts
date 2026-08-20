import { describe, expect, it } from "vitest";
import { deriveLadderFromKill, evaluateEscalation } from "./escalation.js";
import type { EscalationLadder, KillRule } from "./types.js";

const ladder = (
  tiers: EscalationLadder["tiers"],
  counterMode?: EscalationLadder["counterMode"],
): EscalationLadder => ({ tiers, counterMode });

describe("deriveLadderFromKill", () => {
  it("builds a nudge→kill ladder when kill is enabled", () => {
    const kill: KillRule = { enabled: true, ignoredTrips: 3, action: "return-error" };
    const l = deriveLadderFromKill(kill);
    expect(l.counterMode).toBe("monotonic");
    expect(l.tiers).toEqual([
      { tier: "nudge", afterIgnoredTrips: 0 },
      { tier: "kill", afterIgnoredTrips: 3, action: "return-error" },
    ]);
  });

  it("builds a nudge-only ladder when kill is absent or disabled", () => {
    expect(deriveLadderFromKill(undefined).tiers).toEqual([{ tier: "nudge", afterIgnoredTrips: 0 }]);
    expect(deriveLadderFromKill({ enabled: false, ignoredTrips: 3, action: "return-error" }).tiers).toEqual([
      { tier: "nudge", afterIgnoredTrips: 0 },
    ]);
  });
});

describe("evaluateEscalation — monotonic", () => {
  const l = ladder([
    { tier: "nudge", afterIgnoredTrips: 0 },
    { tier: "mask", afterIgnoredTrips: 2, revivalCalls: 3 },
    { tier: "kill", afterIgnoredTrips: 4, action: "return-error" },
  ]);

  it("returns nudge on the first trip and until the mask threshold", () => {
    expect(evaluateEscalation({ ladder: l, tripCount: 1 })).toMatchObject({ tier: "nudge", tierIndex: 0, resetCounter: false });
    expect(evaluateEscalation({ ladder: l, tripCount: 2 })).toMatchObject({ tier: "nudge", tierIndex: 0 });
  });

  it("advances to mask once enough trips are ignored", () => {
    expect(evaluateEscalation({ ladder: l, tripCount: 3 })).toMatchObject({ tier: "mask", tierIndex: 1, revivalCalls: 3 });
  });

  it("advances to kill at the top threshold", () => {
    expect(evaluateEscalation({ ladder: l, tripCount: 5 })).toMatchObject({ tier: "kill", tierIndex: 2, action: "return-error" });
    expect(evaluateEscalation({ ladder: l, tripCount: 9 })).toMatchObject({ tier: "kill", tierIndex: 2 });
  });

  it("returns null for an empty ladder", () => {
    expect(evaluateEscalation({ ladder: ladder([]), tripCount: 3 })).toBeNull();
  });
});

describe("evaluateEscalation — reset-per-tier", () => {
  const l = ladder(
    [
      { tier: "nudge", afterIgnoredTrips: 0 },
      { tier: "mask", afterIgnoredTrips: 2, revivalCalls: 3 },
      { tier: "kill", afterIgnoredTrips: 2, action: "return-error" },
    ],
    "reset-per-tier",
  );

  it("holds the current tier until the next tier's threshold is met (counting from tier entry)", () => {
    expect(evaluateEscalation({ ladder: l, tripCount: 1, reachedTier: 0 })).toMatchObject({ tier: "nudge", tierIndex: 0, resetCounter: false });
    expect(evaluateEscalation({ ladder: l, tripCount: 2, reachedTier: 0 })).toMatchObject({ tier: "nudge", tierIndex: 0, resetCounter: false });
  });

  it("advances one tier and signals a counter reset", () => {
    expect(evaluateEscalation({ ladder: l, tripCount: 3, reachedTier: 0 })).toMatchObject({ tier: "mask", tierIndex: 1, resetCounter: true });
    expect(evaluateEscalation({ ladder: l, tripCount: 3, reachedTier: 1 })).toMatchObject({ tier: "kill", tierIndex: 2, resetCounter: true });
  });

  it("stays on the final tier without resetting", () => {
    expect(evaluateEscalation({ ladder: l, tripCount: 9, reachedTier: 2 })).toMatchObject({ tier: "kill", tierIndex: 2, resetCounter: false });
  });
});
