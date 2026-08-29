import { describe, it, expect } from "vitest";
import { selectRestartTargets, type ServerLike } from "./restart-selection.js";

function server(id: string, modelFile: string): ServerLike {
  return { id, modelFile };
}

describe("selectRestartTargets", () => {
  it("returns no targets when no server runs the model", () => {
    const servers = [server("a", "/m/other.gguf")];
    const sel = selectRestartTargets(servers, "/m/model.gguf", true);
    expect(sel.targets).toEqual([]);
    expect(sel.prompt).toBe(false);
  });

  it("stops the single match without prompting", () => {
    const servers = [server("a", "/m/model.gguf"), server("b", "/m/other.gguf")];
    const sel = selectRestartTargets(servers, "/m/model.gguf", true);
    expect(sel.targets.map((s) => s.id)).toEqual(["a"]);
    expect(sel.prompt).toBe(false);
  });

  it("prompts when multiple servers match and the session is interactive", () => {
    const servers = [
      server("a", "/m/model.gguf"),
      server("b", "/m/model.gguf"),
      server("c", "/m/other.gguf"),
    ];
    const sel = selectRestartTargets(servers, "/m/model.gguf", true);
    expect(sel.targets.map((s) => s.id)).toEqual(["a", "b"]);
    expect(sel.prompt).toBe(true);
  });

  it("stops ALL matches without prompting when non-interactive (locked default)", () => {
    const servers = [
      server("a", "/m/model.gguf"),
      server("b", "/m/model.gguf"),
      server("c", "/m/model.gguf"),
    ];
    const sel = selectRestartTargets(servers, "/m/model.gguf", false);
    expect(sel.targets.map((s) => s.id)).toEqual(["a", "b", "c"]);
    expect(sel.prompt).toBe(false);
  });
});
