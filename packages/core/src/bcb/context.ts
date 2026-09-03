/**
 * TCB context builder (ADR-0101 Step 2).
 *
 * Copied from C-Yard `packages/proxy/src/server.ts` (`buildBcbContext` +
 * `parseToolArguments`). Resolves live line counts from disk for read targets
 * so the `eofOverflow` / `readClamp` rules can compare a requested range
 * against the file's actual length.
 *
 * Pure and dependency-light: no Effect, no I/O beyond a best-effort
 * `readFileSync` per read target.
 */

import { readFileSync } from "node:fs";
import type { ChatMessage } from "../chat-message.js";
import type { ToolCircuitBreakerConfig } from "./types.js";

/**
 * Resolve the configured TCB and read live line counts for read targets.
 *
 * For each assistant `tool_call` whose tool has `eofOverflow` or `readClamp`
 * enabled, reads the target file (if present) and records its line count.
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
          const text = readFileSync(filePath, "utf8");
          // Count lines the same way read_file consumers expect: split on newline.
          // A trailing newline produces one extra empty element; that matches the
          // standard convention where wc -l reports N for a file ending in newline.
          lineCounts[filePath] = text.split("\n").length;
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
