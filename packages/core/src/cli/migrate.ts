/**
 * Adopt local GGUFs into the model hub (scan here, write on the daemon).
 *
 * `mba migrate models [dir]` — walk one folder.
 * `mba migrate find [query] [--from <dir>]` — fuzzy-find, then the same adopt.
 */

import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fail, formatBytes, serviceGet, servicePost } from "./client.js";
import {
  askTextInteractive,
  askYesNoInteractive,
  pickLabeledInteractive,
  pickManyInteractive,
  type ModelEntry,
  type PreviewPickItem,
} from "./interactive.js";
import {
  catalogSkipFromModelFiles,
  defaultFindRoots,
  isAlreadyInHub,
  rankGgufs,
  scanGgufs,
  type FoundGguf,
} from "../model/gguf-scan.js";
import { deriveModelId } from "../model/model-id.js";
import { adoptedLine, brand, dim, shortenHome } from "./style.js";

const MODELS_USAGE = "usage: mba migrate models [dir] [--move] [--yes] [--json]";
const FIND_USAGE = "usage: mba migrate find [query] [--from <dir>] [--move] [--yes] [--json]";
const GROUP_USAGE =
  "usage: mba migrate <models|find>\n" +
  "  models [dir]              GGUFs in that folder → hub\n" +
  "  find [query] [--from dir] fuzzy-find GGUFs → hub\n" +
  "  --move                    skip the ask; remove source after adopt";

interface AdoptResult {
  readonly id: string;
  readonly family: string;
  readonly sha256: string;
  readonly modelDir: string;
  readonly adapterPath: string;
  readonly familyCreated: boolean;
  readonly placed: "copy" | "hardlink" | "inplace";
  readonly moved: boolean;
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

function absPath(path: string): string {
  const expanded = expandHome(path);
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}

function parseMigrateFlags(
  args: readonly string[],
  allowFrom: boolean,
  usage: string,
): { move: boolean; from?: string; rest: string[] } {
  const rest: string[] = [];
  let move = false;
  let from: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--move") {
      move = true;
      continue;
    }
    if (a === "--from" || a.startsWith("--from=")) {
      if (!allowFrom) fail(`unknown flag: ${a}\n${usage}`);
      if (a.startsWith("--from=")) {
        from = a.slice("--from=".length);
        if (!from) fail(usage);
        continue;
      }
      const next = args[i + 1];
      if (!next || next.startsWith("-")) fail(usage);
      from = next;
      i++;
      continue;
    }
    if (a.startsWith("-")) fail(`unknown flag: ${a}\n${usage}`);
    rest.push(a);
  }
  return { move, from, rest };
}

function foundItems(files: readonly FoundGguf[]): PreviewPickItem[] {
  return files.map((f) => ({
    label: f.fileName,
    value: f.path,
    preview: [
      ["file", shortenHome(f.path)],
      ["size", formatBytes(f.bytes)],
      ["quant", f.quant ?? "—"],
      ["name", f.ggufName ?? "—"],
    ],
  }));
}

async function hubSkip(baseUrl: string) {
  const { models } = await serviceGet<{ models: ModelEntry[] }>(baseUrl, "/models");
  return catalogSkipFromModelFiles(models.map((m) => m.modelFile));
}

function dropCataloged(files: readonly FoundGguf[], skip: ReturnType<typeof catalogSkipFromModelFiles>): FoundGguf[] {
  return files.filter((f) => !isAlreadyInHub(f.path, skip));
}

async function confirmIds(
  files: readonly FoundGguf[],
  assumeNo: boolean,
): Promise<Array<{ file: FoundGguf; id: string; family: string }> | null> {
  const out: Array<{ file: FoundGguf; id: string; family: string }> = [];
  for (const file of files) {
    const defaultId = deriveModelId(file.fileName);
    if (assumeNo) {
      out.push({ file, id: defaultId, family: defaultId });
      continue;
    }
    if (!process.stdin.isTTY) {
      out.push({ file, id: defaultId, family: defaultId });
      continue;
    }
    const id = await askTextInteractive("model id", defaultId);
    if (id === null) return null;
    const family = await askTextInteractive("family", id);
    if (family === null) return null;
    out.push({ file, id, family });
  }
  return out;
}

async function adoptOne(
  baseUrl: string,
  path: string,
  id: string,
  family: string,
  move: boolean,
): Promise<AdoptResult> {
  const body: Record<string, unknown> = { path, id, family };
  if (move) body.move = true;
  return servicePost<AdoptResult>(baseUrl, "/models/adopt", body);
}

async function adoptPicked(
  baseUrl: string,
  files: readonly FoundGguf[],
  assumeNo: boolean,
  json: boolean,
  move: boolean,
): Promise<void> {
  if (files.length === 0) {
    if (json) {
      process.stdout.write("[]\n");
      return;
    }
    process.stdout.write(`${brand("migrate")}\n  ${dim("none new")}\n`);
    return;
  }

  let chosen: FoundGguf[] = [...files];
  const batch = json || assumeNo || !process.stdin.isTTY;
  if (!batch) {
    const picked = await pickManyInteractive("adopt", foundItems(files));
    if (picked === null) {
      process.stdout.write("[mba] cancelled\n");
      return;
    }
    const byPath = new Map(files.map((f) => [f.path, f]));
    chosen = picked.map((p) => byPath.get(p)).filter((f): f is FoundGguf => f !== undefined);
  }

  const named = await confirmIds(chosen, batch);
  if (named === null) {
    process.stdout.write("[mba] cancelled\n");
    return;
  }
  if (named.length === 0) return;

  let doMove = move;
  if (!doMove && !batch && process.stdin.isTTY) {
    const prompt =
      named.length === 1 ? "remove source after adopt?" : "remove source files after adopt?";
    const answer = await askYesNoInteractive(prompt);
    if (answer === null) {
      process.stdout.write("[mba] cancelled\n");
      return;
    }
    doMove = answer;
  }

  const results: AdoptResult[] = [];
  let failed = 0;
  for (const row of named) {
    if (!json) process.stdout.write(`[mba] adopting ${row.id}...\n`);
    try {
      const result = await adoptOne(baseUrl, row.file.path, row.id, row.family, doMove);
      results.push(result);
      if (!json) {
        process.stdout.write(`${adoptedLine(result.id, result.family)}\n`);
        process.stdout.write(`${dim(`  ${shortenHome(result.modelDir)}`)}\n`);
        if (result.moved) process.stdout.write(`${dim("  source removed")}\n`);
      }
    } catch (err) {
      failed += 1;
      process.stderr.write(
        `[mba] error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
  if (json) {
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  }
  if (failed > 0) process.exit(1);
}

async function scanRoots(roots: readonly string[]): Promise<FoundGguf[]> {
  const seen = new Set<string>();
  const out: FoundGguf[] = [];
  for (const root of roots) {
    for (const file of scanGgufs(root)) {
      if (seen.has(file.path)) continue;
      seen.add(file.path);
      out.push(file);
    }
  }
  return out;
}

async function cmdMigrateModels(
  baseUrl: string,
  args: readonly string[],
  assumeNo: boolean,
  json: boolean,
  move: boolean,
): Promise<void> {
  let dir = args[0];
  if (args.length > 1) fail(MODELS_USAGE);
  if (!dir && process.stdin.isTTY && !json && !assumeNo) {
    dir = (await askTextInteractive("source", join(homedir(), "models"))) ?? undefined;
    if (!dir) {
      process.stdout.write("[mba] cancelled\n");
      return;
    }
  }
  if (!dir) fail(MODELS_USAGE);

  const root = absPath(dir);
  const skip = await hubSkip(baseUrl);
  const found = dropCataloged(await scanRoots([root]), skip);
  await adoptPicked(baseUrl, found, assumeNo, json, move);
}

async function cmdMigrateFind(
  baseUrl: string,
  queryArg: string,
  from: string | undefined,
  assumeNo: boolean,
  json: boolean,
  move: boolean,
): Promise<void> {
  let query = queryArg.trim();
  if (!query && process.stdin.isTTY && !json && !assumeNo) {
    query = (await askTextInteractive("find", "")) ?? "";
    if (!query.trim()) {
      process.stdout.write("[mba] cancelled\n");
      return;
    }
  }
  if (!query.trim()) fail(FIND_USAGE);

  const roots = from ? [absPath(from)] : defaultFindRoots();
  if (roots.length === 0) {
    if (json) {
      process.stdout.write("[]\n");
      return;
    }
    process.stdout.write(
      `${brand("migrate")}\n  ${dim("no search roots — pass --from <dir> or add ~/models")}\n`,
    );
    return;
  }

  const skip = await hubSkip(baseUrl);
  const ranked = dropCataloged(rankGgufs(await scanRoots(roots), query), skip);
  await adoptPicked(baseUrl, ranked, assumeNo, json, move);
}

async function migrateMenu(
  baseUrl: string,
  assumeNo: boolean,
  json: boolean,
  move: boolean,
): Promise<void> {
  for (;;) {
    const pick = await pickLabeledInteractive("migrate", [
      { label: "models", value: "models", preview: [["do", "GGUFs in one folder → hub"]] },
      { label: "find", value: "find", preview: [["do", "fuzzy-find GGUFs → hub"]] },
    ]);
    if (pick === null) return;
    if (pick === "models") await cmdMigrateModels(baseUrl, [], assumeNo, json, move);
    else await cmdMigrateFind(baseUrl, "", undefined, assumeNo, json, move);
  }
}

export async function cmdMigrate(
  baseUrl: string,
  action: "menu" | "models" | "find",
  args: readonly string[],
  assumeNo: boolean,
  json: boolean,
): Promise<void> {
  switch (action) {
    case "menu": {
      const { move, rest } = parseMigrateFlags(args, false, GROUP_USAGE);
      if (rest.length > 0) fail(GROUP_USAGE);
      if (json) {
        process.stdout.write(`${JSON.stringify({ actions: ["models", "find"] }, null, 2)}\n`);
        return;
      }
      if (process.stdin.isTTY) {
        await migrateMenu(baseUrl, assumeNo, json, move);
        return;
      }
      fail(GROUP_USAGE);
      return;
    }
    case "models": {
      const { move, rest } = parseMigrateFlags(args, false, MODELS_USAGE);
      await cmdMigrateModels(baseUrl, rest, assumeNo, json, move);
      return;
    }
    case "find": {
      const { move, from, rest } = parseMigrateFlags(args, true, FIND_USAGE);
      await cmdMigrateFind(baseUrl, rest.join(" "), from, assumeNo, json, move);
      return;
    }
  }
}
