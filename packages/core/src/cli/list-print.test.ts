import { afterEach, describe, expect, it } from "vitest";
import { homedir } from "node:os";
import {
  formatModelLine,
  formatRegisteredClientLine,
  formatServerLine,
} from "./list-print.js";

describe("list-print", () => {
  const prevNoColor = process.env.NO_COLOR;

  afterEach(() => {
    if (prevNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = prevNoColor;
  });

  it("names a server with health and a shortened GGUF path", () => {
    process.env.NO_COLOR = "1";
    const line = formatServerLine({
      id: "llama-cpp-8080",
      port: 8080,
      pid: 12,
      healthy: true,
      modelFile: `${homedir()}/models/qwen.gguf`,
    });
    expect(line).toContain("llama-cpp-8080");
    expect(line).toContain("8080");
    expect(line).toContain("12");
    expect(line).toContain("ok");
    expect(line).toContain("~/models/qwen.gguf");
  });

  it("marks a loaded model and leaves others as ·", () => {
    process.env.NO_COLOR = "1";
    expect(formatModelLine({ id: "deepseek_test", family: "deepseek", loaded: true })).toContain(
      "loaded",
    );
    expect(formatModelLine({ id: "nomic-embed-text-v1.5" })).toContain("·");
  });

  it("prints registered clients with kind and envelope", () => {
    process.env.NO_COLOR = "1";
    const cursor = formatRegisteredClientLine({
      name: "cursor",
      envelope: ".cursor/rules/mba.mdc",
      source: "built-in",
    });
    expect(cursor).toContain("cursor");
    expect(cursor).toContain("ide");
    expect(cursor).toContain(".cursor/rules/mba.mdc");
    expect(cursor).not.toContain("added");

    const claude = formatRegisteredClientLine({
      name: "claude-code",
      envelope: "CLAUDE.local.md",
      source: "built-in",
    });
    expect(claude).toContain("cli");

    const extra = formatRegisteredClientLine({
      name: "windsurf",
      envelope: ".windsurf/mba.md",
      source: "added",
    });
    expect(extra).toContain("· added");
  });
});
