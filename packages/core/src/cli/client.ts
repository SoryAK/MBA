/**
 * Thin HTTP client for the MBA service. Discovery + GET/POST/SSE only.
 * The CLI never reads or writes adapter files itself (ADR-0096).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defaultStateDir } from "../service/paths.js";

export function defaultSwitchPort(): number {
  const n = Number(process.env.MBA_SWITCH_PORT ?? 8080);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : 8080;
}

export function fail(message: string): never {
  process.stderr.write(`[mba] ${message}\n`);
  process.exit(2);
}

/** CLI copy when discovery finds no live daemon. */
export const SERVICE_DOWN =
  "MBA service not discovered — daemon is down. Start the MBA service or set MBA_SERVICE_URL";

export function resolveServiceUrl(): string | null {
  const envUrl = process.env.MBA_SERVICE_URL;
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

export async function serviceGet<T>(baseUrl: string, path: string): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`service error: HTTP ${res.status} ${body}`.trim());
  }
  return (await res.json()) as T;
}

export async function servicePost<T>(baseUrl: string, path: string, body: unknown): Promise<T> {
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
export function formatBytes(n: number): string {
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
 */
export async function servicePostSse<T>(
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

    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
      if (!dataLine) continue;
      let event: {
        type: string;
        downloaded?: number;
        total?: number | null;
        result?: T;
        message?: string;
      };
      try {
        event = JSON.parse(dataLine.slice(5).trim());
      } catch {
        continue;
      }
      if (event.type === "progress") {
        renderProgress(event.downloaded ?? 0, event.total ?? null, false);
      } else if (event.type === "done") {
        process.stdout.write("\r\x1b[K");
        return event.result as T;
      } else if (event.type === "error") {
        process.stdout.write("\r\x1b[K");
        throw new Error(event.message ?? "pull failed");
      }
    }
  }
  throw new Error("pull stream ended without a result");
}
