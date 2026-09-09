import { brand, dim, heading, paint, BOLD } from "./style.js";

export type HelpTopic = "overview" | "models" | "servers" | "machine" | "status";

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
    cmd("mba machine", "hardware clamp mode"),
    cmd("mba status", "service, loaded model, machine mode"),
    "",
    heading("Local"),
    cmd("mba migrate-paths", "move legacy state + store"),
    cmd("mba estimate-memory <gguf>", "RAM/VRAM estimate"),
    cmd("mba completion [bash|zsh]", "print shell completion"),
    "",
    dim("  mba                  home menu on a TTY"),
    dim("  mba <group> --help   details for that group"),
    dim("  shortcuts            m → models   s → servers"),
    dim("  --yes                skip confirm (restart / boot preview)"),
    dim("  --json               machine-readable list/show/status"),
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
    "",
    dim("  aliases    config → show   open → path   set pull"),
    dim("  --json     on list and show"),
  ].join("\n");
}

export function usageServers(): string {
  return [
    `${brand("servers")}`,
    "",
    cmd("mba servers", "list / boot / stop / logs / slots / builds (TTY menu)"),
    cmd("mba servers list", "registered servers (TTY picker)"),
    cmd("mba servers boot <ref> [port]", "boot (port defaults to 8080)"),
    cmd("mba servers stop <id>", "stop a registered server"),
    cmd("mba servers logs <id>", "[--lines N] [--follow]"),
    cmd("mba servers slots <id>", "list / erase / save / restore KV"),
    cmd("mba servers builds", "llama-server catalog (TTY picker)"),
    "",
    dim("  mba servers slots <id> erase     wipe the live slot (default 0)"),
    dim("  mba servers slots <id> save f    write f into kv/<fork>/slots"),
    dim("  mba servers slots <id> restore f load f from that folder"),
    dim("  mba servers boot          pick model + port on a TTY"),
    dim("  --yes                     skip the boot flag confirm"),
    dim("  llama-server              catalog of builds; rescans every 15m"),
    dim("  mba servers binaries      nickname / use / remove / restore a build"),
    dim("  --type ollama             boot an ollama tag"),
    dim("  --json                    on list"),
    dim("  MBA_SWITCH_PORT           default boot port (8080)"),
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
    cmd("mba status", "service, loaded models, machine mode"),
    dim("  --json   machine-readable"),
  ].join("\n");
}

export function usageFor(topic: HelpTopic): string {
  switch (topic) {
    case "models":
      return usageModels();
    case "servers":
      return usageServers();
    case "machine":
      return usageMachine();
    case "status":
      return usageStatus();
    default:
      return usageOverview();
  }
}
