import { describe, expect, it } from "vitest";
import { reasoningIsOn, shouldCompactReasoning } from "./reasoning.js";

describe("reasoningIsOn", () => {
  it("is unknown when nobody passed a gate", () => {
    expect(reasoningIsOn()).toBeUndefined();
    expect(shouldCompactReasoning()).toBe(true);
  });

  it("is off when the model does not reason", () => {
    expect(reasoningIsOn({ modelReasons: false, reasoningBudget: 512 })).toBe(false);
    expect(shouldCompactReasoning({ modelReasons: false })).toBe(false);
  });

  it("is off when the server dial is off", () => {
    expect(reasoningIsOn({ reasoningBudget: 0 })).toBe(false);
    expect(reasoningIsOn({ reasoningPreserve: false })).toBe(false);
  });

  it("is on when the model reasons and the dial is on", () => {
    expect(
      reasoningIsOn({ modelReasons: true, reasoningBudget: 512, reasoningPreserve: true }),
    ).toBe(true);
  });
});
