/**
 * Parse `mba` argv into a grouped route.
 *
 * Nouns: models, servers, machine. Local tools stay top-level.
 * Old flat verbs remain as aliases so existing scripts keep working.
 */

import type { HelpTopic } from "./help.js";

export type ModelsAction = "pick" | "list" | "show" | "set" | "open" | "pull" | "search" | "edit";

export type MbaRoute =
  | { readonly cmd: "home" }
  | { readonly cmd: "help"; readonly topic: HelpTopic }
  | { readonly cmd: "status" }
  | { readonly cmd: "completion"; readonly args: readonly string[] }
  | { readonly cmd: "migrate-paths" }
  | { readonly cmd: "estimate-memory"; readonly args: readonly string[] }
  | { readonly cmd: "machine"; readonly args: readonly string[] }
  | { readonly cmd: "servers"; readonly args: readonly string[] }
  | { readonly cmd: "models"; readonly action: ModelsAction; readonly args: readonly string[] }
  | { readonly cmd: "unknown"; readonly command: string };

export interface ParsedMba {
  readonly assumeNo: boolean;
  readonly json: boolean;
  readonly route: MbaRoute;
}

const FLAGS = new Set(["--yes", "--json"]);

function wantsHelp(args: readonly string[]): boolean {
  return args.includes("--help") || args.includes("-h") || args[0] === "help";
}

function helpTopic(name: string | undefined): HelpTopic {
  if (name === "models" || name === "m") return "models";
  if (name === "servers" || name === "server" || name === "s") return "servers";
  if (name === "machine" || name === "machine-overlay") return "machine";
  if (name === "status") return "status";
  return "overview";
}

function parseModels(rest: readonly string[]): MbaRoute {
  if (wantsHelp(rest)) return { cmd: "help", topic: "models" };
  const [sub, ...tail] = rest.filter((a) => a !== "--help" && a !== "-h");
  if (!sub) return { cmd: "models", action: "pick", args: [] };
  if (sub === "list") return { cmd: "models", action: "list", args: tail };
  if (sub === "show") return { cmd: "models", action: "show", args: tail };
  if (sub === "set") return { cmd: "models", action: "set", args: tail };
  if (sub === "open") return { cmd: "models", action: "open", args: tail };
  if (sub === "search") return { cmd: "models", action: "search", args: tail };
  if (sub === "pull") return { cmd: "models", action: "pull", args: tail };
  if (sub === "edit") return { cmd: "models", action: "edit", args: tail };
  return { cmd: "models", action: "edit", args: rest.filter((a) => a !== "--help" && a !== "-h") };
}

export function parseMbaArgv(argv: readonly string[]): ParsedMba {
  const assumeNo = argv.includes("--yes");
  const json = argv.includes("--json");
  const positional = argv.filter((a) => !FLAGS.has(a));
  const [command, ...rest] = positional;

  if (!command) return { assumeNo, json, route: { cmd: "home" } };
  if (command === "help" || command === "--help" || command === "-h") {
    return { assumeNo, json, route: { cmd: "help", topic: helpTopic(rest[0]) } };
  }
  if (command === "status") {
    if (wantsHelp(rest)) return { assumeNo, json, route: { cmd: "help", topic: "status" } };
    return { assumeNo, json, route: { cmd: "status" } };
  }
  if (command === "completion") {
    return { assumeNo, json, route: { cmd: "completion", args: rest } };
  }
  if (command === "migrate-paths") return { assumeNo, json, route: { cmd: "migrate-paths" } };
  if (command === "estimate-memory") {
    return { assumeNo, json, route: { cmd: "estimate-memory", args: rest } };
  }
  if (command === "servers" || command === "server" || command === "s") {
    if (wantsHelp(rest)) return { assumeNo, json, route: { cmd: "help", topic: "servers" } };
    return { assumeNo, json, route: { cmd: "servers", args: rest } };
  }
  if (command === "machine" || command === "machine-overlay") {
    if (wantsHelp(rest)) return { assumeNo, json, route: { cmd: "help", topic: "machine" } };
    return { assumeNo, json, route: { cmd: "machine", args: rest } };
  }
  if (command === "models" || command === "m") {
    return { assumeNo, json, route: parseModels(rest) };
  }
  if (command === "config") {
    return { assumeNo, json, route: { cmd: "models", action: "show", args: rest } };
  }
  if (command === "set") {
    return { assumeNo, json, route: { cmd: "models", action: "set", args: rest } };
  }
  if (command === "open") {
    return { assumeNo, json, route: { cmd: "models", action: "open", args: rest } };
  }
  if (command === "pull") {
    return { assumeNo, json, route: { cmd: "models", action: "pull", args: rest } };
  }

  return { assumeNo, json, route: { cmd: "unknown", command } };
}
