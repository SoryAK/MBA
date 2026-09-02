#!/usr/bin/env node
/**
 * `mba` — interactive config CLI for the model plane (ADR-0096).
 *
 * The CLI is a thin door over the MBA service: it never touches the adapter
 * files itself. Reads go to GET /models and GET /models/config; writes go to
 * POST /models/config. The service stays the single writer.
 *
 * Commands:
 *   mba models                 — guided flow on a TTY: pick a model → view
 *                                dials → pick a field → type a value → save →
 *                                loop back to the field menu (q/Esc quits).
 *                                Plain list on a non-TTY.
 *   mba config <model>         — show every dial with its current value
 *                                (read-only snapshot)
 *   mba set <model> <field> <value>
 *                              — set one dial (plain form). Value is parsed
 *                                as JSON when possible, else a string.
 *   mba open <model> <file>    — escape hatch: print the on-disk path of the
 *                                model's server_setup.json or adapter yaml
 *                                (edit by hand, at your own risk)
 *
 * Restart semantics: the service reports { restartRequired, modelLoaded }
 * but never restarts. The CLI owns the user decision:
 *   - restartRequired && modelLoaded  → y/N prompt, then an in-daemon restart
 *     (stop the model's current server, then POST /servers/boot on the switch
 *     port — MBA_SWITCH_PORT, default 8080). The daemon owns the server
 *     lifecycle (ADR-0092); the retired C-Yard boot script is no longer used.
 *   - restartRequired && !modelLoaded → "saved — takes effect on next boot"
 *   - !restartRequired                → "saved — synced live, no restart needed"
 *
 * `--yes` (or a non-TTY stdin) skips the restart prompt and does NOT restart.
 *
 * Exit codes: 0 = ok, 2 = usage/service error (message on stderr).
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  askPortInteractive,
  askTextInteractive,
  askValueInteractive,
  pickFieldInteractive,
  pickLabeledInteractive,
  pickModelInteractive,
  pickServerInteractive,
  searchHfInteractive,
  type ModelDial,
  type ModelEntry,
} from "./interactive.js";
import { listHfGgufs, searchHfModels } from "../model/hf-resolve.js";
import { selectRestartTargets } from "./restart-selection.js";
import {
  defaultModelStoreRoot,
  defaultStateDir,
  ensureDir,
  executeMigration,
  legacyModelStoreRoot,
  legacyStateDir,
} from "../service/paths.js";

// --- Service discovery (mirrors mcp-server's service-client) ---------------

interface ServiceInfo {
  readonly port: number;
}

function resolveServiceUrl(): string | null {
  const envUrl = process.env.MBA_SERVICE_URL ?? process.env.CYARD_MBA_SERVICE_URL;
  if (envUrl && envUrl.length > 0) return envUrl;
  const infoPath = join(defaultStateDir(), "mba", "service.json");
  if (!existsSync(infoPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(infoPath, "utf8")) as unknown;
    if (typeof raw !== "object" || raw === null) return null;
    const port = (raw as Record<string, unknown>).port;
    if (typeof port !== "number" || !Number.isInteger(port)) return null;
    return `http://127.0.0.1:${port}`;
  } catch {
    return null;
  }
}

function fail(message: string): never {
  process.stderr.write(`[mba] ${message}\n`);
  process.exit(2);
}

async function serviceGet<T>(baseUrl: string, path: string): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`service error: HTTP ${res.status} ${body}`.trim());
  }
  return (await res.json()) as T;
}

async function servicePost<T>(baseUrl: string, path: string, body: unknown): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`service error: HTTP ${res.status} ${text}`.trim());
  }
  return (await res.json()) as T;
}

/** Human-readable byte count (B / KiB / MiB / GiB). */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = n;
  let i = -1;
  do {
    value /= 1024;
    i++;
  } while (value >= 1024 && i < units.length - 1);
  return `${value.toFixed(1)} ${units[i]}`;
}

/**
 * POST to an SSE endpoint and render download progress live. The daemon
 * streams `progress` events while bytes arrive, then a terminal `done`
 * (result) or `error` event. Progress is re-rendered on the same line (\r)
 * and throttled to ~10/s so a fast download does not spam the terminal.
 * Resolves with the `done` payload; throws on an `error` event or a
 * non-SSE (plain JSON) error response.
 */
async function servicePostSse<T>(
  baseUrl: string,
  path: string,
  body: unknown,
): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new Error(`service error: HTTP ${res.status} ${text}`.trim());
  }
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    // A pre-stream failure returned plain JSON with a status code.
    const text = await res.text().catch(() => "");
    let message = text;
    try {
      const parsed = JSON.parse(text) as { error?: unknown };
      if (typeof parsed.error === "string") message = parsed.error;
    } catch {
      // keep raw text
    }
    throw new Error(message.trim() || `service error: HTTP ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let lastRender = 0;

  const renderProgress = (downloaded: number, total: number | null, force: boolean): void => {
    const now = Date.now();
    if (!force && now - lastRender < 100) return;
    lastRender = now;
    const line =
      total !== null && total > 0
        ? `[mba] downloading ${formatBytes(downloaded)} / ${formatBytes(total)} (${Math.round((downloaded / total) * 100)}%)`
        : `[mba] downloading ${formatBytes(downloaded)}`;
    process.stdout.write(`\r\x1b[K${line}`);
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE frames are separated by a blank line; each `data:` line is one
    // JSON event. Process every complete frame, keep the trailing partial.
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const dataLine = frame
        .split("\n")
        .find((l) => l.startsWith("data:"));
      if (!dataLine) continue;
      let event: { type: string; downloaded?: number; total?: number | null; result?: T; message?: string };
      try {
        event = JSON.parse(dataLine.slice(5).trim());
      } catch {
        continue;
      }
      if (event.type === "progress") {
        renderProgress(event.downloaded ?? 0, event.total ?? null, false);
      } else if (event.type === "done") {
        process.stdout.write("\r\x1b[K"); // clear the progress line
        return event.result as T;
      } else if (event.type === "error") {
        process.stdout.write("\r\x1b[K");
        throw new Error(event.message ?? "pull failed");
      }
    }
  }
  throw new Error("pull stream ended without a result");
}

// --- Shared types (mirror the service's model-config surface) --------------
// (ModelEntry and ModelDial live in interactive.ts — the raw-mode input
// primitives consume them directly.)

interface ModelConfig {
  readonly modelId: string;
  readonly files: {
    readonly yamlPath: string;
    readonly serverSetupPath: string;
    readonly envSetupPaths: string[];
    readonly blockCount?: number;
    readonly maxContextLength?: number;
    /** Absolute path to the model's GGUF (from the catalog) — what llama.cpp loads. */
    readonly modelFile?: string;
  };
  readonly fields: ModelDial[];
}

interface SetResult {
  readonly file: string;
  readonly field: string;
  readonly before: unknown;
  readonly after: unknown;
  readonly restartRequired: boolean;
  /** Absolute path to the model's GGUF — lets the reboot use the exact file. */
  readonly modelFile?: string;
  readonly modelLoaded: boolean;
}

/** One row of GET /servers (the server plane, ADR-0097 Phase 2). */
interface ServerEntry {
  readonly id: string;
  readonly serverType: string;
  readonly modelFile: string;
  readonly port: number;
  /** Absent for daemon-backed types (e.g. ollama) that have no per-model process. */
  readonly pid?: number;
  readonly startedAt: string;
  readonly healthy: boolean;
  readonly resolved: boolean;
  /** True when another registered entry serves the same model (Q2 label). */
  readonly duplicate?: boolean;
}

interface BootResult {
  readonly id: string;
  readonly serverType: string;
  readonly modelFile: string;
  readonly port: number;
  /** Absent for daemon-backed types (e.g. ollama) that have no per-model process. */
  readonly pid?: number;
  readonly startedAt: string;
}

// --- Value parsing for the plain form ---------------------------------------

/** Parse a CLI value: JSON when it parses, else a plain string. */
function parseValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

// --- Restart prompt ----------------------------------------------------------

/**
 * In-daemon restart: stop the current server for this model (if any), then
 * boot it fresh on the switch port. Replaces the retired C-Yard boot-script
 * shell-out — the daemon now owns the server lifecycle (ADR-0092).
 */
async function restartServer(
  baseUrl: string,
  modelId: string,
  modelFile: string | undefined,
  port: number,
): Promise<void> {
  const file =
    modelFile && modelFile.length > 0 ? modelFile : await resolveModelFile(baseUrl, modelId);
  // Free the port: stop EVERY server running this model before re-booting.
  // A model can be served by more than one registered server (duplicate
  // boots); stopping only the first would leave a duplicate holding the model.
  const { servers } = await serviceGet<{ servers: ServerEntry[] }>(baseUrl, "/servers");
  const interactive = process.stdin.isTTY === true;
  const { targets, prompt } = selectRestartTargets(servers, file, interactive);
  if (targets.length > 0) {
    if (prompt) {
      const stopAll = await askYesNo(
        `${targets.length} servers are running this model — stop all of them?`,
      );
      if (!stopAll) {
        process.stdout.write(
          `[mba] not stopping the other ${targets.length - 1} server(s); ` +
            `the reboot may fail if the port is still held. Stop them with 'mba servers stop <id>'.\n`,
        );
        return;
      }
    }
    for (const target of targets) {
      process.stdout.write(`[mba] stopping server ${target.id}\n`);
      await servicePost<{ stopped: string }>(baseUrl, "/servers/stop", { id: target.id });
    }
  }
  process.stdout.write(`[mba] rebooting ${modelId} on port ${port} (waits for warmup)…\n`);
  const entry = await servicePost<BootResult>(baseUrl, "/servers/boot", { modelFile: file, port });
  process.stdout.write(`[mba] booted ${entry.id} (pid ${entry.pid}) on port ${entry.port}\n`);
}

function askYesNo(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<boolean>((resolve) => {
    rl.question(`${question} [y/N] `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes");
    });
  });
}

/**
 * Post-write restart flow. `assumeNo` (from --yes or non-TTY) never restarts.
 * A restart now goes through the in-daemon boot (stop + boot), not the retired
 * C-Yard boot script.
 */
async function handleRestartPrompt(
  baseUrl: string,
  modelId: string,
  result: SetResult,
  assumeNo: boolean,
): Promise<void> {
  if (!result.restartRequired) {
    process.stdout.write("[mba] saved — synced live, no restart needed\n");
    return;
  }
  if (!result.modelLoaded) {
    process.stdout.write("[mba] saved — takes effect on next boot (model not currently loaded)\n");
    return;
  }
  const port = Number(process.env.MBA_SWITCH_PORT ?? 8080);
  const hint = `mba servers boot ${modelId} ${port}`;
  if (assumeNo) {
    process.stdout.write(`[mba] saved — restart required. Reboot with: ${hint}\n`);
    return;
  }
  const yes = await askYesNo(`Restart ${modelId} now to apply?`);
  if (!yes) {
    process.stdout.write(`[mba] saved — restart required. Reboot with: ${hint}\n`);
    return;
  }
  await restartServer(baseUrl, modelId, result.modelFile, port);
  process.stdout.write("[mba] reboot complete\n");
}

// --- Guided flow (mba models on a TTY) ---------------------------------------

function printConfig(cfg: ModelConfig): void {
  process.stdout.write(`mba config — ${cfg.modelId}\n`);
  process.stdout.write(`  yaml:         ${cfg.files.yamlPath}\n`);
  process.stdout.write(`  server_setup: ${cfg.files.serverSetupPath}\n`);
  if (cfg.files.blockCount !== undefined) {
    process.stdout.write(`  blockCount:   ${cfg.files.blockCount}\n`);
  }
  if (cfg.files.maxContextLength !== undefined) {
    process.stdout.write(`  maxContext:   ${cfg.files.maxContextLength}\n`);
  }
  process.stdout.write("\n");
  for (const file of ["server_setup", "client"] as const) {
    const fields = cfg.fields.filter((f) => f.file === file);
    const label = file === "server_setup" ? "server_setup (llama.cpp boot flags)" : "client (live-synced)";
    process.stdout.write(`  ${label}:\n`);
    for (const f of fields) {
      const current = f.current === null ? "(unset)" : String(f.current);
      const restart = f.restartRequired ? "  [restart]" : "";
      const hint = f.hint ? `  (${f.hint})` : "";
      process.stdout.write(`    ${f.field.padEnd(16)} ${current}${restart}${hint}\n`);
    }
    process.stdout.write("\n");
  }
}

/**
 * The guided loop: show dials → pick field → type value → save → repeat.
 * Exits when the user quits the field menu (q/Esc) or cancels a value prompt
 * twice in a row is NOT special — a single Esc just returns to the field menu.
 */
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
    const raw = await askValueInteractive(picked.field, current, picked.hint);
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
      // Refresh dials so the menu shows the new values.
      cfg = await serviceGet<ModelConfig>(
        baseUrl,
        `/models/config?id=${encodeURIComponent(modelId)}`,
      );
    } catch (err) {
      // A failed write (bad value, service hiccup) must not kill the
      // session — report it and go back to the field menu.
      process.stdout.write(
        `[mba] ${picked.field} not saved: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      continue;
    }
  }
}

// --- Commands ----------------------------------------------------------------

async function cmdModels(baseUrl: string, assumeNo: boolean): Promise<void> {
  const { models } = await serviceGet<{ models: ModelEntry[] }>(baseUrl, "/models");
  if (models.length === 0) {
    process.stdout.write("[mba] no models in the adapter tree\n");
    return;
  }
  if (!process.stdin.isTTY) {
    for (const m of models) {
      const loaded = m.loaded ? "  [loaded]" : "";
      process.stdout.write(`${m.id}${m.family ? `  (${m.family})` : ""}${loaded}\n`);
    }
    return;
  }
  const picked = await pickModelInteractive(models);
  process.stdout.write(`[mba] selected: ${picked.id}\n\n`);
  await guidedFlow(baseUrl, picked.id, assumeNo);
}

async function cmdConfig(baseUrl: string, modelId: string): Promise<void> {
  const cfg = await serviceGet<ModelConfig>(
    baseUrl,
    `/models/config?id=${encodeURIComponent(modelId)}`,
  );
  printConfig(cfg);
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

async function cmdPull(
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
      `[mba] pulled ${result.id} (family: ${result.family})${result.resumed ? " [resumed]" : ""}\n`,
    );
    process.stdout.write(`[mba]   weights:  ${result.modelDir}\n`);
    process.stdout.write(`[mba]   adapter:  ${result.adapterPath}\n`);
    if (result.familyCreated) {
      process.stdout.write("[mba]   family tier scaffolded (family.yaml + empty bindings)\n");
    }
    process.stdout.write("[mba] fill in the TODO fields in the adapter yaml, then boot the model\n");
  } catch (error) {
    process.stderr.write(`[mba] error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

/** Derive a default model id from a repo name: `Qwen3-Coder-30B` → `qwen3-coder-30b`. */
function deriveModelId(repo: string): string {
  return (
    repo
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "model"
  );
}

/** Derive a default family from a repo owner: `Qwen` → `qwen`. */
function deriveFamily(owner: string): string {
  return (
    owner
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "unknown"
  );
}

/**
 * Interactive `mba pull search` flow:
 *   1. search HuggingFace → pick a repo
 *   2. list the repo's GGUFs → pick a quant
 *   3. confirm/edit the derived id + family
 * then falls through to the existing pull path.
 */
async function cmdPullSearch(baseUrl: string): Promise<void> {
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

  // Build a full resolve URL pinned to the ref we already fetched, and pass the
  // file's sha256. Together these short-circuit resolveHfSource in the pull
  // path, so the repo tree is not fetched a second time.
  const picked = ggufs.find((f) => f.path === quant);
  const url = `https://huggingface.co/${owner}/${repo}/resolve/${ref}/${quant}`;
  await cmdPull(baseUrl, url, id, picked?.sha256, family);
}

async function cmdSet(
  baseUrl: string,
  modelId: string,
  field: string,
  rawValue: string,
  assumeNo: boolean,
): Promise<void> {
  // Resolve which file the field lives in via the service (the CLI never
  // hardcodes the field table — the service is the source of truth).
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

async function cmdOpen(baseUrl: string, modelId: string, file: string): Promise<void> {
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

// --- Server plane (ADR-0097 Phase 2) ----------------------------------------

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

/**
 * List registered servers. On a TTY (without --plain) this is interactive:
 * pick a server (arrow keys + type to filter), then choose an action
 * (currently: stop). Non-TTY or --plain prints the plain table so the
 * command stays scriptable.
 */
async function cmdServersList(baseUrl: string, plain: boolean): Promise<void> {
  const { servers } = await serviceGet<{ servers: ServerEntry[] }>(baseUrl, "/servers");
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
    process.stdout.write("[mba] cancelled\n");
    return;
  }
  if (sel.action === "stop") {
    await cmdServersStop(baseUrl, sel.server.id);
  } else if (sel.action === "logs") {
    // Option (a): the picker's "logs" action drops straight into the live tail.
    await cmdServersLogs(baseUrl, sel.server.id, undefined, true);
  }
}

/**
 * Resolve a model reference to an absolute GGUF path. An absolute path is
 * used verbatim; otherwise it is treated as a model id and resolved via
 * GET /models (the service is the source of truth for the file path).
 */
async function resolveModelFile(baseUrl: string, ref: string): Promise<string> {
  if (ref.startsWith("/") && ref.endsWith(".gguf")) return ref;
  const { models } = await serviceGet<{ models: { id: string; modelFile?: string }[] }>(
    baseUrl,
    "/models",
  );
  const match = models.find((m) => m.id === ref);
  if (!match || !match.modelFile) {
    fail(`unknown model '${ref}' — see 'mba models' for known ids`);
  }
  return match.modelFile;
}

/**
 * Interactive boot flow: pick a model from the catalog (arrow keys + type to
 * filter), then pick a port (Enter keeps the default). Esc at either step
 * cancels.
 */
async function interactiveBoot(
  baseUrl: string,
  serverType: "llama.cpp" | "ollama",
): Promise<void> {
  const { models } = await serviceGet<{ models: ModelEntry[] }>(baseUrl, "/models");
  if (models.length === 0) {
    process.stdout.write("[mba] no models in the adapter tree\n");
    return;
  }
  const picked = await pickModelInteractive(models);
  const defaultPort = Number(process.env.MBA_SWITCH_PORT ?? 8080);
  const port = await askPortInteractive(defaultPort);
  if (port === null) {
    process.stdout.write("[mba] cancelled\n");
    return;
  }

  // llama.cpp: preview the resolved flags BEFORE booting. The boot call blocks
  // until warmup, so the user needs to see the command that's about to run —
  // especially the server_setup.json dials (incl. extraArgs) — and confirm.
  // The daemon resolves via the exact chain the boot uses, so the printed
  // flags are provably the bytes that get spawned.
  if (serverType === "llama.cpp") {
    const modelFile = await resolveModelFile(baseUrl, picked.id);
    let cliArgs: string[];
    try {
      const recipe = await servicePost<{ cliArgs: string[] }>(baseUrl, "/servers/resolve", {
        modelFile,
      });
      cliArgs = recipe.cliArgs;
    } catch {
      // Preview is best-effort: if resolution fails here, the boot will fail
      // with the same error and a clearer message. Don't block on the preview.
      process.stdout.write("[mba] could not preview flags — proceeding to boot\n");
      await cmdServersBoot(baseUrl, picked.id, port, serverType);
      return;
    }
    process.stdout.write(`[mba] resolved flags for ${picked.id}:\n`);
    for (const arg of cliArgs) process.stdout.write(`  ${arg}\n`);
    if (process.stdin.isTTY) {
      const proceed = await askYesNo("Boot with these flags?");
      if (!proceed) {
        process.stdout.write("[mba] cancelled\n");
        return;
      }
    }
  }

  await cmdServersBoot(baseUrl, picked.id, port, serverType);
}

async function cmdServersBoot(
  baseUrl: string,
  modelRef: string,
  port: number,
  serverType: "llama.cpp" | "ollama",
): Promise<void> {
  if (serverType === "ollama") {
    process.stdout.write(`[mba] loading ${modelRef} into ollama (waits for load)…\n`);
    const entry = await servicePost<BootResult>(baseUrl, "/servers/boot", {
      serverType: "ollama",
      modelRef,
      port,
    });
    process.stdout.write(`[mba] booted ${entry.id} on port ${entry.port}\n`);
    return;
  }
  const modelFile = await resolveModelFile(baseUrl, modelRef);
  process.stdout.write(`[mba] booting ${modelFile} on port ${port} (waits for warmup)…\n`);
  const entry = await servicePost<BootResult>(baseUrl, "/servers/boot", {
    modelFile,
    port,
  });
  process.stdout.write(
    `[mba] booted ${entry.id} (pid ${entry.pid}) on port ${entry.port}\n`,
  );
}

async function cmdServersStop(baseUrl: string, id: string): Promise<void> {
  await servicePost<{ stopped: string }>(baseUrl, "/servers/stop", { id });
  process.stdout.write(`[mba] stopped ${id}\n`);
}

/**
 * Show a server's captured log lines (Feature 2). The daemon pipes each owned
 * llama-server's stdout/stderr into a per-port ring buffer; this reads it via
 * GET /servers/logs. `--lines N` shows the last N (all when omitted).
 * `--follow` polls the route every 2s and prints only new lines (Ctrl-C stops)
 * — a live tail, not SSE/WebSocket. API-managed servers (ollama) have no owned
 * process, so their buffer is empty.
 */
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

  // Live tail: poll every 2s, print only lines we haven't shown yet. We track
  // how many lines we've printed and emit the forward tail each poll. The ring
  // buffer is bounded, so under heavy output it can evict old lines and shrink
  // below `printed` — when that happens we've lost the tail's anchor, so we
  // re-anchor to the current length (no re-print; a few evicted lines are
  // dropped, which is the correct behaviour for a bounded tail). A server that
  // stops mid-follow yields a 404 — we stop cleanly rather than erroring.
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
      // Buffer evicted below our anchor — re-anchor, drop the evicted lines.
      printed = body.lines.length;
    } else {
      const fresh = body.lines.slice(printed);
      for (const line of fresh) process.stdout.write(`${line}\n`);
      printed = body.lines.length;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

async function cmdServers(baseUrl: string, rest: readonly string[]): Promise<void> {
  const [sub, ...args] = rest;
  switch (sub) {
    case "list": {
      const plain = args.includes("--plain");
      await cmdServersList(baseUrl, plain);
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
          fail("usage: mba servers boot <model|path.gguf|tag> <port> [--type ollama]");
        }
        serverType = typeVal;
      }
      const [modelRef, portRaw] = positionalArgs;
      const port = Number(portRaw);
      if (!modelRef || !portRaw || !Number.isInteger(port) || port <= 0 || port > 65535) {
        // No args on a TTY → interactive flow (pick model, pick port). Ollama
        // has no catalog to pick from, so it always needs an explicit tag.
        if (process.stdin.isTTY && positionalArgs.length === 0 && serverType === "llama.cpp") {
          await interactiveBoot(baseUrl, serverType);
          return;
        }
        fail("usage: mba servers boot <model|path.gguf|tag> <port> [--type ollama]");
      }
      await cmdServersBoot(baseUrl, modelRef, port, serverType);
      return;
    }
    case "stop": {
      const [id] = args;
      if (!id) {
        fail("usage: mba servers stop <id>");
      }
      await cmdServersStop(baseUrl, id);
      return;
    }
    case "logs": {
      // mba servers logs <id> [--lines N] [--follow]
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
      const [id] = positional;
      if (!id) {
        fail("usage: mba servers logs <id> [--lines N] [--follow]");
      }
      await cmdServersLogs(baseUrl, id, lines, follow);
      return;
    }
    default:
      fail("usage: mba servers <list|boot|stop|logs>\n  list [--plain]       list registered servers (interactive on a TTY; --plain forces the table)\n  boot <ref> <port>    boot a model server (waits for warmup) [--type ollama]\n  stop <id>            stop a registered server (by id)\n  logs <id>            show a server's captured log lines [--lines N] [--follow]");
  }
}

// --- Path migration (ADR-0097 Phase 4) ---------------------------------------

/**
 * Probe a directory: does it exist, and if so is it empty? These two facts
 * drive the migration decision (see planMigration in service/paths.ts).
 */
function probeDir(dir: string): { exists: boolean; empty: boolean } {
  const exists = existsSync(dir);
  const empty = exists && readdirSync(dir).length === 0;
  return { exists, empty };
}

/**
 * `mba migrate-paths` — one-time move of MBA's two homes from the legacy
 * hardcoded locations to the OS-aware ones. Local filesystem only: it does
 * NOT talk to the service, so it works even while the service is stopped.
 *
 * For each home (state, then store): if the legacy source exists and the new
 * destination is absent or empty, move it (rename when same-device, copy
 * otherwise). A non-empty destination is refused — we never clobber data.
 * Idempotent: a second run finds no source and reports nothing to move.
 */
function cmdMigratePaths(): void {
  const homes: ReadonlyArray<{ label: string; from: string; to: string }> = [
    { label: "state", from: legacyStateDir(), to: defaultStateDir() },
    { label: "store", from: legacyModelStoreRoot(), to: defaultModelStoreRoot() },
  ];
  let moved = 0;
  for (const home of homes) {
    const src = probeDir(home.from);
    const dst = probeDir(home.to);
    const result = executeMigration(home.from, home.to, src.exists, dst.exists, dst.empty);
    switch (result.status) {
      case "moved":
        moved += 1;
        process.stdout.write(`[mba] ${home.label}: moved ${home.from} → ${home.to}\n`);
        break;
      case "skipped-missing-source":
        process.stdout.write(`[mba] ${home.label}: nothing to move (no ${home.from})\n`);
        break;
      case "skipped-destination-exists":
        process.stdout.write(
          `[mba] ${home.label}: SKIPPED — ${home.to} already has data; not overwriting. ` +
            `Move or merge ${home.from} by hand if you need it.\n`,
        );
        break;
    }
  }
  // Guarantee the new homes exist even when there was nothing to move (fresh
  // install), so the service has a ready-to-use location on next boot.
  ensureDir(defaultStateDir());
  ensureDir(defaultModelStoreRoot());
  process.stdout.write(
    `[mba] migrate-paths done — ${moved} home(s) moved. ` +
      `State: ${defaultStateDir()}\n[mba] Store: ${defaultModelStoreRoot()}\n`,
  );
}

// --- Entry point ---------------------------------------------------------------

const USAGE = `mba — model config CLI (talks to the MBA service)

Usage:
  mba models                       guided flow: pick a model → view dials →
                                   edit fields (loops until you quit)
  mba config <model>               show every dial with its current value
  mba set <model> <field> <value>  set one dial (value parsed as JSON when possible)
  mba open <model> <file>          print the on-disk path (server_setup | yaml)
  mba servers list [--plain]       list registered model servers (interactive
                                   on a TTY: pick a server, then stop or tail
                                   its logs; --plain forces the table)
  mba servers boot <ref> <port>    boot a model server in-daemon (waits for warmup)
                                   [--type ollama] boots an ollama model tag
  mba servers boot                 interactive: pick a model (arrow keys + type
                                   to filter), then a port (Enter keeps default)
  mba servers stop <id>            stop a registered server (by id)
  mba servers logs <id>            show a server's captured log lines
                                   [--lines N] last N lines (default: all)
                                   [--follow] live tail (polls every 2s, Ctrl-C stops)
  mba pull <url|owner/repo[:file-or-quant]> --id <id>
                                   [--sha256 <digest>] [--family <family>]
                                   one-command model onboarding (ADR-0098):
                                   download (resume + sha256 verify) → parse
                                   GGUF header → scaffold the two-tier binding
                                   structure with a TODO-marked draft adapter.
                                   HuggingFace shorthand (owner/repo[:Q4_K_M])
                                   auto-resolves the URL + sha256 (ADR-0099);
                                   other hosts need --sha256
  mba pull search                  interactive: search HuggingFace → pick a
                                   repo → pick a quant → confirm the derived
                                   id/family → pull (bare mba pull on a TTY
                                   does the same)
  mba migrate-paths                one-time move of state + model store from the
                                   legacy locations to the OS-aware ones (local
                                   only — does not need the service running)
  mba ... --yes                    skip the restart prompt (never restarts)

Environment:
  MBA_SERVICE_URL   explicit service base URL (default: <state dir>/mba/service.json)
  MBA_SWITCH_PORT   port for the in-daemon restart/boot (default: 8080)
  MBA_ADAPTER_DIR   override the model store root (default: OS-aware, see
                    'mba migrate-paths' / service/paths.ts)`;

async function main(argv: readonly string[]): Promise<void> {
  const args = [...argv];
  const assumeNo = args.includes("--yes");
  const positional = args.filter((a) => a !== "--yes");
  const [command, ...rest] = positional;

  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(USAGE + "\n");
    return;
  }

  // Local-only command: no service discovery needed. Handled before baseUrl so
  // it works while the service is stopped (which is exactly when you migrate).
  if (command === "migrate-paths") {
    cmdMigratePaths();
    return;
  }

  const baseUrl = resolveServiceUrl();
  if (!baseUrl) {
    fail(
      "MBA service not discovered — start it (npm run dev -w @mba-ai/core) or set MBA_SERVICE_URL",
    );
  }

  try {
    switch (command) {
      case "models":
        await cmdModels(baseUrl, assumeNo || !process.stdin.isTTY);
        break;
      case "config": {
        const [modelId] = rest;
        if (!modelId) fail("usage: mba config <model>");
        await cmdConfig(baseUrl, modelId);
        break;
      }
      case "set": {
        const [modelId, field, rawValue] = rest;
        if (!modelId || !field || rawValue === undefined) {
          fail("usage: mba set <model> <field> <value> [--yes]");
        }
        await cmdSet(baseUrl, modelId, field, rawValue, assumeNo || !process.stdin.isTTY);
        break;
      }
      case "open": {
        const [modelId, file] = rest;
        if (!modelId || !file) fail("usage: mba open <model> <file>");
        await cmdOpen(baseUrl, modelId, file);
        break;
      }
      case "servers":
        await cmdServers(baseUrl, rest);
        break;
      case "pull": {
        const [url, ...flagArgs] = rest;
        // `mba pull search` (or bare `mba pull` on a TTY) runs the interactive
        // HuggingFace search flow: search → pick repo → pick quant → confirm id.
        if (url === "search" || (!url && process.stdin.isTTY)) {
          await cmdPullSearch(baseUrl);
          break;
        }
        let id: string | undefined;
        let sha256: string | undefined;
        let family: string | undefined;
        for (let i = 0; i < flagArgs.length; i++) {
          const a = flagArgs[i];
          if (a === "--id") id = flagArgs[++i];
          else if (a === "--sha256") sha256 = flagArgs[++i];
          else if (a === "--family") family = flagArgs[++i];
          else fail(`unknown flag for pull: ${a}\nusage: mba pull <url|owner/repo[:file-or-quant]> --id <id> [--sha256 <digest>] [--family <family>]`);
        }
        if (!url || !id) {
          fail("usage: mba pull <url|owner/repo[:file-or-quant]> --id <id> [--sha256 <digest>] [--family <family>]");
        }
        await cmdPull(baseUrl, url, id, sha256, family);
        break;
      }
      default:
        fail(`unknown command: ${command}\n\n${USAGE}`);
    }
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

main(process.argv.slice(2)).catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
