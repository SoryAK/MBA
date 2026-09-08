/**
 * Compact cut (ADR-0105).
 *
 * Rewrite a finished reasoning span to short residue. Keep the answer.
 * Closed `<think>` blocks and a sibling `reasoning_content` / `reasoning`
 * field are the v1 shapes. An unclosed think (still writing) is left alone.
 * No reasoning found → same `messages[]` reference.
 * Callers (sanitize) must not ask for this cut when reasoning is off
 * (`cm/reasoning.ts`). This cut still no-ops if the transcript has no span.
 */

import type { ChatMessage } from "../chat-message.js";
import { CGC_MARKER_PREFIX } from "./cgc/prune-duplicates.js";
import { readMark } from "./types.js";
import type { CmEditResult } from "./types.js";

export const COMPACT_REASONING_RESIDUE = `${CGC_MARKER_PREFIX} compacted reasoning]]`;

const CLOSED_THINK = /<think\b[^>]*>[\s\S]*?<\/think>/gi;
const THINK_OPEN = /<think\b[^>]*>/gi;
const THINK_CLOSE = /<\/think>/gi;

function asText(content: unknown): string | undefined {
  return typeof content === "string" ? content : undefined;
}

function reasoningField(message: ChatMessage): string | undefined {
  for (const key of ["reasoning_content", "reasoning"] as const) {
    const value = message[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return undefined;
}

function hasUnclosedThink(text: string): boolean {
  const opens = text.match(THINK_OPEN)?.length ?? 0;
  const closes = text.match(THINK_CLOSE)?.length ?? 0;
  THINK_OPEN.lastIndex = 0;
  THINK_CLOSE.lastIndex = 0;
  return opens > closes;
}

function stripClosedThink(text: string): string {
  CLOSED_THINK.lastIndex = 0;
  return text.replace(CLOSED_THINK, "").replace(/^\s+/, "").replace(/\s+$/, "");
}

function withResidue(answer: string): string {
  if (answer.length === 0) return COMPACT_REASONING_RESIDUE;
  if (answer.startsWith(COMPACT_REASONING_RESIDUE)) return answer;
  return `${COMPACT_REASONING_RESIDUE}\n${answer}`;
}

function compactAssistant(message: ChatMessage): ChatMessage | undefined {
  if (message.role !== "assistant") return undefined;
  if (readMark(message) === "pin") return undefined;

  const next: Record<string, unknown> = { ...message };
  let changed = false;
  let text = asText(message.content);

  const field = reasoningField(message);
  if (field !== undefined && text !== undefined && text.trim().length > 0) {
    delete next.reasoning_content;
    delete next.reasoning;
    changed = true;
  }

  if (text !== undefined && !hasUnclosedThink(text)) {
    CLOSED_THINK.lastIndex = 0;
    if (CLOSED_THINK.test(text)) {
      text = stripClosedThink(text);
      changed = true;
    }
  }

  if (!changed) return undefined;
  next.content = withResidue(text ?? "");
  return next as ChatMessage;
}

export function compact(ctx: {
  readonly messages: readonly ChatMessage[];
  readonly target: "reasoning";
}): CmEditResult {
  if (ctx.target !== "reasoning") {
    return { messages: ctx.messages, cut: "compact", progress: 0 };
  }

  let progress = 0;
  const messages = ctx.messages.map((message) => {
    const rewritten = compactAssistant(message);
    if (!rewritten) return message;
    progress += 1;
    return rewritten;
  });

  if (progress === 0) {
    return { messages: ctx.messages, cut: "compact", progress: 0 };
  }
  return { messages, cut: "compact", progress };
}
