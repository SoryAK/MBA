/**
 * Shared helper: parse tool calls out of an OpenAI-messages array (ADR-0086).
 *
 * The TCB rules all consume the universal ordered call list, so extraction is
 * factored out to keep rules small and focused.
 */

import type { ChatMessage } from "../chat-message.js";
import type { OrderedToolCallsOptions, ToolCall } from "./types.js";

/** Parse a tool-call `arguments` field (JSON string or already an object). */
function parseArgs(args: unknown): Record<string, unknown> | null {
  if (args && typeof args === "object") return args as Record<string, unknown>;
  if (typeof args !== "string") return null;
  try {
    const v = JSON.parse(args);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** FNV-1a 32-bit hash → 8-char hex. Non-crypto; a collision only costs a spurious break. */
function fnv1a32(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    // 32-bit FNV prime multiply via shifts, kept in unsigned range.
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** Recursively sort object keys so structurally-equal args serialize identically. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) {
      out[key] = canonicalize(src[key]);
    }
    return out;
  }
  return value;
}

/** Hash the args, honouring an optional per-tool key allowlist. */
function hashArgs(
  tool: string,
  args: Record<string, unknown>,
  hashKeys: OrderedToolCallsOptions["hashKeys"],
): string {
  const allow = hashKeys?.[tool];
  const subject = allow
    ? Object.fromEntries(allow.filter((k) => k in args).map((k) => [k, args[k]]))
    : args;
  return fnv1a32(JSON.stringify(canonicalize(subject)));
}

/** Extract the read bridge field when the args are read-shaped. */
function readBridge(args: Record<string, unknown>): ToolCall["read"] {
  const filePath = args.filePath ?? args.path;
  const start = args.startLine;
  const end = args.endLine;
  if (typeof filePath === "string" && Number.isInteger(start) && Number.isInteger(end)) {
    return { filePath, start: start as number, end: end as number };
  }
  return undefined;
}

/**
 * Walk the transcript in order, collecting EVERY tool call (ADR-0086).
 *
 * No tool is dropped for lacking a line range. When `tools` is provided the result is restricted to those tool names;
 * otherwise all tools are captured. `turnIndex` counts assistant messages that
 * carry tool calls, so all calls in one assistant turn share an index.
 */
export function orderedToolCalls(
  messages: readonly ChatMessage[],
  tools?: ReadonlySet<string>,
  opts?: OrderedToolCallsOptions,
): ToolCall[] {
  const out: ToolCall[] = [];
  let turnIndex = -1;
  for (const m of messages) {
    const calls = m.tool_calls;
    if (!Array.isArray(calls)) continue;
    let turnCounted = false;
    for (const tc of calls) {
      if (!tc || typeof tc !== "object") continue;
      const id = (tc as { id?: unknown }).id;
      const fn = (tc as { function?: unknown }).function as
        | { name?: unknown; arguments?: unknown }
        | undefined;
      if (typeof id !== "string" || !fn || typeof fn.name !== "string") continue;
      if (tools && !tools.has(fn.name)) continue;
      if (!turnCounted) {
        turnIndex += 1;
        turnCounted = true;
      }
      const parsed = parseArgs(fn.arguments);
      const malformed = parsed === null && typeof fn.arguments === "string";
      const args = parsed ?? {};
      out.push({
        toolCallId: id,
        tool: fn.name,
        rawArgs: args,
        argHash: hashArgs(fn.name, args, opts?.hashKeys),
        turnIndex,
        ...(malformed ? { malformed: true } : {}),
        ...(readBridge(args) ? { read: readBridge(args) } : {}),
      });
    }
  }
  return out;
}

