import { describe, expect, it } from "vitest";
import { quantFromFilename } from "./gguf-profile.js";
import {
  assignAdoptIds,
  defaultAdoptId,
  ggufStem,
  groupGgufs,
} from "./gguf-group.js";
import type { FoundGguf } from "./gguf-scan.js";

function file(fileName: string, path = `/m/${fileName}`): FoundGguf {
  return {
    path,
    fileName,
    bytes: 1,
    quant: quantFromFilename(fileName),
  };
}

describe("ggufStem", () => {
  it("strips a trailing quant label", () => {
    expect(ggufStem("Meta-Llama-3.1-8B-Instruct-Q3_K_L.gguf")).toBe(
      "Meta-Llama-3.1-8B-Instruct",
    );
    expect(ggufStem("Qwen3.8-27B-Q6_K.gguf")).toBe("Qwen3.8-27B");
    expect(ggufStem("model.Q4_K_M.gguf")).toBe("model");
  });

  it("leaves a file with no quant alone", () => {
    expect(ggufStem("weights.gguf")).toBe("weights");
  });
});

describe("defaultAdoptId", () => {
  it("slugs stem plus quant", () => {
    expect(defaultAdoptId(file("Meta-Llama-3.1-8B-Instruct-Q3_K_L.gguf"))).toBe(
      "meta-llama-3-1-8b-instruct-q3-k-l",
    );
  });
});

describe("groupGgufs", () => {
  it("clusters quants of the same stem and keeps first-seen order", () => {
    const files = [
      file("Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf"),
      file("other.gguf"),
      file("Meta-Llama-3.1-8B-Instruct-Q3_K_L.gguf"),
    ];
    const groups = groupGgufs(files);
    expect(groups.map((g) => g.key)).toEqual(["meta-llama-3-1-8b-instruct", "other"]);
    expect(groups[0]?.files.map((f) => f.quant)).toEqual(["Q4_K_M", "Q3_K_L"]);
    expect(groups[1]?.files).toHaveLength(1);
  });
});

describe("assignAdoptIds", () => {
  it("keeps quant in the id so siblings do not collide", () => {
    const files = [
      file("Llama-Q3_K_L.gguf"),
      file("Llama-Q4_K_M.gguf"),
    ];
    const ids = assignAdoptIds(files);
    expect(ids.get(files[0]!.path)).toBe("llama-q3-k-l");
    expect(ids.get(files[1]!.path)).toBe("llama-q4-k-m");
  });
});
