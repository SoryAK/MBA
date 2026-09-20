import { describe, expect, it } from "vitest";
import { isLiveAmpiRecipe, parseAmpiRecipe } from "./parse-recipe.js";

describe("parseAmpiRecipe", () => {
  it("keeps sweep-duplicates as its own name", () => {
    expect(parseAmpiRecipe("sweep-duplicates")).toEqual({ ok: true, name: "sweep-duplicates" });
  });

  it("treats bare sanitize as duplicates", () => {
    expect(parseAmpiRecipe("sanitize")).toEqual({
      ok: true,
      name: "sanitize",
      sanitize: { what: "duplicates" },
    });
  });

  it("parses sanitize modes and optional +pin", () => {
    expect(parseAmpiRecipe("sanitize/reasoning")).toEqual({
      ok: true,
      name: "sanitize",
      sanitize: { what: "reasoning" },
    });
    expect(parseAmpiRecipe("sanitize/phase+pin")).toEqual({
      ok: true,
      name: "sanitize",
      sanitize: { what: "phase", pin: true },
    });
    expect(parseAmpiRecipe("sanitize+pin")).toEqual({
      ok: true,
      name: "sanitize",
      sanitize: { what: "duplicates", pin: true },
    });
  });

  it("marks unknown names as not live", () => {
    expect(parseAmpiRecipe("sanitize/nope")).toEqual({
      ok: false,
      name: "sanitize/nope",
      reason: "unknown-recipe",
    });
    expect(parseAmpiRecipe("context-gc")).toEqual({
      ok: false,
      name: "context-gc",
      reason: "unknown-recipe",
    });
    expect(parseAmpiRecipe("assist/bound")).toEqual({
      ok: false,
      name: "assist/bound",
      reason: "unknown-recipe",
    });
    expect(parseAmpiRecipe("assist")).toEqual({
      ok: false,
      name: "assist",
      reason: "unknown-recipe",
    });
    expect(isLiveAmpiRecipe("sanitize/duplicates")).toBe(true);
    expect(isLiveAmpiRecipe("context-gc")).toBe(false);
  });
});
