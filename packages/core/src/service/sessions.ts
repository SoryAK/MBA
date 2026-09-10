/**
 * Paired-client sessions (connect plane).
 *
 * Empty file = door open (today's behavior). One or more sessions = the
 * proxy requires a Bearer token. MBA is the bouncer; it is not the client.
 *
 * Pairing is many keys: two models may share a harness + project (chat +
 * embed). The staged envelope is one playbook for that slot. Last connect
 * that has a card owns the file. A connect with no card must not clear a
 * sibling's playbook.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve, basename } from "node:path";
import { readModelCatalog } from "./model-catalog.js";

export interface ClientSession {
  readonly id: string;
  readonly modelId: string;
  readonly harness: string;
  readonly ide?: string;
  readonly projectRoot: string;
  readonly tokenHash: string;
  readonly createdAt: string;
}

interface SessionsFile {
  readonly version: number;
  readonly sessions: unknown[];
}

const TOKEN_HASH_RE = /^[0-9a-f]{64}$/;
const SESSIONS_VERSION = 2;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** SHA-256 hex of a minted pairing token. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function hashBuffer(hex: string): Buffer | undefined {
  if (!TOKEN_HASH_RE.test(hex)) return undefined;
  return Buffer.from(hex, "hex");
}

function tokenMatches(tokenHash: string, token: string): boolean {
  const stored = hashBuffer(tokenHash);
  if (!stored) return false;
  const incoming = createHash("sha256").update(token).digest();
  return timingSafeEqual(stored, incoming);
}

function parseSession(value: unknown): { session: ClientSession; scrubPlaintext: boolean } | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if (
    !isNonEmptyString(v.id) ||
    !isNonEmptyString(v.modelId) ||
    !isNonEmptyString(v.harness) ||
    (v.ide !== undefined && typeof v.ide !== "string") ||
    !isNonEmptyString(v.projectRoot) ||
    !isNonEmptyString(v.createdAt)
  ) {
    return undefined;
  }
  const hasPlaintext = isNonEmptyString(v.token);
  let tokenHash: string | undefined;
  if (isNonEmptyString(v.tokenHash) && TOKEN_HASH_RE.test(v.tokenHash)) {
    tokenHash = v.tokenHash;
  } else if (isNonEmptyString(v.token)) {
    tokenHash = hashToken(v.token);
  }
  if (!tokenHash) return undefined;
  const ide = typeof v.ide === "string" && v.ide.length > 0 ? v.ide : undefined;
  return {
    session: {
      id: v.id,
      modelId: v.modelId,
      harness: v.harness,
      ide,
      projectRoot: v.projectRoot,
      tokenHash,
      createdAt: v.createdAt,
    },
    scrubPlaintext: hasPlaintext,
  };
}

export function readSessions(path: string): ClientSession[] {
  if (!existsSync(path)) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return [];
  }
  const doc = raw as Partial<SessionsFile> | null;
  if (!doc || !Array.isArray(doc.sessions)) return [];
  const rows: ClientSession[] = [];
  let scrub = false;
  for (const item of doc.sessions) {
    const parsed = parseSession(item);
    if (!parsed) continue;
    rows.push(parsed.session);
    if (parsed.scrubPlaintext) scrub = true;
  }
  if (scrub) writeSessions(path, rows);
  return rows;
}

export function writeSessions(path: string, sessions: readonly ClientSession[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const doc: SessionsFile = {
    version: SESSIONS_VERSION,
    sessions: sessions.map((s) => ({
      id: s.id,
      modelId: s.modelId,
      harness: s.harness,
      ...(s.ide ? { ide: s.ide } : {}),
      projectRoot: s.projectRoot,
      tokenHash: s.tokenHash,
      createdAt: s.createdAt,
    })),
  };
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(doc, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}

export function mintToken(): string {
  return `mba.${randomBytes(32).toString("base64url")}`;
}

export function mintSessionId(): string {
  return `sess.${randomBytes(8).toString("hex")}`;
}

export function pairingActive(sessions: readonly ClientSession[]): boolean {
  return sessions.length > 0;
}

/** Session as shown on status — never includes the hash. */
export type PublicSession = Omit<ClientSession, "tokenHash">;

export function publicSessions(sessions: readonly ClientSession[]): PublicSession[] {
  return sessions.map(({ tokenHash: _tokenHash, ...rest }) => rest);
}

export function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const m = /^Bearer\s+(\S+)/i.exec(header.trim());
  return m?.[1];
}

export function findSessionByToken(
  sessions: readonly ClientSession[],
  token: string,
): ClientSession | undefined {
  return sessions.find((s) => tokenMatches(s.tokenHash, token));
}

/** True when the request `model` field is this session's catalog model. */
export function sessionAllowsModel(
  session: ClientSession,
  requestModel: string | undefined,
  adapterDir?: string,
): boolean {
  if (!requestModel) return true;
  if (requestModel === session.modelId) return true;
  if (!adapterDir) return false;
  try {
    const catalog = readModelCatalog(adapterDir);
    const row = catalog.find((e) => e.id === session.modelId);
    if (!row) return false;
    if (requestModel === row.name) return true;
    if (row.modelFile && (requestModel === row.modelFile || basename(requestModel) === basename(row.modelFile))) {
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

export function upsertSession(
  sessions: readonly ClientSession[],
  next: ClientSession,
): ClientSession[] {
  const projectRoot = resolve(next.projectRoot);
  const idx = sessions.findIndex(
    (s) =>
      s.modelId === next.modelId &&
      s.harness === next.harness &&
      resolve(s.projectRoot) === projectRoot,
  );
  const row = { ...next, projectRoot };
  if (idx < 0) return [...sessions, row];
  const out = [...sessions];
  out[idx] = row;
  return out;
}

/** Sessions that share one envelope slot (same harness + project). */
export function sessionsSharingSlot(
  sessions: readonly ClientSession[],
  harness: string,
  projectRoot: string,
): ClientSession[] {
  const root = resolve(projectRoot);
  return sessions.filter(
    (s) => s.harness === harness && resolve(s.projectRoot) === root,
  );
}

export function newestSession(
  sessions: readonly ClientSession[],
): ClientSession | undefined {
  if (sessions.length === 0) return undefined;
  return [...sessions].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
}

export function revokeSessions(
  sessions: readonly ClientSession[],
  opts: { readonly modelId?: string; readonly harness?: string; readonly projectRoot?: string } = {},
): ClientSession[] {
  if (!opts.modelId && !opts.harness && !opts.projectRoot) return [];
  return sessions.filter((s) => {
    const modelHit = !opts.modelId || s.modelId === opts.modelId;
    const harnessHit = !opts.harness || s.harness === opts.harness;
    const projectHit =
      !opts.projectRoot || resolve(s.projectRoot) === resolve(opts.projectRoot);
    return !(modelHit && harnessHit && projectHit);
  });
}

export type PairingVerdict =
  | { readonly ok: true; readonly session?: ClientSession; readonly stripAuth: boolean }
  | { readonly ok: false; readonly error: string };

/**
 * Door check for `/v1/chat/completions`.
 * No sessions → open, and Authorization is forwarded upstream.
 * Any session → Bearer must match, and must be allowed for this model.
 */
export function authorizeChat(
  sessions: readonly ClientSession[],
  authorization: string | undefined,
  requestModel: string | undefined,
  adapterDir?: string,
): PairingVerdict {
  if (!pairingActive(sessions)) {
    return { ok: true, stripAuth: false };
  }
  const token = bearerToken(authorization);
  if (!token) {
    return { ok: false, error: "paired client required — mba connect" };
  }
  const session = findSessionByToken(sessions, token);
  if (!session) {
    return { ok: false, error: "paired client required — mba connect" };
  }
  if (!sessionAllowsModel(session, requestModel, adapterDir)) {
    return { ok: false, error: "paired token does not match this model" };
  }
  return { ok: true, session, stripAuth: true };
}
