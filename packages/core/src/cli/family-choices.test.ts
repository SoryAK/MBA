import { describe, expect, it } from "vitest";
import { familyPickerRows } from "./family-choices.js";
import { NEW_FAMILY } from "../model/suggest-family.js";

describe("familyPickerRows", () => {
  it("ranks a matching family first and keeps a new row last", () => {
    const rows = familyPickerRows(
      [
        { name: "deepseek", models: 1 },
        { name: "qwen", models: 2 },
      ],
      ["qwen3-coder"],
    );
    expect(rows.map((r) => r.value)).toEqual(["qwen", "deepseek", NEW_FAMILY]);
    expect(rows[0]?.preview).toContainEqual(["models", "2"]);
    expect(rows.at(-1)?.label).toBe("new");
  });
});
