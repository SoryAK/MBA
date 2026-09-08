import { describe, expect, it } from "vitest";
import { parseAmpiRecipe } from "./parse-recipe.js";

describe("parseAmpiRecipe", () => {
  it("keeps sweep-duplicates as its own name", () => {
    expect(parseAmpiRecipe("sweep-duplicates")).toEqual({ name: "sweep-duplicates" });
  });

  it("treats bare sanitize as duplicates", () => {
    expect(parseAmpiRecipe("sanitize")).toEqual({
      name: "sanitize",
      sanitize: { what: "duplicates" },
    });
  });

  it("parses sanitize modes and optional +pin", () => {
    expect(parseAmpiRecipe("sanitize/reasoning")).toEqual({
      name: "sanitize",
      sanitize: { what: "reasoning" },
    });
    expect(parseAmpiRecipe("sanitize/phase+pin")).toEqual({
      name: "sanitize",
      sanitize: { what: "phase", pin: true },
    });
    expect(parseAmpiRecipe("sanitize+pin")).toEqual({
      name: "sanitize",
      sanitize: { what: "duplicates", pin: true },
    });
  });

  it("leaves an unknown name alone", () => {
    expect(parseAmpiRecipe("sanitize/nope")).toEqual({ name: "sanitize/nope" });
    expect(parseAmpiRecipe("context-gc")).toEqual({ name: "context-gc" });
  });
});
