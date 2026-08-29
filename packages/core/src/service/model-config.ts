/**
 * Per-model dial config capability block (ADR-0096).
 *
 * The write door for per-model dials: the `llama.cpp` block of a model's
 * `server_setup.json` (boot flags — ctxSize, gpuLayers, …) and the adapter
 * YAML's `client:` block (endpoint sync — url, toolCalling, …).
 *
 * Design:
 *   - SMALL COMPOSABLE FUNCTIONS with explicit params and structured
 *     outputs — the route, the MCP tool, and the CLI all call into here.
 *   - FILES ARE TRUTH, ATOMIC WRITES (write-temp → rename), same discipline
 *     as `config-store.ts`. A corrupt file is surfaced, never clobbered.
 *   - ONE FIELD PER WRITE. `setModelDial` validates a single field against
 *     its spec (type, range, enum) and reports before/after.
 *   - RESTART AWARENESS. Every field spec carries `restartRequired`:
 *     server_setup fields are boot flags (the llama-server reads them once
 *     at startup), client fields are picked up live by the endpoint-sync
 *     watcher. Callers use the flag to offer a restart when the model is
 *     running on a live server.
 *
 * This module never spawns processes and never talks to the service — it
 * owns the "how" of the write; the route owns the "why/when".
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import YAML, { type YAMLMap } from "yaml";
import { readModelCatalog, type CatalogEntry } from "./model-catalog.js";

/** The two writable files per model. */
export type ModelDialFile = "server_setup" | "client";

/** Validation kinds for a dial field. */
type FieldKind = "positiveInt" | "int" | "bool" | "enum" | "string";

/** Spec for one editable dial field. */
export interface ModelDialFieldSpec {
  readonly field: string;
  readonly file: ModelDialFile;
  readonly kind: FieldKind;
  /** Allowed values when kind is "enum". */
  readonly enumValues?: readonly string[];
  /**
   * True when the value is a boot flag — it only takes effect when the
   * llama-server (re)starts. False when the endpoint-sync watcher picks it
   * up live.
   */
  readonly restartRequired: boolean;
}

/** A dial as presented to a reader (menu, route, tool). */
export interface ModelDial {
  readonly field: string;
  readonly file: ModelDialFile;
  readonly current: unknown;
  readonly restartRequired: boolean;
  /**
   * A short constraint hint for the reader (e.g. "≤ 262144", "1–65",
   * "on|off", "true|false", "> 0"). Undefined when the field has no
   * meaningful constraint to surface.
   */
  readonly hint?: string;
}

/** Result of a successful dial write. */
export interface ModelDialWriteResult {
  readonly ok: true;
  readonly file: ModelDialFile;
  readonly field: string;
  readonly before: unknown;
  readonly after: unknown;
  readonly restartRequired: boolean;
  /** Absolute path to the model's GGUF — lets the caller reboot with the exact file. */
  readonly modelFile?: string;
}

/** Result of a failed dial write (validation or I/O). */
export interface ModelDialError {
  readonly ok: false;
  readonly error: string;
}

export type SetModelDialResult = ModelDialWriteResult | ModelDialError;

/**
 * The known `llama.cpp` dials (server_setup.json). All are boot flags:
 * the llama-server reads them once at startup, so every one is
 * `restartRequired: true`.
 */
export const SERVER_SETUP_FIELDS: readonly ModelDialFieldSpec[] = [
  { field: "ctxSize", file: "server_setup", kind: "positiveInt", restartRequired: true },
  { field: "gpuLayers", file: "server_setup", kind: "int", restartRequired: true },
  { field: "threads", file: "server_setup", kind: "positiveInt", restartRequired: true },
  { field: "parallel", file: "server_setup", kind: "positiveInt", restartRequired: true },
  { field: "cacheReuse", file: "server_setup", kind: "int", restartRequired: true },
  { field: "cacheRam", file: "server_setup", kind: "int", restartRequired: true },
  { field: "specType", file: "server_setup", kind: "string", restartRequired: true },
  { field: "specDraftMax", file: "server_setup", kind: "positiveInt", restartRequired: true },
  { field: "reasoningBudget", file: "server_setup", kind: "int", restartRequired: true },
  { field: "flashAttn", file: "server_setup", kind: "enum", enumValues: ["on", "off"], restartRequired: true },
  { field: "warmupTokens", file: "server_setup", kind: "int", restartRequired: true },
] as const;

/**
 * The known `client:` block fields (adapter YAML). All are picked up live
 * by the endpoint-sync watcher — none require a restart.
 */
export const CLIENT_FIELDS: readonly ModelDialFieldSpec[] = [
  { field: "url", file: "client", kind: "string", restartRequired: false },
  { field: "contextSize", file: "client", kind: "positiveInt", restartRequired: false },
  { field: "maxOutputTokens", file: "client", kind: "positiveInt", restartRequired: false },
  { field: "toolCalling", file: "client", kind: "bool", restartRequired: false },
  { field: "vision", file: "client", kind: "bool", restartRequired: false },
] as const;

const ALL_FIELDS: readonly ModelDialFieldSpec[] = [...SERVER_SETUP_FIELDS, ...CLIENT_FIELDS];

/** Resolved on-disk locations for one model's writable config. */
export interface ModelConfigFiles {
  readonly modelId: string;
  readonly yamlPath: string;
  /** Absolute path to the model's GGUF (from the catalog) — what llama.cpp loads. */
  readonly modelFile?: string;
  /** Absolute path to the model's server_setup.json (from the binding). */
  readonly serverSetupPath: string;
  /** Env-override server_setup.json files under environments/ (read-only here). */
  readonly envSetupPaths: string[];
  /** Profile blockCount from the YAML (bounds gpuLayers), when declared. */
  readonly blockCount?: number;
  /** Profile maxContextLength from the YAML (ceiling for ctxSize), when declared. */
  readonly maxContextLength?: number;
}

function findField(file: ModelDialFile, field: string): ModelDialFieldSpec | undefined {
  return ALL_FIELDS.find((f) => f.file === file && f.field === field);
}

/**
 * Locate a model's writable config files. Returns null when the model id
 * is unknown or the adapter dir is missing.
 */
export function findModelFiles(adapterDir: string, modelId: string): ModelConfigFiles | null {
  const catalog = readModelCatalog(adapterDir);
  const entry: CatalogEntry | undefined = catalog.find((e) => e.id === modelId);
  if (!entry) return null;

  // Read the full YAML for the binding + profile (the catalog only carries
  // the four switch facts).
  const raw = YAML.parse(readFileSync(entry.yamlPath, "utf8")) as
    | Record<string, unknown>
    | null;
  if (!raw || typeof raw !== "object") return null;

  const modelDir = dirname(entry.yamlPath);

  // server_setup binding: `bindings.server_setup`, relative to the YAML.
  const bindings = raw.bindings as Record<string, unknown> | undefined;
  const setupRel = typeof bindings?.server_setup === "string" ? bindings.server_setup : null;
  const serverSetupPath = setupRel
    ? isAbsolute(setupRel)
      ? setupRel
      : resolve(modelDir, setupRel)
    : join(modelDir, "server_setup.json");

  // Env overrides: environments/*/server_setup.json (informational — the
  // CLI lists them; v1 edits only the model-level file).
  const envDir = join(modelDir, "environments");
  const envSetupPaths: string[] = [];
  if (existsSync(envDir) && statSync(envDir).isDirectory()) {
    for (const entryName of readdirSync(envDir, { withFileTypes: true })) {
      if (!entryName.isDirectory()) continue;
      const candidate = join(envDir, entryName.name, "server_setup.json");
      if (existsSync(candidate)) envSetupPaths.push(candidate);
    }
  }

  // Profile blockCount bounds gpuLayers (blockCount + 1 = all layers on GPU).
  const profile = (raw.identity as Record<string, unknown> | undefined)?.model as
    | Record<string, unknown>
    | undefined;
  const params = (profile?.profile as Record<string, unknown> | undefined)?.params as
    | Record<string, unknown>
    | undefined;
  const blockCount =
    typeof params?.blockCount === "number" && Number.isInteger(params.blockCount)
      ? params.blockCount
      : undefined;
  const maxContextLength =
    typeof params?.maxContextLength === "number" && Number.isInteger(params.maxContextLength)
      ? params.maxContextLength
      : undefined;

  return {
    modelId,
    yamlPath: entry.yamlPath,
    modelFile: entry.modelFile,
    serverSetupPath,
    envSetupPaths,
    blockCount,
    maxContextLength,
  };
}

/** Read the current values of every known dial for a model. */
export function readModelDials(
  adapterDir: string,
  modelId: string,
): { readonly modelId: string; readonly files: ModelConfigFiles; readonly fields: ModelDial[] } | null {
  const files = findModelFiles(adapterDir, modelId);
  if (!files) return null;

  const setup = readJsonOrNull(files.serverSetupPath) as
    | { "llama.cpp"?: Record<string, unknown> }
    | null;
  const setupBlock = setup?.["llama.cpp"] ?? {};

  const yamlRaw = YAML.parse(readFileSync(files.yamlPath, "utf8")) as
    | Record<string, unknown>
    | null;
  const clientBlock = (yamlRaw?.client as Record<string, unknown> | undefined) ?? {};

  const fields: ModelDial[] = ALL_FIELDS.map((spec) => ({
    field: spec.field,
    file: spec.file,
    current: spec.file === "server_setup" ? setupBlock[spec.field] ?? null : clientBlock[spec.field] ?? null,
    restartRequired: spec.restartRequired,
    hint: dialHint(spec, files),
  }));

  return { modelId, files, fields };
}

/**
 * Compute the constraint hint for a dial, from its spec kind plus the
 * profile ceilings (blockCount bounds gpuLayers, maxContextLength bounds
 * ctxSize). Returns undefined when there is nothing meaningful to show.
 */
function dialHint(spec: ModelDialFieldSpec, files: ModelConfigFiles): string | undefined {
  switch (spec.kind) {
    case "enum":
      return spec.enumValues?.join("|");
    case "bool":
      return "true|false";
    case "positiveInt":
      // ctxSize's meaningful constraint is the profile ceiling; without a
      // declared ceiling there is nothing specific to show.
      if (spec.field === "ctxSize") {
        return files.maxContextLength !== undefined ? `≤ ${files.maxContextLength}` : undefined;
      }
      return "> 0";
    case "int":
      // gpuLayers is bounded 1..blockCount+1 (blockCount + 1 = all on GPU) —
      // must match validateValue's upper bound.
      if (spec.field === "gpuLayers" && files.blockCount !== undefined) {
        return `1–${files.blockCount + 1}`;
      }
      return undefined;
    case "string":
      return undefined;
  }
}

function readJsonOrNull(path: string): unknown {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}

function atomicWriteText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, path);
}

/** Validate a value against a field spec. Returns an error string or null. */
function validateValue(spec: ModelDialFieldSpec, value: unknown, blockCount?: number): string | null {
  switch (spec.kind) {
    case "positiveInt": {
      if (typeof value !== "number" || !Number.isInteger(value)) {
        return `${spec.field} must be an integer`;
      }
      if (value <= 0) return `${spec.field} must be > 0`;
      return null;
    }
    case "int": {
      if (typeof value !== "number" || !Number.isInteger(value)) {
        return `${spec.field} must be an integer`;
      }
      if (spec.field === "gpuLayers" && blockCount !== undefined) {
        const max = blockCount + 1;
        if (value < 1 || value > max) {
          return `gpuLayers must be between 1 and ${max} (profile blockCount ${blockCount})`;
        }
      }
      return null;
    }
    case "bool":
      return typeof value === "boolean" ? null : `${spec.field} must be a boolean`;
    case "enum":
      return spec.enumValues?.includes(value as string)
        ? null
        : `${spec.field} must be one of: ${spec.enumValues?.join(" | ")}`;
    case "string":
      return typeof value === "string" && value.length > 0
        ? null
        : `${spec.field} must be a non-empty string`;
  }
}

/**
 * Validate and write ONE dial field. Atomic. Returns a structured result —
 * never throws for expected conditions (unknown model, bad value, corrupt
 * file). A corrupt server_setup.json is reported, not clobbered.
 */
export function setModelDial(
  adapterDir: string,
  modelId: string,
  file: ModelDialFile,
  field: string,
  value: unknown,
): SetModelDialResult {
  const files = findModelFiles(adapterDir, modelId);
  if (!files) {
    return { ok: false, error: `unknown model: ${modelId}` };
  }

  const spec = findField(file, field);
  if (!spec) {
    const inOtherFile = ALL_FIELDS.some((f) => f.field === field);
    return {
      ok: false,
      error: inOtherFile
        ? `${field} is not a ${file} field`
        : `unknown field: ${field}`,
    };
  }

  const validationError = validateValue(spec, value, files.blockCount);
  if (validationError) return { ok: false, error: validationError };

  if (file === "server_setup") {
    const raw = existsSync(files.serverSetupPath)
      ? readFileSync(files.serverSetupPath, "utf8")
      : "";
    let parsed: { "llama.cpp"?: Record<string, unknown> };
    try {
      // An empty or corrupt file is a real problem — surface it, never
      // clobber it with a fresh object.
      parsed = JSON.parse(raw) as { "llama.cpp"?: Record<string, unknown> };
    } catch {
      return { ok: false, error: `server_setup.json does not parse as JSON: ${files.serverSetupPath}` };
    }
    const block = parsed["llama.cpp"] ?? (parsed["llama.cpp"] = {});
    const before = block[field] ?? null;
    block[field] = value;
    atomicWriteText(files.serverSetupPath, JSON.stringify(parsed, null, 2) + "\n");
    return {
      ok: true,
      file,
      field,
      before,
      after: value,
      restartRequired: spec.restartRequired,
      modelFile: files.modelFile,
    };
  }

  // client: parse the YAML as a document, mutate the client block in place,
  // re-serialize. parseDocument keeps untouched nodes in their original
  // source form (quotes, key order), so the round-trip is minimal.
  const yamlText = readFileSync(files.yamlPath, "utf8");
  const doc = YAML.parseDocument(yamlText);
  if (doc.errors.length > 0) {
    return { ok: false, error: `adapter YAML does not parse: ${files.yamlPath}` };
  }
  if (!doc.contents || !YAML.isMap(doc.contents)) {
    return { ok: false, error: `adapter YAML is not a mapping: ${files.yamlPath}` };
  }
  let client = doc.get("client", true) as YAMLMap | undefined;
  if (!client || !YAML.isMap(client)) {
    client = new YAML.YAMLMap();
    doc.set("client", client);
  }
  const before = client.get(field) ?? null;
  client.set(field, value);
  atomicWriteText(files.yamlPath, doc.toString());
  return {
    ok: true,
    file,
    field,
    before,
    after: value,
    restartRequired: spec.restartRequired,
    modelFile: files.modelFile,
  };
}
