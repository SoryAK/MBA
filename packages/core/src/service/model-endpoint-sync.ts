import { existsSync, mkdirSync, readFileSync, watch, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readModelCatalog } from "./model-catalog.js";

/**
 * VS Code custom-endpoint auto-sync (ADR-0093 Phase 4).
 *
 * Models that declare a `client` block in their adapter YAML are surfaced in
 * the VS Code model picker via `chatLanguageModels.json`. The generated block
 * is identified by `name === GENERATED_BLOCK_NAME` and is the ONLY block this
 * module ever rewrites — foreign blocks (other endpoints, other profiles) are
 * preserved verbatim.
 *
 * The `client` block lives in the adapter YAML. Only `url` is required
 * (models may run on different ports, so there is deliberately no default);
 * every other field is an optional override with a fallback:
 *
 *   client:
 *     url: http://127.0.0.1:8080/v1   # required — no default
 *     contextSize: 131072             # optional — inherits resolved
 *                                     #   server-recipe ctxSize, then 128000
 *     maxOutputTokens: 16384          # optional — defaults to 16384
 *     toolCalling: false              # optional — defaults to true
 *     vision: false                   # optional — defaults to true
 */

export const GENERATED_BLOCK_NAME = "SK.LocalModels";

export interface ClientBlock {
  url: string;
  contextSize?: number;
  maxOutputTokens?: number;
  toolCalling?: boolean;
  vision?: boolean;
}

export interface EndpointModel {
  id: string;
  name: string;
  url: string;
  toolCalling: boolean;
  vision: boolean;
  maxInputTokens: number;
  maxOutputTokens: number;
}

export interface EndpointBlock {
  name: string;
  vendor: string;
  apiKey: string;
  apiType: string;
  models: EndpointModel[];
}

/**
 * Fallback context-size resolver (Option C). When an adapter's `client` block
 * omits `contextSize`, the sync asks this callback for the effective context
 * window — the resolved `ctxSize` from the model's server recipe — so the
 * endpoint advertises the same window the server actually boots with. Returns
 * `undefined` when no recipe value is available (the caller then falls back to
 * `DEFAULTS.contextSize`).
 *
 * Kept as a callback (rather than a resolver import) so this module stays
 * pure and filesystem-only; the CLI supplies the resolver-backed
 * implementation, and the service watcher passes nothing (preserving the
 * historical default).
 */
export type CtxSizeResolver = (entry: { id: string; name: string; client: ClientBlock }) =>
  | number
  | undefined;

export interface SyncOptions {
  adapterDir: string;
  configPath: string;
  apiKeyRef: string;
  /**
   * Optional fallback context-size resolver (Option C). When an adapter's
   * `client` block omits `contextSize`, this is consulted for the resolved
   * server-recipe `ctxSize`. Absent → historical `DEFAULTS.contextSize`.
   */
  resolveCtxSize?: CtxSizeResolver;
}

export interface SyncResult {
  created: boolean;
  updated: boolean;
  models: string[];
}

const DEFAULTS = {
  contextSize: 128_000,
  maxOutputTokens: 16_384,
  toolCalling: true,
  vision: true,
} as const;

/**
 * Parse the `client` block of a single adapter YAML. Returns null when the
 * block is absent or empty. Tolerates partial blocks (only `url` is required
 * downstream; everything else falls back to defaults).
 */
export function readClientBlock(adapterYamlPath: string): ClientBlock | null {
  const text = readFileSync(adapterYamlPath, "utf8");
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^client:\s*(#.*)?$/.test(l ?? ""));
  if (start === -1) return null;

  const block: ClientBlock = { url: "" };
  let found = false;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line.trim() === "") continue;
    if (/^\S/.test(line)) break; // next top-level key ends the block
    const m = line.match(/^\s{2,}([A-Za-z_][A-Za-z0-9_]*):\s*(.+?)\s*(#.*)?$/);
    if (!m) continue;
    const key = m[1];
    const raw = m[2];
    if (!key || !raw) continue;
    const value = raw.replace(/^["']|["']$/g, "");
    switch (key) {
      case "url":
        block.url = value;
        found = true;
        break;
      case "contextSize":
        block.contextSize = Number(value);
        found = true;
        break;
      case "maxOutputTokens":
        block.maxOutputTokens = Number(value);
        found = true;
        break;
      case "toolCalling":
        block.toolCalling = value === "true";
        found = true;
        break;
      case "vision":
        block.vision = value === "true";
        found = true;
        break;
      default:
        // Unknown keys are ignored — forward compatibility.
        break;
    }
  }
  if (!found || !block.url) return null;
  return block;
}

/**
 * Build the generated endpoint block from catalog entries that carry a
 * `client` block. Pure — no filesystem access.
 *
 * `maxInputTokens` precedence (Option C): the YAML `client.contextSize` wins;
 * when omitted, `resolveCtxSize` (the resolved server-recipe `ctxSize`) is
 * used; when that is also absent, `DEFAULTS.contextSize`.
 */
export function buildEndpointBlock(
  entries: Array<{ id: string; name: string; client: ClientBlock }>,
  apiKeyRef: string,
  resolveCtxSize?: CtxSizeResolver,
): EndpointBlock {
  return {
    name: GENERATED_BLOCK_NAME,
    vendor: "customendpoint",
    apiKey: apiKeyRef,
    apiType: "chat-completions",
    models: entries.map(({ id, name, client }) => ({
      id,
      name,
      url: client.url,
      toolCalling: client.toolCalling ?? DEFAULTS.toolCalling,
      vision: client.vision ?? DEFAULTS.vision,
      maxInputTokens:
        client.contextSize ?? resolveCtxSize?.({ id, name, client }) ?? DEFAULTS.contextSize,
      maxOutputTokens: client.maxOutputTokens ?? DEFAULTS.maxOutputTokens,
    })),
  };
}

function readConfigArray(configPath: string): unknown[] | null {
  if (!existsSync(configPath)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Sync the generated VS Code endpoint block from the adapter tree.
 *
 * - No adapter declares a `client` block → no-op (file untouched).
 * - Config file absent → created with the generated block.
 * - Generated block present and current → no-op.
 * - Generated block present and stale → replaced in place; foreign blocks
 *   preserved verbatim.
 * - Config file unparseable → left untouched (fail-safe, never clobbers).
 */
export function syncVsCodeEndpoints(opts: SyncOptions): SyncResult {
  const catalog = readModelCatalog(opts.adapterDir);
  const entries: Array<{ id: string; name: string; client: ClientBlock }> = [];
  for (const entry of catalog) {
    if (!entry.modelFile) continue;
    const client = readClientBlock(entry.yamlPath);
    if (client) entries.push({ id: entry.id, name: entry.name, client });
  }

  if (entries.length === 0) {
    return { created: false, updated: false, models: [] };
  }

  const desired = buildEndpointBlock(entries, opts.apiKeyRef, opts.resolveCtxSize);
  const existing = readConfigArray(opts.configPath);
  if (existing === null) {
    mkdirSync(dirname(opts.configPath), { recursive: true });
    writeFileSync(opts.configPath, JSON.stringify([desired], null, 2) + "\n");
    return { created: true, updated: false, models: entries.map((e) => e.id) };
  }

  const next = existing.filter((b) => {
    const isObject = typeof b === "object" && b !== null;
    return !(isObject && (b as { name?: unknown }).name === GENERATED_BLOCK_NAME);
  });
  next.push(desired);
  const serialized = JSON.stringify(next, null, 2) + "\n";
  const current = readFileSync(opts.configPath, "utf8");
  if (current === serialized) {
    return { created: false, updated: false, models: entries.map((e) => e.id) };
  }
  writeFileSync(opts.configPath, serialized);
  return { created: false, updated: true, models: entries.map((e) => e.id) };
}

/**
 * Watch the adapter tree and re-sync on change (debounced). Returns a stop
 * function. Watch failures are logged, not thrown — the sync is best-effort
 * and the service must keep running.
 */
export function watchAdapterDir(
  adapterDir: string,
  opts: SyncOptions,
  log?: (msg: string) => void,
): () => void {
  const emit = (msg: string) => log?.(msg);
  if (!existsSync(adapterDir)) {
    emit(`[endpoint-sync] adapter dir ${adapterDir} does not exist; not watching`);
    return () => {};
  }

  let timer: NodeJS.Timeout | null = null;
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      try {
        const result = syncVsCodeEndpoints(opts);
        if (result.created || result.updated) {
          emit(
            `[endpoint-sync] ${result.created ? "created" : "updated"} ${opts.configPath} ` +
              `(${result.models.length} model${result.models.length === 1 ? "" : "s"})`,
          );
        }
      } catch (err) {
        emit(`[endpoint-sync] sync failed: ${String(err)}`);
      }
    }, 250);
  };

  const watcher = watch(adapterDir, { recursive: true }, schedule);
  watcher.on("error", (err) => emit(`[endpoint-sync] watch error: ${String(err)}`));
  return () => {
    if (timer) clearTimeout(timer);
    watcher.close();
  };
}
