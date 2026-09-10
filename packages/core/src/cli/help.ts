import { brand, dim, heading, paint, BOLD } from "./style.js";

export type HelpTopic =
  | "overview"
  | "models"
  | "servers"
  | "clients"
  | "machine"
  | "status"
  | "migrate";

function cmd(line: string, note: string): string {
  return `  ${paint(line.padEnd(36), BOLD)} ${dim(note)}`;
}

export function usageOverview(): string {
  return [
    `${brand("cli")}`,
    "",
    heading("Groups"),
    cmd("mba models", "edit, search, pull  (m)"),
    cmd("mba servers", "list, boot, stop, logs, slots, builds  (s)"),
    cmd("mba clients", "list, add, connect, revoke  (c)"),
    cmd("mba migrate", "local GGUFs → hub"),
    cmd("mba machine", "hardware clamp mode"),
    cmd("mba status", "service, loaded model, pairing slots"),
    "",
    heading("Local"),
    cmd("mba estimate-memory <gguf>", "RAM/VRAM estimate"),
    cmd("mba completion [bash|zsh]", "print shell completion"),
    "",
    dim("  mba                  home menu on a TTY"),
    dim("  mba <group> --help   details for that group"),
    dim("  shortcuts            m → models   s → servers   c → clients"),
    dim("  --yes                skip confirm (restart / boot preview)"),
    dim("  --json               machine-readable list/show/status/stage/connect/migrate"),
  ].join("\n");
}

export function usageModels(): string {
  return [
    `${brand("models")}`,
    "",
    cmd("mba models", "edit / search (TTY menu)"),
    cmd("mba models list", "print every model id"),
    cmd("mba models <id>", "edit one model's dials"),
    cmd("mba models show <id>", "print every dial"),
    cmd("mba models set <id> <field> <value>", "set one dial"),
    cmd("mba models path <id> <file>", "print path (server_setup | yaml)"),
    cmd("mba models pull <url|owner/repo> --id <id>", "download and scaffold"),
    cmd("mba models search", "HuggingFace search → pull"),
    cmd("mba models stage [id] --harness <name>", "copy instructions.md into the project"),
    "",
    dim("  aliases    config → show   open → path   set pull"),
    dim("  --json     on list, show, and stage"),
    dim("  harness    built-in set, or a name from mba clients add"),
  ].join("\n");
}

export function usageServers(): string {
  return [
    `${brand("servers")}`,
    "",
    cmd("mba servers", "list / boot / stop / logs / slots / builds (TTY menu)"),
    cmd("mba servers list", "registered servers (TTY picker)"),
    cmd("mba servers boot <ref> [port]", "boot with no client env"),
    cmd("mba servers stop <id>", "stop a registered server"),
    cmd("mba servers logs <id>", "[--lines N] [--follow]"),
    cmd("mba servers slots <id>", "list / erase / save / restore KV"),
    cmd("mba servers binaries", "nickname / use / remove / restore a build"),
    cmd("mba servers builds", "llama-server catalog (TTY picker)"),
    "",
    dim("  slots     erase | save <f> | restore <f>   live KV, default slot 0"),
    dim("  boot      family+model dials; mba connect attaches a client"),
    dim("  --type ollama   --json on list   MBA_SWITCH_PORT (8080)"),
  ].join("\n");
}

export function usageClients(): string {
  return [
    `${brand("clients")}`,
    "",
    cmd("mba clients", "list / add / connect / revoke (TTY menu)"),
    cmd("mba clients list", "registered envelopes + paired sessions"),
    cmd("mba clients add <name> --envelope <path>", "operator-defined client"),
    cmd("mba connect [id] --harness <name>", "stage card + mint a token"),
    cmd("mba clients revoke [id]", "drop a pairing (--all unlocks chat)"),
    cmd("mba clients remove <name>", "drop an added client"),
    "",
    dim("  alias      mba c    mba client"),
    dim("  --project  project folder (default cwd)"),
    dim("  --ide      optional; connect env key (boot stays bare)"),
    dim("  harness    built-in set, or a name from mba clients add"),
    dim("  --json     on list, connect, revoke, add, remove"),
  ].join("\n");
}

export function usageMachine(): string {
  return [
    `${brand("machine")}`,
    "",
    cmd("mba machine", "show or pick mode (TTY)"),
    cmd("mba machine enforce", "clamp recipes to this machine"),
    cmd("mba machine warn", "log only"),
    cmd("mba machine off", "ignore machine specs"),
    "",
    dim("  alias   machine-overlay"),
  ].join("\n");
}

export function usageStatus(): string {
  return [
    `${brand("status")}`,
    "",
    cmd("mba status", "service, loaded models, pairing, clients"),
    dim("  --json   machine-readable"),
  ].join("\n");
}

export function usageMigrate(): string {
  return [
    `${brand("migrate")}`,
    "",
    cmd("mba migrate", "models / find (TTY menu)"),
    cmd("mba migrate models [dir]", "GGUFs in that folder → hub"),
    cmd("mba migrate find [query]", "fuzzy-find GGUFs → hub"),
    "",
    dim("  copies into the hub (hardlink when possible)"),
    dim("  find      ~/.cache/huggingface/hub and ~/models"),
    dim("  --from    limit find to one directory"),
    dim("  TTY       asks whether to remove the source (enter = keep)"),
    dim("  --move    remove source without asking"),
    dim("  --yes     skip asks; keeps source unless --move"),
    dim("  --json    same as --yes, machine-readable results"),
  ].join("\n");
}

export function usageFor(topic: HelpTopic): string {
  switch (topic) {
    case "models":
      return usageModels();
    case "servers":
      return usageServers();
    case "clients":
      return usageClients();
    case "machine":
      return usageMachine();
    case "status":
      return usageStatus();
    case "migrate":
      return usageMigrate();
    default:
      return usageOverview();
  }
}
