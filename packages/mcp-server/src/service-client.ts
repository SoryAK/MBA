/**
 * HTTP client for the global MBA service (ADR-0092 Step 2).
 *
 * The service is the single source of truth for global TCB rules and the
 * rule-class registry. This client is a thin, standalone wrapper — it never
 * touches the JSON files under ~/.mba/ directly, so the service stays the
 * only writer.
 *
 * Discovery order for the base URL:
 *   1. explicit `baseUrl` option
 *   2. MBA_SERVICE_URL env var (deprecated alias: CYARD_MBA_SERVICE_URL)
 *   3. ~/.mba/mba/service.json discovery file (written by the service)
 *
 * Every call is fail-soft: a down/unreachable service yields a structured
 * `{ ok: false, error }` result instead of throwing, so MCP tool handlers
 * can surface a clean "service unreachable" message.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface MbaServiceInfo {
  readonly port: number;
  readonly pid: number;
  readonly startedAt: string;
}

export interface MbaResolveConfigResult {
  readonly version: number;
  readonly model: string | null;
  readonly tcb: unknown;
  readonly ruleClasses: unknown;
}

export interface MbaSetRulesInput {
  readonly tcb: unknown;
  readonly ruleClasses?: unknown;
}

export interface MbaSetRulesResult {
  readonly version: number;
  readonly tcb: unknown;
}

export interface MbaStatusResult {
  readonly version: number;
  readonly uptimeMs: number;
  readonly paths: {
    readonly baseDir: string;
    readonly tcbPath: string;
    readonly ruleClassesPath: string;
    readonly versionPath: string;
  };
}

export interface MbaModelEntry {
  readonly id: string;
  readonly name: string;
  readonly family?: string;
  readonly modelFile?: string;
  readonly loaded: boolean;
}

export interface MbaModelsResult {
  readonly models: MbaModelEntry[];
}

export type MbaEnsureModelResult =
  | { readonly status: "loaded"; readonly id: string }
  | { readonly status: "switched"; readonly id: string };

export type ServiceCallResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: string };

export interface MbaServiceClientOptions {
  /** Explicit base URL (e.g. http://127.0.0.1:4321). Skips discovery. */
  readonly baseUrl?: string;
  /** Base dir holding mba/service.json. Default: ~/.mba */
  readonly baseDir?: string;
  /** Injectable fetch for tests. Default: global fetch. */
  readonly fetchImpl?: typeof fetch;
  /** Per-request timeout in ms. Default: 1500. */
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 1500;

export function defaultServiceInfoPath(baseDir: string = join(homedir(), ".mba")): string {
  return join(baseDir, "mba", "service.json");
}

export function readServiceInfoOrNull(
  baseDir: string = join(homedir(), ".mba"),
): MbaServiceInfo | null {
  const path = defaultServiceInfoPath(baseDir);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (typeof raw !== "object" || raw === null) return null;
    const v = raw as Record<string, unknown>;
    if (typeof v.port !== "number" || !Number.isInteger(v.port)) return null;
    return {
      port: v.port,
      pid: typeof v.pid === "number" ? v.pid : 0,
      startedAt: typeof v.startedAt === "string" ? v.startedAt : "",
    };
  } catch {
    return null;
  }
}

/**
 * Resolve the service base URL. Returns null when no discovery source is
 * available — callers should treat that as "service not running".
 */
export function resolveServiceBaseUrl(opts: MbaServiceClientOptions = {}): string | null {
  if (opts.baseUrl) return opts.baseUrl;
  // `CYARD_MBA_SERVICE_URL` is a deprecated alias kept for existing setups.
  const envUrl = process.env.MBA_SERVICE_URL ?? process.env.CYARD_MBA_SERVICE_URL;
  if (envUrl && envUrl.length > 0) return envUrl;
  const info = readServiceInfoOrNull(opts.baseDir);
  if (info) return `http://127.0.0.1:${info.port}`;
  return null;
}

async function callService<T>(
  opts: MbaServiceClientOptions,
  path: string,
  init?: RequestInit,
): Promise<ServiceCallResult<T>> {
  const baseUrl = resolveServiceBaseUrl(opts);
  if (!baseUrl) {
    return {
      ok: false,
      error:
        "service unreachable: no base URL (set MBA_SERVICE_URL or start the MBA service so ~/.mba/mba/service.json exists)",
    };
  }

  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${baseUrl}${path}`, {
      ...init,
      signal: controller.signal,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, error: `service error: HTTP ${res.status} ${body}`.trim() };
    }
    const data = (await res.json()) as T;
    return { ok: true, data };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `service unreachable: ${reason}` };
  } finally {
    clearTimeout(timer);
  }
}

export function fetchResolveConfig(
  opts: MbaServiceClientOptions,
  model?: string,
): Promise<ServiceCallResult<MbaResolveConfigResult>> {
  const query = model ? `?model=${encodeURIComponent(model)}` : "";
  return callService<MbaResolveConfigResult>(opts, `/resolve_config${query}`);
}

export function fetchSetRules(
  opts: MbaServiceClientOptions,
  input: MbaSetRulesInput,
): Promise<ServiceCallResult<MbaSetRulesResult>> {
  return callService<MbaSetRulesResult>(opts, "/set_rules", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function fetchStatus(
  opts: MbaServiceClientOptions,
): Promise<ServiceCallResult<MbaStatusResult>> {
  return callService<MbaStatusResult>(opts, "/status");
}

export function fetchModels(
  opts: MbaServiceClientOptions,
): Promise<ServiceCallResult<MbaModelsResult>> {
  return callService<MbaModelsResult>(opts, "/models");
}

export function fetchEnsureModel(
  opts: MbaServiceClientOptions,
  id: string,
): Promise<ServiceCallResult<MbaEnsureModelResult>> {
  return callService<MbaEnsureModelResult>(opts, "/models/ensure", {
    method: "POST",
    body: JSON.stringify({ id }),
  });
}
