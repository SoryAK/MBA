/**
 * Server plane (ADR-0097): list / boot / stop / logs.
 */

import { defaultSwitchPort, fail, serviceGet, servicePost } from "./client.js";
import { groupFlagPairs, pairCliArgs } from "./flag-pairs.js";
import { brand, dim, doneBox, heading, kv } from "./style.js";
import {
  askPortInteractive,
  askYesNoInteractive,
  pickLabeledInteractive,
  pickModelInteractive,
  pickServerInteractive,
  type ModelEntry,
} from "./interactive.js";
import { resolveModelFile } from "./resolve-model.js";
import type { BootResult, ServerEntry } from "./types.js";

function cancelled(): void {
  process.stdout.write("[mba] cancelled\n");
}

function printServersTable(servers: ServerEntry[]): void {
  const header =
    "id".padEnd(18) +
    "port".padEnd(8) +
    "pid".padEnd(10) +
    "healthy".padEnd(9) +
    "resolved".padEnd(9) +
    "dup".padEnd(5) +
    "model";
  process.stdout.write(header + "\n");
  for (const s of servers) {
    process.stdout.write(
      s.id.padEnd(18) +
        String(s.port).padEnd(8) +
        (s.pid !== undefined ? String(s.pid) : "-").padEnd(10) +
        (s.healthy ? "yes" : "no").padEnd(9) +
        (s.resolved ? "yes" : "no").padEnd(9) +
        (s.duplicate ? "yes" : "-").padEnd(5) +
        s.modelFile +
        "\n",
    );
  }
}

async function cmdServersList(baseUrl: string, plain: boolean, json = false): Promise<void> {
  const { servers } = await serviceGet<{ servers: ServerEntry[] }>(baseUrl, "/servers");
  if (json) {
    process.stdout.write(`${JSON.stringify(servers, null, 2)}\n`);
    return;
  }
  if (servers.length === 0) {
    process.stdout.write("[mba] no servers registered\n");
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

export function printBootPreview(modelId: string, port: number, cliArgs: readonly string[]): void {
  const pairs = pairCliArgs(cliArgs);
  const groups = groupFlagPairs(pairs);
  const flagWidth = Math.min(
    22,
    Math.max(12, ...pairs.map((p) => p.flag.length), 12),
  );
  process.stdout.write(`${brand("boot")}\n`);
  process.stdout.write(`${kv("model", modelId, 5)}\n`);
  process.stdout.write(`${kv("port", String(port), 5)}\n`);
  for (const group of groups) {
    process.stdout.write(`\n  ${heading(group.name)}\n`);
    for (const { flag, value } of group.pairs) {
      process.stdout.write(`    ${dim(flag.padEnd(flagWidth))}  ${value}\n`);
    }
  }
  process.stdout.write("\n");
}

async function confirmLlamaBoot(
  baseUrl: string,
  modelRef: string,
  port: number,
  assumeNo: boolean,
): Promise<boolean> {
  try {
    const modelFile = await resolveModelFile(baseUrl, modelRef);
    const recipe = await servicePost<{ cliArgs: string[] }>(baseUrl, "/servers/resolve", {
      modelFile,
    });
    printBootPreview(modelRef, port, recipe.cliArgs);
  } catch {
    process.stdout.write("[mba] could not preview flags — proceeding to boot\n");
    return true;
  }
  if (!process.stdin.isTTY || assumeNo) return true;
  const proceed = await askYesNoInteractive("boot with these flags?");
  if (proceed !== true) {
    cancelled();
    return false;
  }
  return true;
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
    const ok = await confirmLlamaBoot(baseUrl, picked.id, port, assumeNo);
    if (!ok) return;
  }

  await cmdServersBoot(baseUrl, picked.id, port, serverType);
}

async function cmdServersBoot(
  baseUrl: string,
  modelRef: string,
  port: number,
  serverType: "llama.cpp" | "ollama",
): Promise<BootResult> {
  if (serverType === "ollama") {
    process.stdout.write(`[mba] loading ${modelRef} into ollama (waits for load)…\n`);
    const entry = await servicePost<BootResult>(baseUrl, "/servers/boot", {
      serverType: "ollama",
      modelRef,
      port,
    });
    process.stdout.write(
      doneBox("BOOTED", [
        ["id", entry.id],
        ["port", String(entry.port)],
        ["next", `mba s logs ${entry.id}`],
      ]) + "\n",
    );
    return entry;
  }
  const modelFile = await resolveModelFile(baseUrl, modelRef);
  process.stdout.write(`[mba] booting ${modelFile} on port ${port} (waits for warmup)…\n`);
  const entry = await servicePost<BootResult>(baseUrl, "/servers/boot", {
    modelFile,
    port,
  });
  process.stdout.write(
    doneBox("BOOTED", [
      ["id", entry.id],
      ["port", String(entry.port)],
      ["pid", entry.pid !== undefined ? String(entry.pid) : "-"],
      ["next", `mba s logs ${entry.id}`],
    ]) + "\n",
  );
  return entry;
}

async function cmdServersStop(baseUrl: string, id: string): Promise<void> {
  await servicePost<{ stopped: string }>(baseUrl, "/servers/stop", { id });
  process.stdout.write(`[mba] stopped ${id}\n`);
}

async function pickServerId(baseUrl: string, title: string): Promise<string | null> {
  const { servers } = await serviceGet<{ servers: ServerEntry[] }>(baseUrl, "/servers");
  if (servers.length === 0) {
    process.stdout.write("[mba] no servers registered\n");
    return null;
  }
  return pickLabeledInteractive(
    title,
    servers.map((s) => ({
      label: `${s.id}  :${s.port}${s.healthy ? "" : "  down"}`,
      value: s.id,
    })),
  );
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

async function serversMenu(
  baseUrl: string,
  json: boolean,
  assumeNo: boolean,
): Promise<void> {
  const pick = await pickLabeledInteractive("servers", [
    { label: "list", value: "list" },
    { label: "boot", value: "boot" },
    { label: "stop", value: "stop" },
  ]);
  if (pick === null) {
    cancelled();
    return;
  }
  await cmdServers(baseUrl, [pick], json, assumeNo);
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
        const ok = await confirmLlamaBoot(baseUrl, modelRef, port, assumeNo);
        if (!ok) return;
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
        if (picked === null) {
          cancelled();
          return;
        }
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
        if (picked === null) {
          cancelled();
          return;
        }
        id = picked;
      }
      await cmdServersLogs(baseUrl, id, lines, follow);
      return;
    }
    default:
      fail(
        "usage: mba servers <list|boot|stop|logs>\n" +
          "  list [--plain]       list registered servers (interactive on a TTY; --plain forces the table)\n" +
          "  boot <ref> [port]    boot a model server (port defaults to 8080) [--type ollama]\n" +
          "  stop <id>            stop a registered server (by id)\n" +
          "  logs <id>            show a server's captured log lines [--lines N] [--follow]",
      );
  }
}
