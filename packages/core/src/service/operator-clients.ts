/**
 * Operator-defined clients (name + envelope).
 *
 * MBA ships five harness envelopes. A sixth editor is a row in
 * `mba/clients.json`, not a disk scan. The name is the harness key for
 * environment folders and for staging. `instructions.md` still lives on
 * the family → model ladder, never in `environments/`.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, posix } from "node:path";
import {
  builtInEnvelopeBindings,
  compactHarnessKey,
  isReservedHarnessName,
  type EnvelopeBinding,
} from "../mba/envelope.js";

export interface OperatorClient {
  readonly name: string;
  readonly envelope: string;
  readonly ide?: string;
}

interface ClientsFile {
  readonly version: number;
  readonly clients: unknown[];
}

const CLIENTS_VERSION = 1;
const NAME_RE = /^[a-z][a-z0-9-]{0,62}$/;
const PLAYBOOK_BASENAMES = new Set(["claude.md", "agents.md", "gemini.md", "instructions.md"]);

export function isSafeEnvelopePath(raw: string): boolean {
  const trimmed = raw.trim().replace(/\\/g, "/");
  if (trimmed.length === 0 || trimmed.length > 240) return false;
  if (trimmed.startsWith("/") || /^[a-zA-Z]:/.test(trimmed)) return false;
  if (trimmed.includes("\0")) return false;
  const norm = posix.normalize(trimmed);
  if (norm === "." || norm === "" || norm.startsWith("../") || norm === "..") return false;
  if (norm.split("/").includes("..")) return false;
  const base = posix.basename(norm).toLowerCase();
  if (PLAYBOOK_BASENAMES.has(base)) return false;
  return true;
}

export function normalizeClientName(raw: string): string | undefined {
  const name = raw.trim().toLowerCase();
  if (!NAME_RE.test(name)) return undefined;
  if (isReservedHarnessName(name)) return undefined;
  return name;
}

function parseClient(value: unknown): OperatorClient | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.name !== "string" || typeof v.envelope !== "string") return undefined;
  const name = normalizeClientName(v.name);
  if (!name || !isSafeEnvelopePath(v.envelope)) return undefined;
  const envelope = posix.normalize(v.envelope.trim().replace(/\\/g, "/"));
  const ide =
    typeof v.ide === "string" && v.ide.trim().length > 0 ? v.ide.trim() : undefined;
  return ide ? { name, envelope, ide } : { name, envelope };
}

export type ClientsReadResult =
  | { readonly kind: "missing"; readonly clients: readonly OperatorClient[] }
  | { readonly kind: "valid"; readonly clients: readonly OperatorClient[] }
  | {
      readonly kind: "corrupt";
      readonly clients: readonly OperatorClient[];
      readonly error: string;
    };

function corruptClients(error: string): ClientsReadResult {
  return { kind: "corrupt", clients: [], error };
}

/**
 * Read operator clients. Missing and valid-empty are open (built-ins only).
 * Corrupt JSON, wrong shape, or an invalid row fail closed — callers must
 * not treat that as `[]` and pretend extras were never added.
 */
export function readOperatorClients(path: string): ClientsReadResult {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return { kind: "missing", clients: [] };
    }
    return corruptClients("operator clients file could not be read");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    return corruptClients("operator clients file is not valid JSON");
  }
  const doc = raw as Partial<ClientsFile> | null;
  if (
    !doc ||
    typeof doc !== "object" ||
    doc.version !== CLIENTS_VERSION ||
    !Array.isArray(doc.clients)
  ) {
    return corruptClients("operator clients file has an unsupported shape or version");
  }
  const rows: OperatorClient[] = [];
  const seen = new Set<string>();
  for (const [index, item] of doc.clients.entries()) {
    const parsed = parseClient(item);
    if (!parsed) {
      return corruptClients(`operator clients file contains an invalid client at index ${index}`);
    }
    if (seen.has(parsed.name)) {
      return corruptClients(`operator clients file contains a duplicate name at index ${index}`);
    }
    seen.add(parsed.name);
    rows.push(parsed);
  }
  return { kind: "valid", clients: rows };
}

export function writeOperatorClients(path: string, clients: readonly OperatorClient[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const doc: ClientsFile = { version: CLIENTS_VERSION, clients: [...clients] };
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(doc, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}

export type AddClientResult =
  | { readonly ok: true; readonly client: OperatorClient; readonly updated: boolean }
  | { readonly ok: false; readonly error: string; readonly code?: "clients-corrupt" };

export function addOperatorClient(
  path: string,
  input: { readonly name: string; readonly envelope: string; readonly ide?: string },
): AddClientResult {
  const name = normalizeClientName(input.name);
  if (!name) {
    return {
      ok: false,
      error: isReservedHarnessName(input.name)
        ? `'${input.name.trim()}' is a built-in client`
        : "name must be lowercase letters, digits, and hyphens",
    };
  }
  if (!isSafeEnvelopePath(input.envelope)) {
    return {
      ok: false,
      error:
        "envelope must be a project-relative path (no '..', not CLAUDE.md / AGENTS.md)",
    };
  }
  const envelope = posix.normalize(input.envelope.trim().replace(/\\/g, "/"));
  const ide =
    typeof input.ide === "string" && input.ide.trim().length > 0
      ? input.ide.trim()
      : undefined;
  const next: OperatorClient = ide ? { name, envelope, ide } : { name, envelope };

  const taken = new Set(
    builtInEnvelopeBindings().map((b) => posix.normalize(b.envelope)),
  );
  const state = readOperatorClients(path);
  if (state.kind === "corrupt") {
    return { ok: false, code: "clients-corrupt", error: state.error };
  }
  const rows = [...state.clients];
  for (const row of rows) {
    if (row.name === name) continue;
    taken.add(row.envelope);
  }
  if (taken.has(envelope)) {
    return { ok: false, error: `envelope already used: ${envelope}` };
  }

  const idx = rows.findIndex((r) => r.name === name);
  if (idx < 0) {
    writeOperatorClients(path, [...rows, next]);
    return { ok: true, client: next, updated: false };
  }
  const out = [...rows];
  out[idx] = next;
  writeOperatorClients(path, out);
  return { ok: true, client: next, updated: true };
}

export function removeOperatorClient(
  path: string,
  nameRaw: string,
):
  | { readonly ok: true; readonly removed: boolean }
  | { readonly ok: false; readonly error: string; readonly code?: "clients-corrupt" } {
  const name = nameRaw.trim().toLowerCase();
  if (isReservedHarnessName(name)) {
    return { ok: false, error: `'${name}' is a built-in client` };
  }
  const state = readOperatorClients(path);
  if (state.kind === "corrupt") {
    return { ok: false, code: "clients-corrupt", error: state.error };
  }
  const rows = state.clients;
  const next = rows.filter((r) => r.name !== name);
  if (next.length === rows.length) return { ok: true, removed: false };
  writeOperatorClients(path, next);
  return { ok: true, removed: true };
}

export function operatorEnvelopeBindings(clients: readonly OperatorClient[]): EnvelopeBinding[] {
  return clients.map(({ name, envelope }) => ({ name, envelope }));
}

export interface RegisteredClient {
  readonly name: string;
  readonly envelope: string;
  readonly source: "built-in" | "added";
  readonly ide?: string;
}

/** Built-in harnesses plus operator rows. The GET /clients catalog. */
export function clientsCorruptJson(error: string): { code: "clients-corrupt"; error: string } {
  return {
    code: "clients-corrupt",
    error: `operator clients are corrupt — ${error}`,
  };
}

export function listRegisteredClients(path: string): RegisteredClient[] {
  const builtIn = builtInEnvelopeBindings().map((b) => ({
    name: b.name,
    envelope: b.envelope,
    source: "built-in" as const,
  }));
  const added = readOperatorClients(path).clients.map((c) => ({
    name: c.name,
    envelope: c.envelope,
    source: "added" as const,
    ...(c.ide ? { ide: c.ide } : {}),
  }));
  return [...builtIn, ...added];
}
