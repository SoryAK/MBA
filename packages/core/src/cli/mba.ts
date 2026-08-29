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
  askValueInteractive,
  pickFieldInteractive,
  pickModelInteractive,
  type ModelDial,
  type ModelEntry,
} from "./interactive.js";
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
  const result = await servicePost<PullResult>(baseUrl, "/models/pull", body);
  process.stdout.write(
    `[mba] pulled ${result.id} (family: ${result.family})${result.resumed ? " [resumed]" : ""}\n`,
  );
  process.stdout.write(`[mba]   weights:  ${result.modelDir}\n`);
  process.stdout.write(`[mba]   adapter:  ${result.adapterPath}\n`);
  if (result.familyCreated) {
    process.stdout.write("[mba]   family tier scaffolded (family.yaml + empty bindings)\n");
  }
  process.stdout.write("[mba] fill in the TODO fields in the adapter yaml, then boot the model\n");
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

async function cmdServersList(baseUrl: string): Promise<void> {
  const { servers } = await serviceGet<{ servers: ServerEntry[] }>(baseUrl, "/servers");
  if (servers.length === 0) {
    process.stdout.write("[mba] no servers registered\n");
    return;
  }
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

async function cmdServers(baseUrl: string, rest: readonly string[]): Promise<void> {
  const [sub, ...args] = rest;
  switch (sub) {
    case "list":
      await cmdServersList(baseUrl);
      return;
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
    default:
      fail("usage: mba servers <list|boot|stop>\n  list                 list registered servers\n  boot <ref> <port>    boot a model server (waits for warmup) [--type ollama]\n  stop <id>            stop a registered server (by id)");
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
  mba servers list                 list registered model servers
  mba servers boot <ref> <port>    boot a model server in-daemon (waits for warmup)
                                   [--type ollama] boots an ollama model tag
  mba servers stop <id>            stop a registered server (by id)
  mba pull <url|owner/repo[:file-or-quant]> --id <id>
                                   [--sha256 <digest>] [--family <family>]
                                   one-command model onboarding (ADR-0098):
                                   download (resume + sha256 verify) → parse
                                   GGUF header → scaffold the two-tier binding
                                   structure with a TODO-marked draft adapter.
                                   HuggingFace shorthand (owner/repo[:Q4_K_M])
                                   auto-resolves the URL + sha256 (ADR-0099);
                                   other hosts need --sha256
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
