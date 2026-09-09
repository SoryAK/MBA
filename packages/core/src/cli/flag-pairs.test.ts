import { afterEach, describe, expect, it } from "vitest";
import { groupFlagPairs, pairCliArgs } from "./flag-pairs.js";
import { printBootPreview, formatLlamaServerLabel, shouldAskLlamaBinary } from "./servers.js";

describe("pairCliArgs", () => {
  it("pairs a flag with the following value", () => {
    expect(pairCliArgs(["--ctx-size", "110000", "-ngl", "100"])).toEqual([
      { flag: "--ctx-size", value: "110000" },
      { flag: "-ngl", value: "100" },
    ]);
  });

  it("marks a lone flag as on", () => {
    expect(pairCliArgs(["--jinja", "--flash-attn", "on"])).toEqual([
      { flag: "--jinja", value: "on" },
      { flag: "--flash-attn", value: "on" },
    ]);
  });
});

describe("groupFlagPairs", () => {
  it("buckets known flags and leaves the rest as other", () => {
    const groups = groupFlagPairs(
      pairCliArgs([
        "--ctx-size",
        "110000",
        "-ngl",
        "100",
        "--threads",
        "8",
        "--jinja",
        "--parallel",
        "1",
        "--cache-reuse",
        "150",
        "--reasoning-budget",
        "512",
        "--reasoning-preserve",
      ]),
    );
    expect(groups.map((g) => g.name)).toEqual(["context", "compute", "cache", "reasoning", "other"]);
    expect(groups.find((g) => g.name === "context")?.pairs).toEqual([
      { flag: "--ctx-size", value: "110000" },
      { flag: "--parallel", value: "1" },
    ]);
    expect(groups.find((g) => g.name === "other")?.pairs).toEqual([{ flag: "--jinja", value: "on" }]);
  });
});

describe("printBootPreview", () => {
  const prevNoColor = process.env.NO_COLOR;

  afterEach(() => {
    if (prevNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = prevNoColor;
  });

  it("prints grouped flag rows instead of one token per line", () => {
    process.env.NO_COLOR = "1";
    let out = "";
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      out += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    }) as typeof process.stdout.write;
    try {
      printBootPreview("qwen3-coder-30b", 8080, [
        "--ctx-size",
        "110000",
        "-ngl",
        "100",
        "--jinja",
      ]);
    } finally {
      process.stdout.write = write;
    }
    expect(out).toContain("MBA · boot");
    expect(out).toContain("model");
    expect(out).toContain("qwen3-coder-30b");
    expect(out).toContain("context");
    expect(out).toContain("--ctx-size");
    expect(out).toContain("110000");
    expect(out).toContain("compute");
    expect(out).toContain("other");
    expect(out).not.toMatch(/--ctx-size\n\s+110000/);
  });

  it("prints the llama-server backend and a mismatch note", () => {
    process.env.NO_COLOR = "1";
    let out = "";
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      out += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    }) as typeof process.stdout.write;
    try {
      printBootPreview("qwen3-coder-30b", 8080, ["--jinja"], {
        binary: { path: "/opt/llama.cpp/build/bin/llama-server", backend: "hip" },
        warning: "HIP build; no AMD GPU detected",
        gpus: ["NVIDIA GeForce RTX 5090"],
      });
    } finally {
      process.stdout.write = write;
    }
    expect(out).toContain("hip");
    expect(out).toContain("NVIDIA GeForce RTX 5090");
    expect(out).toContain("HIP build; no AMD GPU detected");
  });

  it("puts a nickname in the boot bin line and the picker label", () => {
    process.env.NO_COLOR = "1";
    let out = "";
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      out += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    }) as typeof process.stdout.write;
    try {
      printBootPreview("qwen3-coder-30b", 8080, ["--jinja"], {
        binary: {
          path: "/home/x/llama.cpp/build/bin/llama-server",
          backend: "hip",
          nickname: "unsloth",
        },
      });
    } finally {
      process.stdout.write = write;
    }
    expect(out).toContain("unsloth");
    expect(formatLlamaServerLabel({ path: "/opt/a/llama-server", backend: "cuda", nickname: "rtx" })).toContain(
      "rtx",
    );
    expect(formatLlamaServerLabel({ path: "/opt/a/llama-server", backend: "cuda" })).toContain("—");
    expect(formatLlamaServerLabel({ path: "/opt/a/llama-server", backend: "vulkan" }, { removed: true })).toContain(
      "removed",
    );
    expect(formatLlamaServerLabel({ path: "/opt/a/llama-server", backend: "cuda" }, { used: true })).toContain(
      "default",
    );
    expect(
      formatLlamaServerLabel({
        path: "/home/x/llama-cuda/build/bin/llama-server",
        backend: "cuda",
        nickname: "cuda_bigUncSmurf",
      }),
    ).toContain("cuda_bigUncSmurf  ");
    expect(shouldAskLlamaBinary(3, false, true, false)).toBe(true);
    expect(shouldAskLlamaBinary(3, true, true, false)).toBe(false);
    expect(shouldAskLlamaBinary(1, false, true, false)).toBe(false);
  });
});
