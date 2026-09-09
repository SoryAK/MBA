/**
 * Operator-defined clients (name + envelope).
 *
 * MBA ships five harness envelopes. A sixth editor is a row in
 * `mba/clients.json`, not a disk scan. The name is the harness key for
 * environment folders and for staging. `instructions.md` still lives on
 * the family → model ladder, never in `environments/`.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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

export function readOperatorClients(path: string): OperatorClient[] {
  if (!existsSync(path)) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return [];
  }
  const doc = raw as Partial<ClientsFile> | null;
  if (!doc || !Array.isArray(doc.clients)) return [];
  const rows: OperatorClient[] = [];
  const seen = new Set<string>();
  for (const item of doc.clients) {
    const parsed = parseClient(item);
    if (!parsed) continue;
    if (seen.has(parsed.name)) continue;
    seen.add(parsed.name);
    rows.push(parsed);
  }
  return rows;
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
  | { readonly ok: false; readonly error: string };

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
  const rows = readOperatorClients(path);
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
): { readonly ok: true; readonly removed: boolean } | { readonly ok: false; readonly error: string } {
  const name = nameRaw.trim().toLowerCase();
  if (isReservedHarnessName(name)) {
    return { ok: false, error: `'${name}' is a built-in client` };
  }
  const rows = readOperatorClients(path);
  const next = rows.filter((r) => r.name !== name);
  if (next.length === rows.length) return { ok: true, removed: false };
  writeOperatorClients(path, next);
  return { ok: true, removed: true };
}

export function operatorEnvelopeBindings(path: string): EnvelopeBinding[] {
  return readOperatorClients(path).map(({ name, envelope }) => ({ name, envelope }));
}
