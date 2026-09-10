import { afterEach, describe, expect, it } from "vitest";
import { homedir } from "node:os";
import {
  brand,
  clipLine,
  doneBox,
  option,
  paint,
  previewBox,
  shortenHome,
  visibleLen,
  bootedLine,
  pulledLine,
  BOLD,
  CYAN,
  colorEnabled,
} from "./style.js";

describe("cli style", () => {
  const prevNoColor = process.env.NO_COLOR;
  const prevForce = process.env.FORCE_COLOR;

  afterEach(() => {
    if (prevNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = prevNoColor;
    if (prevForce === undefined) delete process.env.FORCE_COLOR;
    else process.env.FORCE_COLOR = prevForce;
  });

  it("skips paint when stdout is not a TTY", () => {
    delete process.env.FORCE_COLOR;
    process.env.NO_COLOR = "1";
    expect(colorEnabled()).toBe(false);
    expect(paint("MBA", BOLD, CYAN)).toBe("MBA");
    expect(brand("models")).toBe(" MBA · models");
    expect(option(true, "qwen", "loaded")).toBe(" ▸ ● qwen  loaded");
    expect(option(false, "qwen")).toBe("   ○ qwen");
  });

  it("wraps paint when FORCE_COLOR is set", () => {
    delete process.env.NO_COLOR;
    process.env.FORCE_COLOR = "1";
    expect(colorEnabled()).toBe(true);
    expect(paint("MBA", BOLD, CYAN)).toBe(`${BOLD}${CYAN}MBA\x1b[0m`);
  });

  it("renders a one-line BOOTED result", () => {
    process.env.NO_COLOR = "1";
    expect(bootedLine("llama-cpp-8080", 126627)).toBe(
      "  BOOTED  llama-cpp-8080  pid 126627    next  mba s logs llama-cpp-8080",
    );
    expect(bootedLine("llama-cpp-8080", 126627, "mba connect deepseek_test")).toBe(
      "  BOOTED  llama-cpp-8080  pid 126627    next  mba connect deepseek_test",
    );
  });

  it("renders a one-line PULLED result", () => {
    process.env.NO_COLOR = "1";
    expect(pulledLine("deepseek_test", "deepseek")).toBe(
      "  PULLED  deepseek_test  deepseek    next  mba s boot deepseek_test",
    );
  });

  it("renders a done box with a title", () => {
    process.env.NO_COLOR = "1";
    const box = doneBox("BOOTED", [
      ["id", "qwen"],
      ["port", "8080"],
    ]);
    expect(box).toContain("BOOTED");
    expect(box).toContain("qwen");
    expect(box).toContain("╭");
    const lens = box.split("\n").map(visibleLen);
    expect(new Set(lens).size).toBe(1);
  });

  it("keeps the right edge aligned when a value is longer than the terminal", () => {
    process.env.NO_COLOR = "1";
    const box = doneBox("PULLED", [["weights", "x".repeat(10_000)]]);
    const lines = box.split("\n");
    expect(new Set(lines.map(visibleLen)).size).toBe(1);
    expect(lines[2] ?? "").toMatch(/…│$/);
    expect(lines[0]?.startsWith(" ╭")).toBe(true);
    expect(lines[0]?.endsWith("╮")).toBe(true);
  });

  it("shortens $HOME to ~", () => {
    expect(shortenHome(`${homedir()}/.local/share/mba`)).toBe("~/.local/share/mba");
    expect(shortenHome("/opt/mba")).toBe("/opt/mba");
  });

  it("clips painted lines by visible width", () => {
    process.env.NO_COLOR = "1";
    const line = option(true, "qwen-very-long-id", "family extra");
    expect(visibleLen(clipLine(line, 12))).toBeLessThanOrEqual(12);
  });

  it("renders a two-pane preview box with a straight right edge", () => {
    process.env.NO_COLOR = "1";
    const box = previewBox({
      title: "search",
      count: "2/5",
      left: [" ▸ ● unsloth/Qwen3", "   ○ Qwen/Qwen2.5"],
      preview: [
        ["repo", "unsloth/Qwen3-Coder-30B"],
        ["↓", "12,345"],
        ["♥", "89"],
      ],
    });
    expect(new Set(box.map(visibleLen)).size).toBe(1);
    expect(box[0]).toMatch(/^ ╭─+╮$/);
    expect(box.some((l) => l.includes("┬"))).toBe(true);
    expect(box.some((l) => l.includes("unsloth/Qwen3"))).toBe(true);
    expect(box.some((l) => l.includes("12,345"))).toBe(true);
    expect(box.at(-1)).toMatch(/╯$/);
  });
});
