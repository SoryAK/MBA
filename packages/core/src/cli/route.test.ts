import { describe, expect, it } from "vitest";
import { parseMbaArgv } from "./route.js";

describe("parseMbaArgv", () => {
  it("treats empty argv as home and help flags as help", () => {
    expect(parseMbaArgv([]).route).toEqual({ cmd: "home" });
    expect(parseMbaArgv(["help"]).route).toEqual({ cmd: "help", topic: "overview" });
    expect(parseMbaArgv(["-h"]).route).toEqual({ cmd: "help", topic: "overview" });
    expect(parseMbaArgv(["--help"]).route).toEqual({ cmd: "help", topic: "overview" });
    expect(parseMbaArgv(["models", "--help"]).route).toEqual({ cmd: "help", topic: "models" });
    expect(parseMbaArgv(["help", "servers"]).route).toEqual({ cmd: "help", topic: "servers" });
  });

  it("strips --yes into assumeNo", () => {
    const parsed = parseMbaArgv(["models", "set", "qwen", "ctxSize", "8192", "--yes"]);
    expect(parsed.assumeNo).toBe(true);
    expect(parsed.route).toEqual({
      cmd: "models",
      action: "set",
      args: ["qwen", "ctxSize", "8192"],
    });
  });

  it("groups model verbs under models", () => {
    expect(parseMbaArgv(["models"]).route).toEqual({ cmd: "models", action: "pick", args: [] });
    expect(parseMbaArgv(["models", "list"]).route).toEqual({
      cmd: "models",
      action: "list",
      args: [],
    });
    expect(parseMbaArgv(["models", "show", "qwen"]).route).toEqual({
      cmd: "models",
      action: "show",
      args: ["qwen"],
    });
    expect(parseMbaArgv(["models", "qwen"]).route).toEqual({
      cmd: "models",
      action: "edit",
      args: ["qwen"],
    });
    expect(parseMbaArgv(["models", "search"]).route).toEqual({
      cmd: "models",
      action: "search",
      args: [],
    });
    expect(parseMbaArgv(["models", "pull", "owner/repo", "--id", "qwen"]).route).toEqual({
      cmd: "models",
      action: "pull",
      args: ["owner/repo", "--id", "qwen"],
    });
  });

  it("keeps old flat verbs as aliases", () => {
    expect(parseMbaArgv(["config", "qwen"]).route).toEqual({
      cmd: "models",
      action: "show",
      args: ["qwen"],
    });
    expect(parseMbaArgv(["set", "qwen", "ctxSize", "4"]).route).toEqual({
      cmd: "models",
      action: "set",
      args: ["qwen", "ctxSize", "4"],
    });
    expect(parseMbaArgv(["open", "qwen", "yaml"]).route).toEqual({
      cmd: "models",
      action: "open",
      args: ["qwen", "yaml"],
    });
    expect(parseMbaArgv(["pull", "search"]).route).toEqual({
      cmd: "models",
      action: "pull",
      args: ["search"],
    });
    expect(parseMbaArgv(["machine-overlay", "warn"]).route).toEqual({
      cmd: "machine",
      args: ["warn"],
    });
  });

  it("leaves servers, machine, and local tools at the noun/top level", () => {
    expect(parseMbaArgv(["servers", "logs", "s1", "--follow"]).route).toEqual({
      cmd: "servers",
      args: ["logs", "s1", "--follow"],
    });
    expect(parseMbaArgv(["machine"]).route).toEqual({ cmd: "machine", args: [] });
    expect(parseMbaArgv(["migrate-paths"]).route).toEqual({ cmd: "migrate-paths" });
    expect(parseMbaArgv(["estimate-memory", "m.gguf"]).route).toEqual({
      cmd: "estimate-memory",
      args: ["m.gguf"],
    });
  });

  it("accepts server as servers and parses status / json", () => {
    expect(parseMbaArgv(["server", "boot", "qwen"]).route).toEqual({
      cmd: "servers",
      args: ["boot", "qwen"],
    });
    expect(parseMbaArgv(["status"]).route).toEqual({ cmd: "status" });
    expect(parseMbaArgv(["models", "list", "--json"]).json).toBe(true);
    expect(parseMbaArgv(["models", "list", "--json"]).route).toEqual({
      cmd: "models",
      action: "list",
      args: [],
    });
  });

  it("maps one-letter groups to the same routes", () => {
    expect(parseMbaArgv(["m", "show", "qwen"]).route).toEqual({
      cmd: "models",
      action: "show",
      args: ["qwen"],
    });
    expect(parseMbaArgv(["s", "boot", "qwen", "8080"]).route).toEqual({
      cmd: "servers",
      args: ["boot", "qwen", "8080"],
    });
  });

  it("flags unknown top-level commands", () => {
    expect(parseMbaArgv(["context-gc"]).route).toEqual({ cmd: "unknown", command: "context-gc" });
  });
});
