import { describe, expect, it } from "vitest";
import { isToolCircuitBreakerConfig } from "./is-config.js";

describe("isToolCircuitBreakerConfig (AMPI ladder)", () => {
  it("accepts action ampi with a recipe name on any tier", () => {
    expect(
      isToolCircuitBreakerConfig({
        tools: {
          read_file: {
            directDuplication: {
              enabled: true,
              threshold: 3,
              escalation: {
                tiers: [
                  { tier: "nudge", afterIgnoredTrips: 0, action: "ampi", recipe: "sweep-duplicates" },
                  { tier: "mask", afterIgnoredTrips: 1, action: "ampi", recipe: "sweep-duplicates" },
                  { tier: "kill", afterIgnoredTrips: 2, action: "ampi", recipe: "sweep-duplicates" },
                ],
              },
            },
          },
        },
      }),
    ).toBe(true);
  });

  it("rejects action ampi without a recipe", () => {
    expect(
      isToolCircuitBreakerConfig({
        tools: {
          read_file: {
            directDuplication: {
              enabled: true,
              threshold: 3,
              escalation: {
                tiers: [{ tier: "kill", afterIgnoredTrips: 0, action: "ampi" }],
              },
            },
          },
        },
      }),
    ).toBe(false);
  });

  it("rejects action ampi with an empty recipe", () => {
    expect(
      isToolCircuitBreakerConfig({
        tools: {
          read_file: {
            directDuplication: {
              enabled: true,
              threshold: 3,
              escalation: {
                tiers: [{ tier: "kill", afterIgnoredTrips: 0, action: "ampi", recipe: "" }],
              },
            },
          },
        },
      }),
    ).toBe(false);
  });
});
