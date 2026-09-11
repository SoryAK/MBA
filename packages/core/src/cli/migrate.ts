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
import { assignAdoptIds, groupGgufs, ggufStem, type GgufGroup } from "../model/gguf-group.js";
import { listHubFamilies, suggestFamily, type HubFamily } from "../model/suggest-family.js";
import { askFamilyInteractive } from "./family-choices.js";
import { adoptedIdLine, adoptedLine, brand, dim, kv, shortenHome } from "./style.js";

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

function filePreviewRows(files: readonly FoundGguf[]): Array<readonly [string, string]> {
  return files.map((f) => ["file", f.fileName]);
}

function groupItems(groups: readonly GgufGroup[]): PreviewPickItem[] {
  return groups.map((g) => {
    const n = g.files.length;
    const bytes = g.files.reduce((sum, f) => sum + f.bytes, 0);
    const name = g.files.find((f) => f.ggufName)?.ggufName ?? "—";
    return {
      label: `${g.stem}  ${n} file${n === 1 ? "" : "s"}`,
      value: g.key,
      preview: [
        ["name", name],
        ["size", formatBytes(bytes)],
        ...filePreviewRows(g.files),
      ],
    };
  });
}

async function hubCatalog(baseUrl: string): Promise<{
  skip: ReturnType<typeof catalogSkipFromModelFiles>;
  families: HubFamily[];
}> {
  const { models } = await serviceGet<{ models: ModelEntry[] }>(baseUrl, "/models");
  return {
    skip: catalogSkipFromModelFiles(models.map((m) => m.modelFile)),
    families: listHubFamilies(models),
  };
}

function dropCataloged(files: readonly FoundGguf[], skip: ReturnType<typeof catalogSkipFromModelFiles>): FoundGguf[] {
  return files.filter((f) => !isAlreadyInHub(f.path, skip));
}

function groupNeedles(group: GgufGroup): string[] {
  const first = group.files[0];
  return [
    group.stem,
    first?.ggufName ?? "",
    first ? ggufStem(first.fileName) : "",
    first?.fileName ?? "",
  ];
}

function defaultFamily(group: GgufGroup, families: readonly HubFamily[]): string {
  return suggestFamily(groupNeedles(group), families) ?? group.stem;
}

interface NamedGroup {
  readonly group: GgufGroup;
  readonly family: string;
  readonly rows: Array<{ file: FoundGguf; id: string }>;
}

function fileItems(files: readonly FoundGguf[]): PreviewPickItem[] {
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

async function refineGroup(
  group: GgufGroup,
  pool: readonly FoundGguf[],
): Promise<GgufGroup | null> {
  if (group.files.length === 1) return group;
  const n = group.files.length;
  const action = await pickLabeledInteractive("group", [
    {
      label: "adopt",
      value: "adopt",
      preview: [
        ["do", `adopt all ${n}`],
        ...filePreviewRows(group.files),
      ],
    },
    {
      label: "edit",
      value: "edit",
      preview: [
        ["do", "unmark to drop, mark to add, then adopt the rest"],
        ...filePreviewRows(group.files),
      ],
    },
  ]);
  if (action === null) return null;
  if (action === "adopt") return group;
  const inGroup = new Set(group.files.map((f) => f.path));
  const extras = pool.filter((f) => !inGroup.has(f.path));
  const picked = await pickManyInteractive("files", fileItems([...group.files, ...extras]), {
    marked: group.files.map((f) => f.path),
  });
  if (picked === null) return null;
  const byPath = new Map(pool.map((f) => [f.path, f]));
  const next = picked.map((p) => byPath.get(p)).filter((f): f is FoundGguf => f !== undefined);
  return { ...group, files: next };
}

async function confirmGroup(
  group: GgufGroup,
  assumeNo: boolean,
  families: readonly HubFamily[],
): Promise<NamedGroup | null> {
  const ids = assignAdoptIds(group.files);
  const rows = group.files.map((file) => ({ file, id: ids.get(file.path) ?? file.fileName }));
  if (assumeNo || !process.stdin.isTTY) {
    return { group, family: defaultFamily(group, families), rows };
  }
  if (group.files.length === 1) {
    const only = rows[0]!;
    const id = await askTextInteractive("model id", only.id);
    if (id === null) return null;
    const family = await askFamilyInteractive(groupNeedles(group), families);
    if (family === null) return null;
    return { group, family, rows: [{ file: only.file, id }] };
  }
  const family = await askFamilyInteractive(groupNeedles(group), families);
  if (family === null) return null;
  return { group, family, rows };
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

function printSingleton(
  result: AdoptResult,
): void {
  process.stdout.write(`${adoptedLine(result.id, result.family)}\n`);
  process.stdout.write(`${dim(`  ${shortenHome(result.modelDir)}`)}\n`);
  if (result.moved) process.stdout.write(`${dim("  source removed")}\n`);
}

function printBulkFooter(family: string, moved: boolean, count: number): void {
  process.stdout.write(`${kv("family", family, 8)}\n`);
  if (moved) process.stdout.write(`${kv("source", "removed", 8)}\n`);
  const any = count === 1 ? "" : `   (any of the ${count})`;
  process.stdout.write(`${kv("next", `mba s boot <id>${any}`, 8)}\n`);
}

async function adoptPicked(
  baseUrl: string,
  files: readonly FoundGguf[],
  assumeNo: boolean,
  json: boolean,
  move: boolean,
  families: readonly HubFamily[],
): Promise<void> {
  if (files.length === 0) {
    if (json) {
      process.stdout.write("[]\n");
      return;
    }
    process.stdout.write(`${brand("migrate")}\n  ${dim("none new")}\n`);
    return;
  }

  const groups = groupGgufs(files);
  let chosen = groups;
  const batch = json || assumeNo || !process.stdin.isTTY;
  if (!batch) {
    const picked = await pickManyInteractive("adopt", groupItems(groups));
    if (picked === null) {
      process.stdout.write("[mba] cancelled\n");
      return;
    }
    const byKey = new Map(groups.map((g) => [g.key, g]));
    const pickedGroups = picked.map((k) => byKey.get(k)).filter((g): g is GgufGroup => g !== undefined);
    chosen = [];
    for (const group of pickedGroups) {
      const refined = await refineGroup(group, files);
      if (refined === null) {
        process.stdout.write("[mba] cancelled\n");
        return;
      }
      if (refined.files.length === 0) continue;
      chosen.push(refined);
    }
    const seen = new Set<string>();
    chosen = chosen.map((g) => {
      const next = g.files.filter((f) => {
        if (seen.has(f.path)) return false;
        seen.add(f.path);
        return true;
      });
      return { ...g, files: next };
    }).filter((g) => g.files.length > 0);
  }
  if (chosen.length === 0) return;

  const named: NamedGroup[] = [];
  for (const group of chosen) {
    const row = await confirmGroup(group, batch, families);
    if (row === null) {
      process.stdout.write("[mba] cancelled\n");
      return;
    }
    named.push(row);
  }

  let doMove = move;
  if (!doMove && !batch && process.stdin.isTTY) {
    const n = named.reduce((sum, g) => sum + g.rows.length, 0);
    const prompt = n === 1 ? "remove source after adopt?" : "remove source files after adopt?";
    const answer = await askYesNoInteractive(prompt);
    if (answer === null) {
      process.stdout.write("[mba] cancelled\n");
      return;
    }
    doMove = answer;
  }

  const results: AdoptResult[] = [];
  let failed = 0;
  for (const pack of named) {
    const bulk = pack.rows.length > 1;
    if (!json && bulk) {
      process.stdout.write(`[mba] adopting ${pack.rows.length}...\n`);
    }
    let groupMoved = false;
    let groupOk = 0;
    for (const row of pack.rows) {
      if (!json && !bulk) process.stdout.write(`[mba] adopting ${row.id}...\n`);
      try {
        const result = await adoptOne(baseUrl, row.file.path, row.id, pack.family, doMove);
        results.push(result);
        groupOk += 1;
        if (result.moved) groupMoved = true;
        if (!json && bulk) {
          process.stdout.write(`${adoptedIdLine(result.id)}\n`);
        } else if (!json) {
          printSingleton(result);
        }
      } catch (err) {
        failed += 1;
        process.stderr.write(
          `[mba] error: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }
    if (!json && bulk && groupOk > 0) {
      process.stdout.write("\n");
      printBulkFooter(pack.family, groupMoved, groupOk);
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
  const { skip, families } = await hubCatalog(baseUrl);
  const found = dropCataloged(await scanRoots([root]), skip);
  await adoptPicked(baseUrl, found, assumeNo, json, move, families);
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

  const { skip, families } = await hubCatalog(baseUrl);
  const ranked = dropCataloged(rankGgufs(await scanRoots(roots), query), skip);
  await adoptPicked(baseUrl, ranked, assumeNo, json, move, families);
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
