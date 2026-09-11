/**
 * Rank families already in the hub so migrate/pull can suggest one.
 *
 * The CLI lists; it does not create a family here. Empty hub → no suggestion.
 */

import { fuzzyScore } from "./gguf-scan.js";

/** Picker value for "type a new family". Not a legal store slug (`*`). */
export const NEW_FAMILY = "*new";

export interface HubFamily {
  readonly name: string;
  readonly models: number;
}

export function listHubFamilies(
  models: readonly { readonly family?: string }[],
): HubFamily[] {
  const counts = new Map<string, number>();
  for (const m of models) {
    const name = m.family?.trim();
    if (!name) continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, models]) => ({ name, models }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Score one family against needles (id, filename, GGUF name, HF owner/repo). */
export function familyMatchScore(family: string, needle: string): number {
  const f = family.toLowerCase();
  const n = needle.toLowerCase().trim();
  if (!n) return 0;
  if (f === n) return 1_000_000;
  if (f.startsWith(n) || n.startsWith(f)) {
    return 100_000 + Math.min(f.length, n.length);
  }
  return Math.max(fuzzyScore(f, n), fuzzyScore(n, f));
}

function bestScore(family: string, needles: readonly string[]): number {
  let best = 0;
  for (const needle of needles) {
    best = Math.max(best, familyMatchScore(family, needle));
  }
  return best;
}

/** Highest-scoring existing family, or undefined when nothing matches. */
export function suggestFamily(
  needles: readonly string[],
  families: readonly HubFamily[],
): string | undefined {
  if (families.length === 0) return undefined;
  let best: { name: string; score: number } | undefined;
  for (const row of families) {
    const score = bestScore(row.name, needles);
    if (
      !best ||
      score > best.score ||
      (score === best.score && row.name.localeCompare(best.name) < 0)
    ) {
      best = { name: row.name, score };
    }
  }
  if (!best || best.score <= 0) return undefined;
  return best.name;
}

/** Closest families first so the picker opens on the suggestion. */
export function rankHubFamilies(
  families: readonly HubFamily[],
  needles: readonly string[],
): HubFamily[] {
  return [...families].sort((a, b) => {
    const diff = bestScore(b.name, needles) - bestScore(a.name, needles);
    if (diff !== 0) return diff;
    return a.name.localeCompare(b.name);
  });
}
