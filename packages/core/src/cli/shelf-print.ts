/**
 * TTY for the operator markdown shelf (notes / instructions paths).
 * Notes are never injected; this file only paints.
 */

import { dim, heading, kv, shortenHome } from "./style.js";

export interface ShelfCardView {
  readonly path: string;
  readonly source: "model" | "family";
  readonly empty?: boolean;
  readonly text?: string;
}

export function formatShelfPathRow(label: string, card: ShelfCardView): string {
  return kv(label, `${shortenHome(card.path)}  ${dim(card.source)}`, 12);
}

export function formatNotesSection(card: ShelfCardView): string[] {
  const lines = [`  ${heading("notes")}`];
  if (card.empty || !card.text) {
    lines.push(`    ${dim("empty")}`);
  } else {
    for (const line of card.text.split(/\r?\n/)) {
      lines.push(`    ${line}`);
    }
  }
  lines.push("");
  return lines;
}

export function notesPreviewRow(
  notes?: { readonly empty: boolean; readonly excerpt?: string },
): readonly [string, string] | undefined {
  if (!notes) return undefined;
  if (notes.empty || !notes.excerpt) return ["notes", "empty"];
  return ["notes", notes.excerpt];
}
