/**
 * llama-server slot / KV control (ADR-0097 Phase 4).
 *
 * MBA already creates `<dirname(weights)>/kv/<fork>/slots` and boots with
 * `--slot-save-path` (G3). This module *drives* that folder: save, restore,
 * erase, and list against the live llama-server on the entry's port.
 *
 * Filenames are basenames only. llama-server writes them under
 * `--slot-save-path`; MBA never points a slot file at another model's dir.
 *
 * Whole-slot ops only. Prefix-cut on the next prompt is llama-server's job
 * when we send a cleaned chat. This API is the explicit button.
 */

import { basename } from "node:path";
import { slotSavePath } from "./server-lifecycle.js";

/** llama-server slot actions MBA exposes. */
export type SlotAction = "save" | "restore" | "erase";

/** Default slot when `--parallel` is 1 (MBA's llama.cpp default). */
export const DEFAULT_SLOT_ID = 0;

/** Save/restore of a large KV dump can be slow. */
export const SLOT_OP_TIMEOUT_MS = 60_000;

/** Input to one slot mutation. `filename` is required for save/restore. */
export interface SlotOpInput {
  readonly action: SlotAction;
  readonly slotId?: number;
  readonly filename?: string;
}

/** Result of a successful slot mutation. */
export interface SlotOpResult {
  readonly action: SlotAction;
  readonly slotId: number;
  readonly filename?: string;
  /** Absolute G3 dir this server was booted with (`--slot-save-path`). */
  readonly dir: string;
  /** llama-server JSON body (passed through). */
  readonly upstream: unknown;
}

/** This server type has no slots (ollama). */
export class SlotUnsupportedError extends Error {
  constructor(serverType: string) {
    super(`${serverType} has no slots`);
    this.name = "SlotUnsupportedError";
  }
}

/** Filename rejected (empty, path, traversal). */
export class SlotFilenameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlotFilenameError";
  }
}

/** llama-server refused the op or was unreachable. */
export class SlotOpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlotOpError";
  }
}

const FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Accept only a basename that will stay inside `--slot-save-path`.
 * Rejects empty strings, path separators, `..`, and leading dots.
 */
export function sanitizeSlotFilename(filename: string): string {
  const name = filename.trim();
  if (name.length === 0) {
    throw new SlotFilenameError("filename is required");
  }
  if (name !== basename(name) || name.includes("/") || name.includes("\\") || name.includes("..")) {
    throw new SlotFilenameError("filename must be a basename inside the model's kv/<fork>/slots dir");
  }
  if (!FILENAME_RE.test(name)) {
    throw new SlotFilenameError("filename must be letters, digits, '.', '_', or '-'");
  }
  return name;
}

/** G3 dir for a registry entry. Missing/unknown `fork` → `upstream`. */
export function slotDirForEntry(entry: { modelFile: string; fork?: string }): string {
  const fork = entry.fork === "llama.cpp" ? "llama.cpp" : "upstream";
  return slotSavePath(entry.modelFile, fork);
}

function resolveSlotId(slotId: number | undefined): number {
  const id = slotId ?? DEFAULT_SLOT_ID;
  if (!Number.isInteger(id) || id < 0) {
    throw new SlotOpError("slotId must be a non-negative integer");
  }
  return id;
}

async function parseBody(res: Response): Promise<unknown> {
  const text = await res.text().catch(() => "");
  if (text.length === 0) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { raw: text };
  }
}

/**
 * POST `/slots/{id}?action=save|restore|erase` on a llama-server.
 * Always sends a JSON body (`{}` for erase) so older servers do not hang
 * waiting for Content-Length.
 */
export async function callLlamaSlot(
  port: number,
  req: SlotOpInput,
  fetchImpl: typeof fetch = fetch,
): Promise<{ slotId: number; filename?: string; upstream: unknown }> {
  const slotId = resolveSlotId(req.slotId);
  const action = req.action;
  let filename: string | undefined;
  if (action === "save" || action === "restore") {
    if (typeof req.filename !== "string") {
      throw new SlotFilenameError(`${action} requires a filename`);
    }
    filename = sanitizeSlotFilename(req.filename);
  }
  const url = `http://127.0.0.1:${port}/slots/${slotId}?action=${action}`;
  const body = filename !== undefined ? { filename } : {};
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SLOT_OP_TIMEOUT_MS),
    });
  } catch (err) {
    throw new SlotOpError(
      `llama-server slot ${action} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const upstream = await parseBody(res);
  if (!res.ok) {
    const detail =
      typeof upstream === "object" && upstream !== null
        ? JSON.stringify(upstream).slice(0, 200)
        : String(upstream).slice(0, 200);
    throw new SlotOpError(`llama-server slot ${action} returned ${res.status}: ${detail}`);
  }
  return { slotId, filename, upstream };
}

/** GET `/slots` — live slot snapshot. Needs `--slots` (MBA boots with it). */
export async function listLlamaSlots(
  port: number,
  fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
  const url = `http://127.0.0.1:${port}/slots`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "GET",
      signal: AbortSignal.timeout(SLOT_OP_TIMEOUT_MS),
    });
  } catch (err) {
    throw new SlotOpError(
      `llama-server GET /slots failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const upstream = await parseBody(res);
  if (!res.ok) {
    throw new SlotOpError(`llama-server GET /slots returned ${res.status}`);
  }
  return upstream;
}
