/**
 * Per-server in-memory log ring buffer (ADR-0097 Phase 2, Feature 2).
 *
 * Replaces the old `.log`/`.err` files: the daemon pipes each owned
 * llama-server's stdout/stderr, line-splits the stream, and appends complete
 * lines to a bounded ring buffer keyed by port. `mba servers logs <id>` reads
 * the buffer; the daemon also tees every line to its own stdout so the
 * systemd journal keeps a persistent, rotated copy.
 *
 * The registry is attached to the `LifecycleSeams` object via a `Symbol.for`
 * key — the same pattern as `OWNED_GROUPS_KEY` in `server-lifecycle.ts` — so
 * each seams instance (one per daemon, one per test) gets an isolated
 * registry with no global state.
 */

import type { LifecycleSeams } from "./server-lifecycle.js";

/** Default ring capacity: ~1 MiB of captured lines per server. */
export const DEFAULT_LOG_BUFFER_BYTES = 1024 * 1024;

const LOG_BUFFER_KEY = Symbol.for("mba.logBuffers");

/**
 * A bounded, line-oriented ring buffer.
 *
 * `append` accepts raw chunks (which may contain zero, one, or many newlines
 * and may end mid-line). The buffer holds the partial trailing line until a
 * newline completes it, then stores the complete line. When the total byte
 * size exceeds the bound, the OLDEST lines are dropped first so the newest
 * output is always retained.
 */
export class ServerLogBuffer {
  private readonly bound: number;
  private readonly stored: string[] = [];
  private bytes = 0;
  private partial = "";
  private readonly subscribers = new Set<(line: string) => void>();

  constructor(bound: number = DEFAULT_LOG_BUFFER_BYTES) {
    this.bound = bound;
  }

  /**
   * Append a raw chunk. Splits on `\n`, holds any trailing partial line, and
   * delivers each completed line to subscribers. Empty lines are ignored.
   */
  append(chunk: string): void {
    this.partial += chunk;
    const parts = this.partial.split("\n");
    // The last element is the (possibly empty) trailing partial line.
    this.partial = parts.pop() ?? "";
    for (const line of parts) {
      if (line === "") continue;
      this.pushLine(line);
    }
  }

  /** Return the last `n` lines (all lines when `n` is omitted). */
  lines(n?: number): string[] {
    if (n === undefined) return [...this.stored];
    if (n <= 0) return [];
    return this.stored.slice(-n);
  }

  /**
   * Subscribe to newly completed lines. Returns an unsubscribe function.
   * Subscribers are invoked synchronously as lines complete.
   */
  subscribe(fn: (line: string) => void): () => void {
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  }

  private pushLine(line: string): void {
    this.stored.push(line);
    this.bytes += line.length + 1; // +1 for the newline we conceptually store
    // Evict oldest lines until we are back under the bound.
    while (this.bytes > this.bound && this.stored.length > 1) {
      const dropped = this.stored.shift()!;
      this.bytes -= dropped.length + 1;
    }
    // A single line larger than the bound is kept (newest wins) — evicting it
    // would leave the buffer empty, which is worse than a brief over-bound.
    for (const fn of this.subscribers) {
      fn(line);
    }
  }
}

type LogBufferRegistry = Map<number, ServerLogBuffer>;

function registry(seams: LifecycleSeams): LogBufferRegistry {
  const s = seams as unknown as Record<symbol, LogBufferRegistry | undefined>;
  let reg = s[LOG_BUFFER_KEY];
  if (!reg) {
    reg = new Map();
    s[LOG_BUFFER_KEY] = reg;
  }
  return reg;
}

/** Get or create the ring buffer for a port (attached to this seams instance). */
export function getOrCreateLogBuffer(
  port: number,
  seams: LifecycleSeams,
  bound: number = DEFAULT_LOG_BUFFER_BYTES,
): ServerLogBuffer {
  const reg = registry(seams);
  let buf = reg.get(port);
  if (!buf) {
    buf = new ServerLogBuffer(bound);
    reg.set(port, buf);
  }
  return buf;
}

/** Get the ring buffer for a port, or undefined if none has been created. */
export function getLogBuffer(
  port: number,
  seams: LifecycleSeams,
): ServerLogBuffer | undefined {
  return registry(seams).get(port);
}

/** Remove the ring buffer for a port (called when the server stops). */
export function removeLogBuffer(port: number, seams: LifecycleSeams): void {
  registry(seams).delete(port);
}
