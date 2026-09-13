import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  defaultWatches,
  parseWatchId,
  parseWatchMode,
  readModelWatches,
  setModelWatch,
} from "./model-watches.js";

function writeModel(root: string, opts?: { tcb?: string; familyTcb?: string }): string {
  const familyDir = join(root, "qwen");
  const modelDir = join(familyDir, "qwen");
  mkdirSync(modelDir, { recursive: true });
  writeFileSync(
    join(modelDir, "qwen.yaml"),
    [
      "apiVersion: mba.ai/v1alpha1",
      "kind: ModelBehavioralAdapter",
      "metadata:",
      "  id: qwen",
      "  family: qwen",
      "identity:",
      "  model:",
      '    file: "./qwen.gguf"',
      "bindings:",
      '  tcb: "./tcb.jsonl"',
      '  server_setup: "./server_setup.json"',
    ].join("\n"),
  );
  writeFileSync(join(modelDir, "server_setup.json"), "{}\n");
  writeFileSync(join(modelDir, "tcb.jsonl"), opts?.tcb ?? "{}\n");
  if (opts?.familyTcb !== undefined) {
    writeFileSync(join(familyDir, "tcb.jsonl"), opts.familyTcb);
  }
  return root;
}

describe("parseWatchId / parseWatchMode", () => {
  it("accepts short names and rule aliases", () => {
    expect(parseWatchId("clamp")).toBe("clamp");
    expect(parseWatchId("repeatRun")).toBe("loop");
    expect(parseWatchId("nope")).toBeNull();
    expect(parseWatchMode("inherit")).toBe("inherit");
    expect(parseWatchMode("OFF")).toBe("off");
    expect(parseWatchMode("maybe")).toBeNull();
  });
});

describe("readModelWatches", () => {
  it("treats empty tcb.jsonl as inherit with global seed on", () => {
    const dir = writeModel(mkdtempSync(join(tmpdir(), "mba-watch-")));
    const got = readModelWatches(dir, "qwen");
    expect(got?.watches.map((w) => [w.id, w.mode, w.effective])).toEqual([
      ["clamp", "inherit", true],
      ["eof", "inherit", true],
      ["loop", "inherit", true],
    ]);
  });

  it("honors a model off line and family overlay under inherit", () => {
    const dir = writeModel(mkdtempSync(join(tmpdir(), "mba-watch-")), {
      tcb: JSON.stringify({ tool: "read_file", rule: "readClamp", enabled: false }) + "\n",
      familyTcb: JSON.stringify({ tool: "read_file", rule: "eofOverflow", enabled: false }) + "\n",
    });
    const got = readModelWatches(dir, "qwen")!;
    expect(got.watches.find((w) => w.id === "clamp")).toMatchObject({ mode: "off", effective: false });
    expect(got.watches.find((w) => w.id === "eof")).toMatchObject({ mode: "inherit", effective: false });
    expect(got.watches.find((w) => w.id === "loop")).toMatchObject({ mode: "inherit", effective: true });
  });
});

describe("setModelWatch", () => {
  it("writes off, then inherit restores an empty scaffold", () => {
    const dir = writeModel(mkdtempSync(join(tmpdir(), "mba-watch-")));
    const off = setModelWatch(dir, "qwen", "loop", "off");
    expect("error" in off).toBe(false);
    if ("error" in off) return;
    expect(off.before).toBe("inherit");
    expect(off.after).toBe("off");
    expect(readModelWatches(dir, "qwen")?.watches.find((w) => w.id === "loop")).toMatchObject({
      mode: "off",
      effective: false,
    });

    const back = setModelWatch(dir, "qwen", "loop", "inherit");
    expect("error" in back).toBe(false);
    const text = readFileSync(join(dir, "qwen", "qwen", "tcb.jsonl"), "utf8");
    expect(text.trim()).toBe("{}");
    expect(readModelWatches(dir, "qwen")?.watches.find((w) => w.id === "loop")?.mode).toBe("inherit");
  });

  it("keeps sibling watches when setting one", () => {
    const dir = writeModel(mkdtempSync(join(tmpdir(), "mba-watch-")));
    setModelWatch(dir, "qwen", "clamp", "off");
    setModelWatch(dir, "qwen", "eof", "on");
    const got = readModelWatches(dir, "qwen")!;
    expect(got.watches.find((w) => w.id === "clamp")?.mode).toBe("off");
    expect(got.watches.find((w) => w.id === "eof")?.mode).toBe("on");
    expect(got.watches.find((w) => w.id === "loop")?.mode).toBe("inherit");
  });

  it("returns 404 for an unknown model", () => {
    const dir = writeModel(mkdtempSync(join(tmpdir(), "mba-watch-")));
    expect(setModelWatch(dir, "nope", "loop", "off")).toMatchObject({ status: 404 });
  });
});

describe("defaultWatches", () => {
  it("is inherit and on for the three known watches", () => {
    expect(defaultWatches().modelId).toBeNull();
    expect(defaultWatches().watches.every((w) => w.mode === "inherit" && w.effective)).toBe(true);
  });
});
