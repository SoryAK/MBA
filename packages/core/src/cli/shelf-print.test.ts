import { afterEach, describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { formatNotesSection, formatShelfPathRow, notesPreviewRow } from "./shelf-print.js";

describe("shelf-print", () => {
  const prevNoColor = process.env.NO_COLOR;

  afterEach(() => {
    if (prevNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = prevNoColor;
  });

  it("names the winning notes path and source", () => {
    process.env.NO_COLOR = "1";
    const line = formatShelfPathRow("notes", {
      path: `${homedir()}/mba/model_hub/adapters/qwen/notes.md`,
      source: "model",
    });
    expect(line).toContain("notes");
    expect(line).toContain("~/mba/model_hub/adapters/qwen/notes.md");
    expect(line).toContain("model");
  });

  it("prints the notes body under a heading", () => {
    process.env.NO_COLOR = "1";
    const lines = formatNotesSection({
      path: "/tmp/notes.md",
      source: "model",
      empty: false,
      text: "Prefers grep before glob.\nLoop mop fired twice.",
    });
    expect(lines.join("\n")).toContain("notes");
    expect(lines.join("\n")).toContain("Prefers grep before glob.");
    expect(lines.join("\n")).toContain("Loop mop fired twice.");
  });

  it("prints empty for a blank stub", () => {
    process.env.NO_COLOR = "1";
    expect(formatNotesSection({ path: "/tmp/notes.md", source: "model", empty: true }).join("\n")).toContain(
      "empty",
    );
  });

  it("builds a picker row from the excerpt", () => {
    expect(notesPreviewRow({ empty: false, excerpt: "Prefers grep before glob." })).toEqual([
      "notes",
      "Prefers grep before glob.",
    ]);
    expect(notesPreviewRow({ empty: true })).toEqual(["notes", "empty"]);
    expect(notesPreviewRow(undefined)).toBeUndefined();
  });
});
