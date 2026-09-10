import { afterEach, describe, expect, it } from "vitest";
import { usageMigrate, usageServers } from "./help.js";

describe("help", () => {
  const prevNoColor = process.env.NO_COLOR;

  afterEach(() => {
    if (prevNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = prevNoColor;
  });

  it("keeps servers help short and still names slots, binaries, and boot flags", () => {
    process.env.NO_COLOR = "1";
    const text = usageServers();
    expect(text.split("\n").length).toBeLessThanOrEqual(16);
    expect(text).toContain("mba servers slots");
    expect(text).toContain("mba servers binaries");
    expect(text).toContain("MBA_SWITCH_PORT");
    expect(text).toContain("--json");
  });

  it("names migrate models, find, and --from", () => {
    process.env.NO_COLOR = "1";
    const text = usageMigrate();
    expect(text).toContain("mba migrate models");
    expect(text).toContain("mba migrate find");
    expect(text).toContain("--from");
    expect(text).toContain("--move");
    expect(text).toContain("--yes");
  });
});
