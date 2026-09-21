/**
 * TCB context builder (ADR-0101 Step 2).
 *
 * Adapted from the original proxy implementation (`buildBcbContext` +
 * `parseToolArguments`). Resolves live line counts from disk for read targets
 * so the `eofOverflow` / `readClamp` rules can compare a requested range
 * against the file's actual length.
 *
 * Pure and dependency-light: no Effect, no I/O beyond a best-effort
 * line scan per read target. The scan never holds the file as one string.
 */

import { closeSync, openSync, readSync } from "node:fs";
import type { ChatMessage } from "../chat-message.js";
import type { ToolCircuitBreakerConfig } from "./types.js";

const LINE_SCAN_BUF = 64 * 1024;

/**
 * Count lines the same way a UTF-8 `split` on newline does: newline bytes + 1.
 * A trailing newline is an extra empty element. Peak memory is one 64 KiB
 * scan buffer, not the file size.
 */
export function countFileLines(path: string): number {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(LINE_SCAN_BUF);
    let newlines = 0;
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      for (let i = 0; i < n; i++) {
        if (buf[i] === 10) newlines++;
      }
    }
    return newlines + 1;
  } finally {
    closeSync(fd);
  }
}

/**
 * Resolve the configured TCB and read live line counts for read targets.
 *
 * For each assistant `tool_call` whose tool has `eofOverflow` or `readClamp`
 * enabled, scans the target file (if present) and records its line count.
 * Files that cannot be read are left `undefined` so the rule skips them.
 */
export function buildBcbContext(
  messages: ChatMessage[],
  config: ToolCircuitBreakerConfig,
): {
  config: ToolCircuitBreakerConfig;
  ctx: { lineCounts: Record<string, number> };
} {
  const lineCounts: Record<string, number> = {};
  for (const m of messages) {
    const calls = m.tool_calls;
    if (!Array.isArray(calls)) continue;
    for (const tc of calls) {
      if (!tc || typeof tc !== "object") continue;
      const fn = (tc as { function?: unknown }).function as
        | { name?: unknown; arguments?: unknown }
        | undefined;
      if (typeof fn?.name !== "string") continue;
      const ruleSet = config.tools[fn.name];
      if (!ruleSet || (!ruleSet.eofOverflow?.enabled && !ruleSet.readClamp?.enabled)) continue;
      const args = parseToolArguments(fn.arguments);
      if (!args) continue;
      const filePath = args.filePath ?? args.path;
      if (typeof filePath !== "string") continue;
      if (lineCounts[filePath] === undefined) {
        try {
          lineCounts[filePath] = countFileLines(filePath);
        } catch {
          // Unknown length -> leave undefined so the rule skips this target.
        }
      }
    }
  }
  return { config, ctx: { lineCounts } };
}

/** Best-effort parse of a tool-call arguments field. */
export function parseToolArguments(args: unknown): Record<string, unknown> | null {
  if (args && typeof args === "object") return args as Record<string, unknown>;
  if (typeof args !== "string") return null;
  try {
    const v = JSON.parse(args);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
