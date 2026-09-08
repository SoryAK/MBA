/**
 * Model plane: list / show / set / open / pull / guided edit.
 */

import { fail, serviceGet, servicePost, servicePostSse } from "./client.js";
import { brand, dim, doneBox, heading, option, paint, shortenHome, BOLD } from "./style.js";
import {
  askTextInteractive,
  askValueInteractive,
  pickFieldInteractive,
  pickLabeledInteractive,
  pickModelInteractive,
  searchHfInteractive,
  type ModelEntry,
} from "./interactive.js";
import { listHfGgufs, searchHfModels } from "../model/hf-resolve.js";
import { handleRestartPrompt, parseValue } from "./restart.js";
import type { ModelConfig, SetResult } from "./types.js";

function printConfig(cfg: ModelConfig): void {
  process.stdout.write(`${brand("show")}  ${paint(cfg.modelId, BOLD)}\n`);
  process.stdout.write(`  ${dim("yaml")}         ${cfg.files.yamlPath}\n`);
  process.stdout.write(`  ${dim("server_setup")} ${cfg.files.serverSetupPath}\n`);
  if (cfg.files.blockCount !== undefined) {
    process.stdout.write(`  ${dim("blockCount")}   ${cfg.files.blockCount}\n`);
  }
  if (cfg.files.maxContextLength !== undefined) {
    process.stdout.write(`  ${dim("maxContext")}   ${cfg.files.maxContextLength}\n`);
  }
  process.stdout.write("\n");
  for (const file of ["server_setup", "client"] as const) {
    const fields = cfg.fields.filter((f) => f.file === file);
    const label = file === "server_setup" ? "server_setup (llama.cpp boot flags)" : "client (live-synced)";
    process.stdout.write(`  ${heading(label)}\n`);
    for (const f of fields) {
      const current = f.current === null ? "(unset)" : String(f.current);
      const restart = f.restartRequired ? "  restart" : "";
      const hints = [f.hint, f.machineHint].filter(Boolean).join("; ");
      const hint = hints ? `  ${hints}` : "";
      process.stdout.write(`${option(false, f.field.padEnd(16), `${current}${restart}${hint}`)}\n`);
    }
    process.stdout.write("\n");
  }
}

async function guidedFlow(baseUrl: string, modelId: string, assumeNo: boolean): Promise<void> {
  let cfg = await serviceGet<ModelConfig>(
    baseUrl,
    `/models/config?id=${encodeURIComponent(modelId)}`,
  );
  printConfig(cfg);
  for (;;) {
    const picked = await pickFieldInteractive(cfg.fields);
    if (picked === null) {
      process.stdout.write(`[mba] done — ${modelId}\n`);
      return;
    }
    const current = picked.current === null ? "" : String(picked.current);
    const hints = [picked.hint, picked.machineHint].filter(Boolean).join("; ");
    const raw = await askValueInteractive(picked.field, current, hints);
    if (raw === null) {
      process.stdout.write("[mba] edit cancelled\n");
      continue;
    }
    if (raw === "") {
      process.stdout.write(`[mba] ${picked.field} unchanged — skipping\n`);
      continue;
    }
    const value = parseValue(raw);
    try {
      const result = await servicePost<SetResult>(baseUrl, "/models/config", {
        id: modelId,
        file: picked.file,
        field: picked.field,
        value,
      });
      process.stdout.write(
        `[mba] ${modelId} ${result.field}: ${String(result.before)} → ${String(result.after)}\n`,
      );
      await handleRestartPrompt(baseUrl, modelId, result, assumeNo);
      cfg = await serviceGet<ModelConfig>(
        baseUrl,
        `/models/config?id=${encodeURIComponent(modelId)}`,
      );
    } catch (err) {
      process.stdout.write(
        `[mba] ${picked.field} not saved: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
}

async function listModels(baseUrl: string): Promise<ModelEntry[]> {
  const { models } = await serviceGet<{ models: ModelEntry[] }>(baseUrl, "/models");
  return [...models];
}

function printModelList(models: readonly ModelEntry[]): void {
  for (const m of models) {
    const loaded = m.loaded ? "  [loaded]" : "";
    process.stdout.write(`${m.id}${m.family ? `  (${m.family})` : ""}${loaded}\n`);
  }
}

export async function cmdModelsList(baseUrl: string, json = false): Promise<void> {
  const models = await listModels(baseUrl);
  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        models.map((m) => ({ id: m.id, family: m.family, loaded: m.loaded })),
        null,
        2,
      )}\n`,
    );
    return;
  }
  if (models.length === 0) {
    process.stdout.write("[mba] no models in the adapter tree\n");
    return;
  }
  printModelList(models);
}

export async function cmdModelsPick(baseUrl: string, assumeNo: boolean): Promise<void> {
  const models = await listModels(baseUrl);
  if (models.length === 0) {
    process.stdout.write("[mba] no models in the adapter tree\n");
    return;
  }
  if (!process.stdin.isTTY) {
    printModelList(models);
    return;
  }
  const picked = await pickModelInteractive(models);
  if (picked === null) {
    process.stdout.write("[mba] cancelled\n");
    return;
  }
  await guidedFlow(baseUrl, picked.id, assumeNo);
}

export async function cmdModelsEdit(
  baseUrl: string,
  modelId: string | undefined,
  assumeNo: boolean,
): Promise<void> {
  if (!modelId) fail("usage: mba models <id>");
  await guidedFlow(baseUrl, modelId, assumeNo);
}

export async function cmdModelsShow(
  baseUrl: string,
  modelId: string | undefined,
  json = false,
): Promise<void> {
  if (!modelId) fail("usage: mba models show <model>");
  const cfg = await serviceGet<ModelConfig>(
    baseUrl,
    `/models/config?id=${encodeURIComponent(modelId)}`,
  );
  if (json) {
    process.stdout.write(`${JSON.stringify(cfg, null, 2)}\n`);
    return;
  }
  printConfig(cfg);
}

export async function cmdModelsSet(
  baseUrl: string,
  modelId: string | undefined,
  field: string | undefined,
  rawValue: string | undefined,
  assumeNo: boolean,
): Promise<void> {
  if (!modelId || !field || rawValue === undefined) {
    fail("usage: mba models set <model> <field> <value> [--yes]");
  }
  const cfg = await serviceGet<ModelConfig>(
    baseUrl,
    `/models/config?id=${encodeURIComponent(modelId)}`,
  );
  const spec = cfg.fields.find((f) => f.field === field);
  if (!spec) {
    const known = cfg.fields.map((f) => f.field).join(", ");
    fail(`unknown field '${field}' for ${modelId} — known fields: ${known}`);
  }
  const value = parseValue(rawValue);
  const result = await servicePost<SetResult>(baseUrl, "/models/config", {
    id: modelId,
    file: spec.file,
    field,
    value,
  });
  process.stdout.write(
    `[mba] ${modelId} ${result.field}: ${String(result.before)} → ${String(result.after)}\n`,
  );
  await handleRestartPrompt(baseUrl, modelId, result, assumeNo);
}

export async function cmdModelsOpen(
  baseUrl: string,
  modelId: string | undefined,
  file: string | undefined,
): Promise<void> {
  if (!modelId || !file) fail("usage: mba models open <model> <file>");
  const cfg = await serviceGet<ModelConfig>(
    baseUrl,
    `/models/config?id=${encodeURIComponent(modelId)}`,
  );
  const path =
    file === "server_setup" || file === "server_setup.json"
      ? cfg.files.serverSetupPath
      : file === "yaml" || file === "adapter"
        ? cfg.files.yamlPath
        : null;
  if (!path) {
    fail(`unknown file '${file}' — use 'server_setup' or 'yaml'`);
  }
  process.stdout.write(path + "\n");
}

interface PullResult {
  readonly id: string;
  readonly family: string;
  readonly sha256: string;
  readonly resumed: boolean;
  readonly modelDir: string;
  readonly adapterPath: string;
  readonly familyCreated: boolean;
}

export async function cmdModelsPull(
  baseUrl: string,
  url: string,
  id: string,
  sha256: string | undefined,
  family: string | undefined,
): Promise<void> {
  const body: Record<string, string> = { url, id };
  if (sha256) body.sha256 = sha256;
  if (family) body.family = family;

  process.stdout.write(`[mba] pulling model ${id}...\n`);

  try {
    const result = await servicePostSse<PullResult>(baseUrl, "/models/pull", body);
    process.stdout.write(
      doneBox("PULLED", [
        ["id", result.resumed ? `${result.id} · resumed` : result.id],
        ["family", result.familyCreated ? `${result.family} · new` : result.family],
        ["next", `mba s boot ${result.id}`],
      ]) + "\n",
    );
    process.stdout.write(`${dim(`  ${shortenHome(result.modelDir)}`)}\n`);
  } catch (error) {
    process.stderr.write(`[mba] error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

function deriveModelId(repo: string): string {
  return (
    repo
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "model"
  );
}

function deriveFamily(owner: string): string {
  return (
    owner
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "unknown"
  );
}

export async function cmdModelsSearch(baseUrl: string): Promise<void> {
  const repoId = await searchHfInteractive((q) => searchHfModels(q));
  if (repoId === null) {
    process.stdout.write("[mba] cancelled\n");
    return;
  }
  const slash = repoId.indexOf("/");
  if (slash <= 0) {
    process.stderr.write(`[mba] error: unexpected repo id '${repoId}'\n`);
    process.exit(1);
  }
  const owner = repoId.slice(0, slash);
  const repo = repoId.slice(slash + 1);

  const { ref, files: ggufs } = await listHfGgufs(owner, repo);
  if (ggufs.length === 0) {
    process.stderr.write(`[mba] error: no GGUF files found in ${owner}/${repo}\n`);
    process.exit(1);
  }

  const formatSize = (n: number): string =>
    n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`;
  const quant = await pickLabeledInteractive(
    `pick a quant for ${owner}/${repo}`,
    ggufs.map((f) => ({
      label: f.size !== undefined ? `${f.path} (${formatSize(f.size)})` : f.path,
      value: f.path,
    })),
  );
  if (quant === null) {
    process.stdout.write("[mba] cancelled\n");
    return;
  }

  const id = await askTextInteractive("model id", deriveModelId(repo));
  if (id === null) {
    process.stdout.write("[mba] cancelled\n");
    return;
  }
  const family = await askTextInteractive("family", deriveFamily(owner));
  if (family === null) {
    process.stdout.write("[mba] cancelled\n");
    return;
  }

  const picked = ggufs.find((f) => f.path === quant);
  const url = `https://huggingface.co/${owner}/${repo}/resolve/${ref}/${quant}`;
  await cmdModelsPull(baseUrl, url, id, picked?.sha256, family);
}

const PULL_USAGE =
  "usage: mba models pull <url|owner/repo[:file-or-quant]> --id <id> [--sha256 <digest>] [--family <family>]";

export async function dispatchModelsPull(
  baseUrl: string,
  args: readonly string[],
): Promise<void> {
  const [url, ...flagArgs] = args;
  if (url === "search" || (!url && process.stdin.isTTY)) {
    await cmdModelsSearch(baseUrl);
    return;
  }
  let id: string | undefined;
  let sha256: string | undefined;
  let family: string | undefined;
  for (let i = 0; i < flagArgs.length; i++) {
    const a = flagArgs[i];
    if (a === "--id") id = flagArgs[++i];
    else if (a === "--sha256") sha256 = flagArgs[++i];
    else if (a === "--family") family = flagArgs[++i];
    else fail(`unknown flag for pull: ${a}\n${PULL_USAGE}`);
  }
  if (!url || !id) fail(PULL_USAGE);
  await cmdModelsPull(baseUrl, url, id, sha256, family);
}
