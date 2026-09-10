/**
 * Server plane (ADR-0097): list / boot / stop / logs / slots / builds.
 */

import { defaultSwitchPort, fail, serviceGet, servicePost } from "./client.js";
import { printBootPreview, type BootPreviewExtras } from "./boot-preview.js";
import { brand, dim, shortenHome, bootedLine } from "./style.js";
import { formatServerLine } from "./list-print.js";
import {
  askPortInteractive,
  askTextInteractive,
  askYesNoInteractive,
  pickLabeledInteractive,
  pickModelInteractive,
  pickServerInteractive,
  type ModelEntry,
} from "./interactive.js";
import { resolveModelFile } from "./resolve-model.js";
import { binaryMismatchWarning, type LlamaBackend, type GpuVendor } from "../service/llama-binaries.js";
import type { BootResult, ServerEntry } from "./types.js";

function cancelled(): void {
  process.stdout.write("[mba] cancelled\n");
}

function printServersTable(servers: ServerEntry[]): void {
  process.stdout.write(`${brand("servers")}\n`);
  for (const s of servers) {
    process.stdout.write(`${formatServerLine(s)}\n`);
  }
}

async function cmdServersList(baseUrl: string, plain: boolean, json = false): Promise<void> {
  const { servers } = await serviceGet<{ servers: ServerEntry[] }>(baseUrl, "/servers");
  if (json) {
    process.stdout.write(`${JSON.stringify(servers, null, 2)}\n`);
    return;
  }
  if (servers.length === 0) {
    process.stdout.write(`${brand("servers")}\n`);
    process.stdout.write(`  ${dim("none")}\n`);
    return;
  }
  if (!process.stdin.isTTY || plain) {
    printServersTable(servers);
    return;
  }
  const rows = servers.map((s) => ({
    id: s.id,
    port: s.port,
    pid: s.pid,
    healthy: s.healthy,
    modelFile: s.modelFile,
  }));
  const sel = await pickServerInteractive(rows);
  if (sel === null) {
    cancelled();
    return;
  }
  if (sel.action === "stop") {
    await cmdServersStop(baseUrl, sel.server.id);
  } else if (sel.action === "logs") {
    await cmdServersLogs(baseUrl, sel.server.id, undefined, true);
  }
}

interface LlamaBinaryRow {
  readonly path: string;
  readonly backend: LlamaBackend;
  readonly nickname?: string;
}

interface ResolvePreview {
  readonly cliArgs: string[];
  readonly env?: { harness: string; ide: string; serverRuntime: string };
  readonly envAttached?: boolean;
  readonly binary?: LlamaBinaryRow;
  readonly binaries?: ReadonlyArray<LlamaBinaryRow>;
  readonly recommended?: LlamaBackend;
  readonly pinned?: boolean;
  readonly warning?: string;
  readonly vendors?: readonly GpuVendor[];
  readonly gpus?: readonly string[];
  readonly vramBytes?: readonly (number | null)[];
  readonly ramBytes?: number;
  readonly cpuThreads?: number;
  readonly machineOverlay?: "enforce" | "warn" | "off";
  readonly model?: BootPreviewExtras["model"];
}

export function llamaNickColumnWidth(rows: readonly LlamaBinaryRow[]): number {
  let width = 12;
  for (const b of rows) {
    const nick = (b.nickname ?? "").trim();
    const len = nick.length > 0 ? nick.length : 1;
    if (len > width) width = len;
  }
  return width;
}

export function formatLlamaServerLabel(
  b: LlamaBinaryRow,
  opts?: { recommended?: boolean; removed?: boolean; used?: boolean; nickWidth?: number },
): string {
  const nick = (b.nickname ?? "").trim();
  const name = nick.length > 0 ? nick : "—";
  const width = Math.max(opts?.nickWidth ?? 12, name.length);
  const tag = opts?.removed ? "  removed" : opts?.used ? "  default" : opts?.recommended ? "  recommended" : "";
  return `${b.backend.padEnd(8)}${name.padEnd(width)}  ${shortenHome(b.path)}${tag}`;
}

function llamaServerPreview(
  b: LlamaBinaryRow,
  opts?: { recommended?: boolean; removed?: boolean; used?: boolean },
): Array<readonly [string, string]> {
  const rows: Array<readonly [string, string]> = [
    ["backend", b.backend],
    ["nick", (b.nickname ?? "").trim() || "—"],
    ["path", shortenHome(b.path)],
  ];
  if (opts?.used) rows.push(["boot", "default"]);
  if (opts?.removed) rows.push(["state", "removed"]);
  if (opts?.recommended) rows.push(["pick", "recommended"]);
  return rows;
}

export function shouldAskLlamaBinary(
  binCount: number,
  pinned: boolean | undefined,
  tty: boolean,
  assumeNo: boolean,
): boolean {
  return tty && !assumeNo && binCount > 1 && !pinned;
}

export { printBootPreview };

function previewExtras(recipe: ResolvePreview, binaryPath: string | undefined): BootPreviewExtras {
  const bin =
    binaryPath !== undefined
      ? recipe.binaries?.find((b) => b.path === binaryPath) ?? recipe.binary
      : recipe.binary;
  const vendors = new Set(recipe.vendors ?? []);
  const warning = bin ? binaryMismatchWarning(bin.backend, vendors) : recipe.warning;
  const picked =
    binaryPath !== undefined && recipe.binary?.path !== undefined && binaryPath !== recipe.binary.path;
  return {
    binary: bin,
    warning,
    gpus: recipe.gpus,
    vramBytes: recipe.vramBytes,
    ramBytes: recipe.ramBytes,
    cpuThreads: recipe.cpuThreads,
    machineOverlay: recipe.machineOverlay,
    env: recipe.env,
    envAttached: recipe.envAttached,
    model: recipe.model,
    pinned: recipe.pinned,
    picked,
  };
}

async function confirmLlamaBoot(
  baseUrl: string,
  modelRef: string,
  port: number,
  assumeNo: boolean,
): Promise<{ proceed: boolean; binaryPath?: string }> {
  let recipe: ResolvePreview | undefined;
  try {
    const modelFile = await resolveModelFile(baseUrl, modelRef);
    recipe = await servicePost<ResolvePreview>(baseUrl, "/servers/resolve", {
      modelFile,
    });
  } catch {
    process.stdout.write("[mba] could not preview flags — proceeding to boot\n");
    return { proceed: true };
  }

  let binaryPath = recipe.binary?.path;

  if (shouldAskLlamaBinary(recipe.binaries?.length ?? 0, recipe.pinned, process.stdin.isTTY, assumeNo)) {
    const nickWidth = llamaNickColumnWidth(recipe.binaries!);
    const items = recipe.binaries!.map((b) => {
      const firstRecommended =
        recipe.recommended === b.backend &&
        recipe.binaries!.find((x) => x.backend === recipe.recommended)?.path === b.path;
      return {
        label: formatLlamaServerLabel(b, { recommended: firstRecommended, nickWidth }),
        value: b.path,
        preview: llamaServerPreview(b, { recommended: firstRecommended }),
      };
    });
    const picked = await pickLabeledInteractive("llama-server", items, {
      selectedValue: binaryPath,
    });
    if (picked === null) {
      cancelled();
      return { proceed: false };
    }
    binaryPath = picked;
  }

  printBootPreview(modelRef, port, recipe.cliArgs, previewExtras(recipe, binaryPath));

  if (!process.stdin.isTTY || assumeNo) return { proceed: true, binaryPath };
  const proceed = await askYesNoInteractive("boot with these flags?");
  if (proceed !== true) {
    cancelled();
    return { proceed: false };
  }
  return { proceed: true, binaryPath };
}

async function interactiveBoot(
  baseUrl: string,
  serverType: "llama.cpp" | "ollama",
  assumeNo: boolean,
): Promise<void> {
  const { models } = await serviceGet<{ models: ModelEntry[] }>(baseUrl, "/models");
  if (models.length === 0) {
    process.stdout.write("[mba] no models in the adapter tree\n");
    return;
  }
  const picked = await pickModelInteractive(models);
  if (picked === null) {
    cancelled();
    return;
  }
  const port = await askPortInteractive(defaultSwitchPort());
  if (port === null) {
    cancelled();
    return;
  }

  if (serverType === "llama.cpp") {
    const confirm = await confirmLlamaBoot(baseUrl, picked.id, port, assumeNo);
    if (!confirm.proceed) return;
    await cmdServersBoot(baseUrl, picked.id, port, serverType, confirm.binaryPath);
    return;
  }

  await cmdServersBoot(baseUrl, picked.id, port, serverType);
}

async function cmdServersBoot(
  baseUrl: string,
  modelRef: string,
  port: number,
  serverType: "llama.cpp" | "ollama",
  binaryPath?: string,
): Promise<BootResult> {
  if (serverType === "ollama") {
    process.stdout.write(`[mba] loading ${modelRef} into ollama (waits for load)…\n`);
    const entry = await servicePost<BootResult>(baseUrl, "/servers/boot", {
      serverType: "ollama",
      modelRef,
      port,
    });
    process.stdout.write(`${bootedLine(entry.id, undefined, `mba connect ${modelRef}`)}\n`);
    return entry;
  }
  const modelFile = await resolveModelFile(baseUrl, modelRef);
  process.stdout.write(`  ${dim("waiting")}  health…\n`);
  const body: Record<string, unknown> = { modelFile, port };
  if (binaryPath) body.binaryPath = binaryPath;
  const entry = await servicePost<BootResult>(baseUrl, "/servers/boot", body);
  process.stdout.write(`${bootedLine(entry.id, entry.pid, `mba connect ${modelRef}`)}\n`);
  return entry;
}

async function cmdServersStop(baseUrl: string, id: string): Promise<void> {
  await servicePost<{ stopped: string }>(baseUrl, "/servers/stop", { id });
  process.stdout.write(`[mba] stopped ${id}\n`);
}

async function cmdServersSlots(
  baseUrl: string,
  id: string,
  action: string | undefined,
  rest: readonly string[],
  json: boolean,
): Promise<void> {
  if (!action) {
    const body = await serviceGet<{ id: string; dir: string; slots: unknown }>(
      baseUrl,
      `/servers/slots?id=${encodeURIComponent(id)}`,
    );
    if (json) {
      process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
      return;
    }
    process.stdout.write(`[mba] ${body.id}  ${body.dir}\n`);
    process.stdout.write(`${JSON.stringify(body.slots, null, 2)}\n`);
    return;
  }
  if (action !== "save" && action !== "restore" && action !== "erase") {
    fail("usage: mba servers slots <id> [erase|save <file>|restore <file>] [slotId]");
  }
  const leftover = [...rest];
  let filename: string | undefined;
  if (action === "save" || action === "restore") {
    filename = leftover.shift();
    if (!filename) fail(`usage: mba servers slots <id> ${action} <filename> [slotId]`);
  }
  let slotId: number | undefined;
  if (leftover[0] !== undefined) {
    const n = Number(leftover[0]);
    if (!Number.isInteger(n) || n < 0) fail("slotId must be a non-negative integer");
    slotId = n;
  }
  const result = await servicePost<unknown>(baseUrl, "/servers/slots", {
    id,
    action,
    filename,
    slotId,
  });
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  process.stdout.write(`[mba] slot ${action} ok (${id})\n`);
}

async function pickServerId(baseUrl: string, title: string): Promise<string | null> {
  const { servers } = await serviceGet<{ servers: ServerEntry[] }>(baseUrl, "/servers");
  if (servers.length === 0) {
    process.stdout.write("[mba] no servers registered\n");
    return null;
  }
  const picked = await pickLabeledInteractive(
    title,
    servers.map((s) => ({
      label: s.id,
      value: s.id,
      preview: [
        ["id", s.id],
        ["port", String(s.port)],
        ["pid", s.pid !== undefined ? String(s.pid) : "—"],
        ["health", s.healthy ? "ok" : "down"],
        ["model", s.modelFile],
      ],
    })),
  );
  if (picked === null) cancelled();
  return picked;
}

async function cmdServersLogs(
  baseUrl: string,
  id: string,
  lines: number | undefined,
  follow: boolean,
): Promise<void> {
  const qs = new URLSearchParams({ id });
  if (lines !== undefined) qs.set("lines", String(lines));
  const path = `/servers/logs?${qs.toString()}`;

  if (!follow) {
    const body = await serviceGet<{ id: string; lines: string[] }>(baseUrl, path);
    for (const line of body.lines) process.stdout.write(`${line}\n`);
    return;
  }

  let printed = 0;
  process.stdout.write(`[mba] following ${id} (Ctrl-C to stop)\n`);
  for (;;) {
    let body: { id: string; lines: string[] };
    try {
      body = await serviceGet<{ id: string; lines: string[] }>(baseUrl, path);
    } catch (err) {
      if (err instanceof Error && /HTTP 404/.test(err.message)) {
        process.stdout.write(`\n[mba] ${id} no longer registered — stopping\n`);
        return;
      }
      throw err;
    }
    if (body.lines.length < printed) {
      printed = body.lines.length;
    } else {
      const fresh = body.lines.slice(printed);
      for (const line of fresh) process.stdout.write(`${line}\n`);
      printed = body.lines.length;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

async function fetchLlamaBinaries(baseUrl: string): Promise<{
  binaries: LlamaBinaryRow[];
  ignored: LlamaBinaryRow[];
  selected?: string;
}> {
  try {
    return await serviceGet<{ binaries: LlamaBinaryRow[]; ignored: LlamaBinaryRow[]; selected?: string }>(
      baseUrl,
      "/servers/binaries",
    );
  } catch {
    return { binaries: [], ignored: [] };
  }
}

async function applyBinaryAction(
  baseUrl: string,
  path: string,
  removed: boolean,
  currentNickname = "",
): Promise<void> {
  const actions = removed
    ? [
        { label: "restore", value: "restore", preview: [["do", "put this build back in the picker"] as const] },
        { label: "nickname", value: "nickname", preview: [["do", "name that survives rescan"] as const] },
      ]
    : [
        { label: "use", value: "use", preview: [["do", "boot with this binary by default"] as const] },
        { label: "nickname", value: "nickname", preview: [["do", "name that survives rescan"] as const] },
        { label: "remove", value: "remove", preview: [["do", "hide from the boot picker"] as const] },
      ];
  const action = await pickLabeledInteractive("build", actions);
  if (action === null) {
    cancelled();
    return;
  }
  if (action === "nickname") {
    const name = await askTextInteractive("nickname", currentNickname);
    if (name === null) {
      cancelled();
      return;
    }
    await servicePost(baseUrl, "/servers/binaries", { action: "nickname", path, nickname: name });
    process.stdout.write(`[mba] nickname ${name.trim().length === 0 ? "cleared" : "saved"}\n`);
    return;
  }
  await servicePost(baseUrl, "/servers/binaries", { action, path });
  const done =
    action === "use"
      ? "set as boot default"
      : action === "remove"
        ? "removed from picker"
        : "restored to picker";
  process.stdout.write(`[mba] ${done}\n`);
}

function printBinariesTable(binaries: LlamaBinaryRow[], ignored: LlamaBinaryRow[], selected?: string): void {
  if (binaries.length === 0 && ignored.length === 0) {
    process.stdout.write("[mba] no llama-server builds in the catalog — start the daemon to scan\n");
    return;
  }
  const nickWidth = llamaNickColumnWidth([...binaries, ...ignored]);
  for (const b of binaries) {
    process.stdout.write(`${formatLlamaServerLabel(b, { used: b.path === selected, nickWidth })}\n`);
  }
  for (const b of ignored) {
    process.stdout.write(`${formatLlamaServerLabel(b, { removed: true, nickWidth })}\n`);
  }
}

async function cmdServersBinaries(baseUrl: string, args: readonly string[], json: boolean): Promise<void> {
  const [action, path, ...rest] = args;
  if (action === undefined) {
    const catalog = await serviceGet<{
      binaries: LlamaBinaryRow[];
      ignored: LlamaBinaryRow[];
      selected?: string;
    }>(baseUrl, "/servers/binaries");
    if (json) {
      process.stdout.write(`${JSON.stringify(catalog, null, 2)}\n`);
      return;
    }
    if (process.stdin.isTTY) {
      await binariesMenu(baseUrl);
      return;
    }
    printBinariesTable(catalog.binaries, catalog.ignored, catalog.selected);
    return;
  }
  if (action === "rescan") {
    const catalog = await servicePost<{
      binaries: LlamaBinaryRow[];
      ignored: LlamaBinaryRow[];
      selected?: string;
    }>(baseUrl, "/servers/binaries", { action: "rescan" });
    if (json) {
      process.stdout.write(`${JSON.stringify(catalog, null, 2)}\n`);
      return;
    }
    printBinariesTable(catalog.binaries, catalog.ignored, catalog.selected);
    return;
  }
  if (!path) {
    fail("usage: mba servers binaries [use <path>|nickname <path> <name>|remove <path>|restore <path>|rescan]");
  }
  if (action === "nickname") {
    const nickname = rest.join(" ");
    await servicePost(baseUrl, "/servers/binaries", { action: "nickname", path, nickname });
    process.stdout.write(`[mba] nickname ${nickname.trim().length === 0 ? "cleared" : "saved"}\n`);
    return;
  }
  if (action === "use" || action === "remove" || action === "restore") {
    await servicePost(baseUrl, "/servers/binaries", { action, path });
    const done =
      action === "use" ? "set as boot default" : action === "remove" ? "removed from picker" : "restored to picker";
    process.stdout.write(`[mba] ${done}\n`);
    return;
  }
  fail("usage: mba servers binaries [use <path>|nickname <path> <name>|remove <path>|restore <path>|rescan]");
}

async function binariesMenu(baseUrl: string): Promise<void> {
  for (;;) {
    const catalog = await fetchLlamaBinaries(baseUrl);
    const nickWidth = llamaNickColumnWidth([...catalog.binaries, ...catalog.ignored]);
    const items = [
      ...catalog.binaries.map((b) => ({
        label: formatLlamaServerLabel(b, { used: b.path === catalog.selected, nickWidth }),
        value: b.path,
        preview: llamaServerPreview(b, { used: b.path === catalog.selected }),
      })),
      ...catalog.ignored.map((b) => ({
        label: formatLlamaServerLabel(b, { removed: true, nickWidth }),
        value: b.path,
        preview: llamaServerPreview(b, { removed: true }),
      })),
    ];
    if (items.length === 0) {
      process.stdout.write("[mba] no llama-server builds in the catalog — start the daemon to scan\n");
      return;
    }
    const path = await pickLabeledInteractive("builds", items);
    if (path === null) return;
    const row = [...catalog.binaries, ...catalog.ignored].find((b) => b.path === path);
    const removed = catalog.ignored.some((b) => b.path === path);
    await applyBinaryAction(baseUrl, path, removed, row?.nickname ?? "");
  }
}

async function serversMenu(
  baseUrl: string,
  json: boolean,
  assumeNo: boolean,
): Promise<void> {
  for (;;) {
    const pick = await pickLabeledInteractive("servers", [
      { label: "list", value: "list", preview: [["do", "running servers — stop or logs"]] },
      { label: "boot", value: "boot", preview: [["do", "start a model server"]] },
      { label: "stop", value: "stop", preview: [["do", "stop a registered server"]] },
      { label: "logs", value: "logs", preview: [["do", "captured llama.cpp output"]] },
      { label: "slots", value: "slots", preview: [["do", "KV list / erase / save / restore"]] },
      { label: "builds", value: "builds", preview: [["do", "llama-server catalog"]] },
    ]);
    if (pick === null) return;
    if (pick === "builds") {
      await binariesMenu(baseUrl);
      continue;
    }
    await cmdServers(baseUrl, [pick], json, assumeNo);
  }
}

export async function cmdServers(
  baseUrl: string,
  rest: readonly string[],
  json = false,
  assumeNo = false,
): Promise<void> {
  const [sub, ...args] = rest;
  switch (sub) {
    case undefined: {
      if (process.stdin.isTTY && !json) {
        await serversMenu(baseUrl, json, assumeNo);
        return;
      }
      await cmdServersList(baseUrl, true, json);
      return;
    }
    case "list": {
      await cmdServersList(baseUrl, args.includes("--plain"), json);
      return;
    }
    case "binaries":
    case "binary":
    case "builds": {
      await cmdServersBinaries(baseUrl, args, json);
      return;
    }
    case "boot": {
      let serverType: "llama.cpp" | "ollama" = "llama.cpp";
      const typeIdx = args.indexOf("--type");
      const positionalArgs =
        typeIdx === -1 ? args : [...args.slice(0, typeIdx), ...args.slice(typeIdx + 2)];
      if (typeIdx !== -1) {
        const typeVal = args[typeIdx + 1];
        if (typeVal !== "ollama" && typeVal !== "llama.cpp") {
          fail("usage: mba servers boot <model|path.gguf|tag> [port] [--type ollama]");
        }
        serverType = typeVal;
      }
      const [modelRef, portRaw] = positionalArgs;
      if (!modelRef) {
        if (process.stdin.isTTY && serverType === "llama.cpp") {
          await interactiveBoot(baseUrl, serverType, assumeNo);
          return;
        }
        fail("usage: mba servers boot <model|path.gguf|tag> [port] [--type ollama]");
      }
      const port = portRaw === undefined ? defaultSwitchPort() : Number(portRaw);
      if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        fail("usage: mba servers boot <model|path.gguf|tag> [port] [--type ollama]");
      }
      if (serverType === "llama.cpp") {
        const confirm = await confirmLlamaBoot(baseUrl, modelRef, port, assumeNo);
        if (!confirm.proceed) return;
        await cmdServersBoot(baseUrl, modelRef, port, serverType, confirm.binaryPath);
        return;
      }
      await cmdServersBoot(baseUrl, modelRef, port, serverType);
      return;
    }
    case "stop": {
      const [idArg] = args;
      let id = idArg;
      if (!id) {
        if (!process.stdin.isTTY) fail("usage: mba servers stop <id>");
        const picked = await pickServerId(baseUrl, "stop");
        if (picked === null) return;
        id = picked;
      }
      await cmdServersStop(baseUrl, id);
      return;
    }
    case "logs": {
      const follow = args.includes("--follow");
      const linesIdx = args.indexOf("--lines");
      let lines: number | undefined;
      let positional = args;
      if (linesIdx !== -1) {
        const raw = args[linesIdx + 1];
        const parsed = Number(raw);
        if (!Number.isInteger(parsed) || parsed < 0) {
          fail("usage: mba servers logs <id> [--lines N] [--follow]");
        }
        lines = parsed;
        positional = [...args.slice(0, linesIdx), ...args.slice(linesIdx + 2)];
      }
      let [id] = positional;
      if (!id) {
        if (!process.stdin.isTTY) fail("usage: mba servers logs <id> [--lines N] [--follow]");
        const picked = await pickServerId(baseUrl, "logs");
        if (picked === null) return;
        id = picked;
      }
      await cmdServersLogs(baseUrl, id, lines, follow);
      return;
    }
    case "slots":
    case "slot": {
      let [id, action, ...rest] = args;
      if (!id) {
        if (!process.stdin.isTTY) {
          fail("usage: mba servers slots <id> [erase|save <file>|restore <file>] [slotId]");
        }
        const picked = await pickServerId(baseUrl, "slots");
        if (picked === null) return;
        id = picked;
      }
      await cmdServersSlots(baseUrl, id, action, rest, json);
      return;
    }
    default:
      fail(
        "usage: mba servers <list|boot|stop|logs|slots|binaries|builds>\n" +
          "  list [--plain]       list registered servers (interactive on a TTY; --plain forces the table)\n" +
          "  boot <ref> [port]    boot a model server (port defaults to 8080) [--type ollama]\n" +
          "  stop <id>            stop a registered server (by id)\n" +
          "  logs <id>            show a server's captured log lines [--lines N] [--follow]\n" +
          "  slots <id>           list llama.cpp slots; erase|save <file>|restore <file> [slotId]\n" +
          "  binaries|builds      nickname / use / remove llama-server builds (TTY picker)",
      );
  }
}
