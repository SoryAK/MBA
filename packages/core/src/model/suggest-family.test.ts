import { describe, expect, it } from "vitest";
import {
  listHubFamilies,
  rankHubFamilies,
  suggestFamily,
} from "./suggest-family.js";

describe("listHubFamilies", () => {
  it("uniques and counts family names", () => {
    expect(
      listHubFamilies([
        { family: "qwen" },
        { family: "qwen" },
        { family: " llama " },
        { family: undefined },
        { family: "" },
      ]),
    ).toEqual([
      { name: "llama", models: 1 },
      { name: "qwen", models: 2 },
    ]);
  });
});

describe("suggestFamily", () => {
  const hub = [
    { name: "deepseek", models: 1 },
    { name: "llama", models: 1 },
    { name: "qwen", models: 2 },
  ];

  it("returns undefined when the hub is empty", () => {
    expect(suggestFamily(["qwen3"], [])).toBeUndefined();
  });

  it("prefers an exact family name", () => {
    expect(suggestFamily(["qwen"], hub)).toBe("qwen");
  });

  it("matches a GGUF / id stem onto an existing family", () => {
    expect(suggestFamily(["Qwen3.8-27B-Q6_K.gguf"], hub)).toBe("qwen");
    expect(suggestFamily(["llama-3.2-1b-instruct-q4-k-m"], hub)).toBe("llama");
    expect(suggestFamily(["Meta-Llama-3.1-8B-Instruct.gguf"], hub)).toBe("llama");
  });

  it("returns undefined when nothing scores", () => {
    expect(suggestFamily(["zzz-no-match"], hub)).toBeUndefined();
  });
});

describe("rankHubFamilies", () => {
  it("puts the closest family first", () => {
    const ranked = rankHubFamilies(
      [
        { name: "deepseek", models: 1 },
        { name: "qwen", models: 2 },
      ],
      ["qwen3-coder"],
    );
    expect(ranked.map((f) => f.name)).toEqual(["qwen", "deepseek"]);
  });
});
