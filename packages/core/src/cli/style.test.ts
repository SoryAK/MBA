import { afterEach, describe, expect, it } from "vitest";
import {
  brand,
  clipLine,
  doneBox,
  option,
  paint,
  visibleLen,
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

  it("renders a done box with a title", () => {
    process.env.NO_COLOR = "1";
    const box = doneBox("BOOTED", [
      ["id", "qwen"],
      ["port", "8080"],
    ]);
    expect(box).toContain("BOOTED");
    expect(box).toContain("qwen");
    expect(box).toContain("╭");
  });

  it("clips painted lines by visible width", () => {
    process.env.NO_COLOR = "1";
    const line = option(true, "qwen-very-long-id", "family extra");
    expect(visibleLen(clipLine(line, 12))).toBeLessThanOrEqual(12);
  });
});
