/**
 * Client plane: list paired sessions, add operator clients, connect, revoke.
 */

import { formatClientLabel } from "../service/env-context.js";
import { fail, serviceGet, servicePost } from "./client.js";
import { listHarnessChoices } from "./harness-choices.js";
import { askValueInteractive, pickLabeledInteractive } from "./interactive.js";
import { cmdModelsConnect } from "./models.js";
import { defaultStorePaths } from "../service/config-store.js";
import {
  addOperatorClient,
  removeOperatorClient,
} from "../service/operator-clients.js";
import { brand, dim, heading, paint, shortenHome, BOLD } from "./style.js";

interface PublicSession {
  readonly id: string;
  readonly modelId: string;
  readonly harness: string;
  readonly ide?: string;
  readonly projectRoot: string;
  readonly createdAt: string;
  readonly card?: boolean;
}

async function listSessions(baseUrl: string): Promise<readonly PublicSession[]> {
  const st = await serviceGet<{
    pairing?: { sessions?: readonly PublicSession[] };
  }>(baseUrl, "/status");
  return st.pairing?.sessions ?? [];
}

function printSession(s: PublicSession): void {
  const who = formatClientLabel(s.harness, s.ide);
  const tag = (s.card ? "card" : "pair").padEnd(4);
  process.stdout.write(
    `    ${paint(who.padEnd(18), BOLD)}  ${s.modelId.padEnd(22)}  ${s.card ? paint(tag, BOLD) : dim(tag)}  ${dim(shortenHome(s.projectRoot))}\n`,
  );
}

async function cmdClientsList(baseUrl: string, json: boolean): Promise<void> {
  const catalog = listHarnessChoices();
  const sessions = await listSessions(baseUrl);
  if (json) {
    process.stdout.write(`${JSON.stringify({ clients: catalog, sessions }, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${brand("clients")}\n`);
  process.stdout.write(`  ${heading("registered")}\n`);
  for (const h of catalog) {
    const tag = h.source === "added" ? "  added" : "";
    process.stdout.write(
      `    ${paint(h.name.padEnd(18), BOLD)}  ${dim(h.envelope)}${tag}\n`,
    );
  }
  process.stdout.write(`  ${heading("paired")}\n`);
  if (sessions.length === 0) {
    process.stdout.write(`    ${dim("none — mba connect to pair")}\n`);
    return;
  }
  for (const s of sessions) printSession(s);
}

const ADD_USAGE =
  "usage: mba clients add <name> --envelope <path> [--ide <name>]";

async function cmdClientsAdd(args: readonly string[], json: boolean): Promise<void> {
  let name: string | undefined;
  let envelope: string | undefined;
  let ide: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--envelope") {
      envelope = args[++i];
      if (!envelope || envelope.startsWith("-")) fail(ADD_USAGE);
    } else if (a === "--ide") {
      ide = args[++i];
      if (!ide || ide.startsWith("-")) fail(ADD_USAGE);
    } else if (a.startsWith("-")) fail(`unknown flag for add: ${a}\n${ADD_USAGE}`);
    else if (!name) name = a;
    else fail(ADD_USAGE);
  }

  if (!name && process.stdin.isTTY) {
    name = (await askValueInteractive("name", "", "windsurf")) ?? undefined;
    if (!name) {
      process.stdout.write("[mba] cancelled\n");
      return;
    }
  }
  if (!envelope && process.stdin.isTTY) {
    envelope =
      (await askValueInteractive("envelope", "", ".windsurf/mba.md")) ?? undefined;
    if (!envelope) {
      process.stdout.write("[mba] cancelled\n");
      return;
    }
  }
  if (!name || !envelope) fail(ADD_USAGE);

  const path = defaultStorePaths().clientsPath;
  const result = addOperatorClient(path, { name, envelope, ide });
  if (!result.ok) fail(result.error);
  if (json) {
    process.stdout.write(`${JSON.stringify(result.client, null, 2)}\n`);
    return;
  }
  process.stdout.write(
    result.updated
      ? `[mba] updated client ${result.client.name} → ${result.client.envelope}\n`
      : `[mba] added client ${result.client.name} → ${result.client.envelope}\n`,
  );
}

const REMOVE_USAGE = "usage: mba clients remove <name>";

async function cmdClientsRemove(args: readonly string[], json: boolean): Promise<void> {
  let name = args[0];
  if (!name) {
    if (!process.stdin.isTTY) fail(REMOVE_USAGE);
    const added = listHarnessChoices().filter((h) => h.source === "added");
    if (added.length === 0) {
      process.stdout.write("[mba] no added clients to remove\n");
      return;
    }
    const picked = await pickLabeledInteractive(
      "remove",
      added.map((h) => ({
        label: h.name,
        value: h.name,
        preview: [["envelope", h.envelope]] as const,
      })),
    );
    if (picked === null) return;
    name = picked;
  }
  const result = removeOperatorClient(defaultStorePaths().clientsPath, name);
  if (!result.ok) fail(result.error);
  if (json) {
    process.stdout.write(`${JSON.stringify({ removed: result.removed, name }, null, 2)}\n`);
    return;
  }
  process.stdout.write(
    result.removed
      ? `[mba] removed client ${name}\n`
      : `[mba] no added client named ${name}\n`,
  );
}

async function cmdClientsRevoke(
  baseUrl: string,
  args: readonly string[],
  json: boolean,
): Promise<void> {
  if (args.includes("--all") || args[0] === "all") {
    await cmdModelsConnect(baseUrl, ["--revoke"], json);
    return;
  }
  if (args.length > 0) {
    await cmdModelsConnect(baseUrl, ["--revoke", ...args], json);
    return;
  }
  if (!process.stdin.isTTY) {
    fail("usage: mba clients revoke [id]  |  mba clients revoke --all");
  }
  const sessions = await listSessions(baseUrl);
  if (sessions.length === 0) {
    process.stdout.write("[mba] no paired clients\n");
    return;
  }
  const pick = await pickLabeledInteractive("revoke", [
    ...sessions.map((s) => ({
      label: `${s.harness} · ${s.modelId}`,
      value: JSON.stringify({
        id: s.modelId,
        harness: s.harness,
        projectRoot: s.projectRoot,
      }),
      preview: [
        ["harness", s.harness],
        ["model", s.modelId],
        ["project", shortenHome(s.projectRoot)],
      ] as const,
    })),
    {
      label: "all",
      value: "all",
      preview: [["do", "unlock chat (drop every session)"]] as const,
    },
  ]);
  if (pick === null) return;
  if (pick === "all") {
    await cmdModelsConnect(baseUrl, ["--revoke"], json);
    return;
  }
  const target = JSON.parse(pick) as {
    id: string;
    harness: string;
    projectRoot: string;
  };
  const result = await servicePost<{ pairing: { active: boolean; count: number } }>(
    baseUrl,
    "/connect/revoke",
    target,
  );
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  process.stdout.write(
    result.pairing.active
      ? `[mba] revoked — ${result.pairing.count} session(s) still paired\n`
      : "[mba] pairing off — chat is open again\n",
  );
}

async function clientsMenu(baseUrl: string, json: boolean): Promise<void> {
  for (;;) {
    const pick = await pickLabeledInteractive("clients", [
      { label: "list", value: "list", preview: [["do", "registered + paired"]] },
      { label: "add", value: "add", preview: [["do", "name + envelope for a sixth editor"]] },
      { label: "connect", value: "connect", preview: [["do", "stage card + mint a token"]] },
      { label: "revoke", value: "revoke", preview: [["do", "drop a pairing (unlock chat)"]] },
      { label: "remove", value: "remove", preview: [["do", "drop an added client"]] },
    ]);
    if (pick === null) return;
    await cmdClients(baseUrl, [pick], json);
  }
}

export async function cmdClients(
  baseUrl: string,
  rest: readonly string[],
  json = false,
): Promise<void> {
  const [sub, ...args] = rest;
  switch (sub) {
    case undefined: {
      if (process.stdin.isTTY && !json) {
        await clientsMenu(baseUrl, json);
        return;
      }
      await cmdClientsList(baseUrl, json);
      return;
    }
    case "list":
      await cmdClientsList(baseUrl, json);
      return;
    case "add":
      await cmdClientsAdd(args, json);
      return;
    case "remove":
      await cmdClientsRemove(args, json);
      return;
    case "connect":
      await cmdModelsConnect(baseUrl, args, json);
      return;
    case "revoke":
      await cmdClientsRevoke(baseUrl, args, json);
      return;
    default:
      fail(
        "usage: mba clients <list|add|connect|revoke|remove>\n" +
          "  list                    registered + paired\n" +
          "  add <name> --envelope   operator-defined client\n" +
          "  connect [id]            stage + pair (--harness, --project)\n" +
          "  revoke [id]             drop a pairing (--all unlocks chat)\n" +
          "  remove <name>           drop an added client\n",
      );
  }
}
