/**
 * TTY grouping for paired sessions: one slot (app + file), then models.
 *
 * JSON still has harness / ide / card / envelope / projectRoot per session.
 */

import { extraIde, harnessKind } from "../service/env-context.js";
import { dim, paint, shortenHome, BOLD, GRN } from "./style.js";
import type { PairingSession } from "./types.js";

interface SlotGroup {
  readonly harness: string;
  readonly ide?: string;
  readonly envelope: string;
  readonly projectRoot: string;
  readonly models: PairingSession[];
}

function slotKey(s: PairingSession): string {
  return `${s.harness}\0${s.projectRoot}\0${s.envelope ?? ""}`;
}

export function groupPairedSlots(sessions: readonly PairingSession[]): SlotGroup[] {
  const order: string[] = [];
  const byKey = new Map<string, SlotGroup>();
  for (const s of sessions) {
    const key = slotKey(s);
    const existing = byKey.get(key);
    if (existing) {
      existing.models.push(s);
      continue;
    }
    order.push(key);
    byKey.set(key, {
      harness: s.harness,
      ide: s.ide,
      envelope: s.envelope ?? "",
      projectRoot: s.projectRoot,
      models: [s],
    });
  }
  return order.map((key) => {
    const g = byKey.get(key)!;
    const models = [...g.models].sort((a, b) => {
      if (Boolean(a.card) !== Boolean(b.card)) return a.card ? -1 : 1;
      return a.modelId.localeCompare(b.modelId);
    });
    return { ...g, models };
  });
}

function headerLine(g: SlotGroup): string {
  const kind = harnessKind(g.harness);
  const extra = extraIde(g.harness, g.ide);
  const extraBit = extra ? `  · ${extra}` : "";
  const file = g.envelope.length > 0 ? g.envelope : "—";
  return `    ${paint(g.harness, BOLD)}  ${dim(kind)}${extraBit}   ${dim(file)}`;
}

function modelLine(s: PairingSession): string {
  const tag = (s.card ? "card" : "pair").padEnd(4);
  const painted = s.card ? paint(tag, GRN) : dim(tag);
  return `      ${s.modelId.padEnd(22)}  ${painted}  ${dim(shortenHome(s.projectRoot))}`;
}

/** Lines for status / clients TTY. Empty list → caller prints none. */
export function formatPairedSlotLines(sessions: readonly PairingSession[]): string[] {
  const lines: string[] = [];
  for (const g of groupPairedSlots(sessions)) {
    lines.push(headerLine(g));
    for (const m of g.models) lines.push(modelLine(m));
  }
  return lines;
}
