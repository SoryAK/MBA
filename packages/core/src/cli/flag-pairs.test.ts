import { afterEach, describe, expect, it } from "vitest";
import { compactBootLines, groupFlagPairs, pairCliArgs } from "./flag-pairs.js";
import { printBootPreview, formatLlamaServerLabel, shouldAskLlamaBinary } from "./servers.js";
import { formatBootPreviewLines } from "./boot-preview.js";

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

describe("compactBootLines", () => {
  it("hides usual --jinja and kv q8_0 and prints dense dials", () => {
    const lines = compactBootLines(
      pairCliArgs([
        "--ctx-size",
        "110000",
        "-ngl",
        "11",
        "--threads",
        "8",
        "--flash-attn",
        "on",
        "--parallel",
        "1",
        "--cache-reuse",
        "150",
        "--cache-ram",
        "9500",
        "-ctk",
        "q8_0",
        "-ctv",
        "q8_0",
        "--jinja",
        "--reasoning-budget",
        "512",
        "--reasoning-preserve",
        "--warmup",
      ]),
    );
    expect(lines.join("\n")).toContain("ctx 110000");
    expect(lines.join("\n")).toContain("ngl 11");
    expect(lines.join("\n")).toContain("flash on");
    expect(lines.join("\n")).toContain("reason 512");
    expect(lines.join("\n")).toContain("warmup");
    expect(lines.join("\n")).not.toContain("jinja");
    expect(lines.join("\n")).not.toContain("q8_0");
    expect(lines.join("\n")).not.toContain("--ctx-size");
  });

  it("shows kv when it is not q8_0", () => {
    const lines = compactBootLines(pairCliArgs(["-ctk", "q4_0", "-ctv", "q4_0"]));
    expect(lines.join(" ")).toContain("kv q4_0/q4_0");
  });
});

describe("printBootPreview", () => {
  const prevNoColor = process.env.NO_COLOR;

  afterEach(() => {
    if (prevNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = prevNoColor;
  });

  it("prints a dense header and dials instead of flag tables", () => {
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
    expect(out).toContain("qwen3-coder-30b");
    expect(out).toContain(":8080");
    expect(out).toContain("ctx 110000");
    expect(out).toContain("ngl 100");
    expect(out).not.toContain("context");
    expect(out).not.toContain("--ctx-size");
    expect(out).not.toContain("--jinja");
    expect(out).not.toMatch(/--ctx-size\n\s+110000/);
    expect(out).toContain("not set");
    expect(out).not.toContain("mba connect");
  });

  it("points a bare boot at mba connect, not a leftover pairing", () => {
    process.env.NO_COLOR = "1";
    const out = formatBootPreviewLines("deepseek_test", 8080, ["--jinja"], {
      env: { harness: "none", ide: "none", serverRuntime: "llamacpp" },
      envAttached: false,
    }).join("\n");
    expect(out).toMatch(/env\s+not set/);
    expect(out).not.toContain("mba connect");
    expect(out).not.toContain("cursor");
    expect(out).not.toContain("copilot");
  });

  it("still names an attached env as cursor, not cursor+cursor+llamacpp", () => {
    process.env.NO_COLOR = "1";
    let out = "";
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      out += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    }) as typeof process.stdout.write;
    try {
      printBootPreview("deepseek_test", 8080, ["--jinja"], {
        env: { harness: "cursor", ide: "cursor", serverRuntime: "llamacpp" },
      });
    } finally {
      process.stdout.write = write;
    }
    expect(out).toContain("cursor");
    expect(out).not.toContain("cursor+cursor");
    expect(out).not.toContain("llamacpp");
  });

  it("sections machine, model facts, env, server, and flags", () => {
    process.env.NO_COLOR = "1";
    const out = formatBootPreviewLines("deepseek_test", 8080, ["--ctx-size", "100000", "--jinja"], {
      gpus: ["NVIDIA GeForce RTX 3060 Ti"],
      vramBytes: [8 * 1024 * 1024 * 1024],
      ramBytes: 32 * 1024 * 1024 * 1024,
      cpuThreads: 16,
      machineOverlay: "enforce",
      env: { harness: "none", ide: "none", serverRuntime: "llamacpp" },
      envAttached: false,
      model: {
        sizeLabel: "7B",
        fileBytes: 4 * 1024 * 1024 * 1024,
        quant: "Q4_K_M",
        vision: true,
        toolCalling: true,
      },
      binary: {
        path: "/opt/llama-server",
        backend: "cuda",
        nickname: "cuda_bigUncSmurf",
      },
    }).join("\n");
    expect(out).toContain("machine");
    expect(out).toContain("RTX 3060 Ti");
    expect(out).toContain("8.0 GiB");
    expect(out).toContain("32.0 GiB");
    expect(out).toContain("16 threads");
    expect(out).toContain("enforce");
    expect(out).toContain("clamp flags to this box");
    expect(out).toContain("model");
    expect(out).toContain("7B");
    expect(out).toContain("4.0 GiB");
    expect(out).toContain("Q4_K_M");
    expect(out).toMatch(/vision\s+true/);
    expect(out).toMatch(/tools\s+true/);
    expect(out).toMatch(/env\s+not set/);
    expect(out).not.toContain("mba connect deepseek_test");
    expect(out).not.toContain("cursor");
    expect(out).toContain("server");
    expect(out).toContain("cuda_bigUncSmurf");
    expect(out).toContain("default");
    expect(out).toContain("flags");
    expect(out).toContain("ctx 100000");
    expect(out).not.toContain("/opt/llama-server");
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
    expect(out).toContain("RTX 5090");
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
