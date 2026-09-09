import { describe, expect, it } from "vitest";
import { satisfiesVersionRange } from "./version.js";

describe("satisfiesVersionRange", () => {
  it("compares llama.cpp build tags numerically", () => {
    expect(satisfiesVersionRange("llama.cpp", ">=b3659", "b4000")).toBe(true);
    expect(satisfiesVersionRange("llama.cpp", ">=b3659", "b3000")).toBe(false);
    expect(satisfiesVersionRange("llama.cpp", "< b3659", "b3000")).toBe(true);
  });

  it("treats an unparseable or empty-bound range as a wildcard", () => {
    expect(satisfiesVersionRange("llama.cpp", "latest", "b1")).toBe(true);
    expect(satisfiesVersionRange("llama.cpp", ">=", "b1")).toBe(true);
    expect(satisfiesVersionRange("llama.cpp", "<   ", "b1")).toBe(true);
  });

  it("returns false when the actual version is missing", () => {
    expect(satisfiesVersionRange("llama.cpp", ">=b1", undefined)).toBe(false);
  });
});
