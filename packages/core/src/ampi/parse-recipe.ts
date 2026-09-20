/**
 * Parse a ladder recipe string into a built-in name + mode.
 *
 * Policy names AMPI only (ADR-0102 / 0105). Modes ride on the string:
 *   sanitize
 *   sanitize/duplicates | scratch | reasoning | phase | pin
 *   sanitize/reasoning+pin
 *   sweep-duplicates
 *
 * Assist (`supply`) is named in the handbook; it is not a live recipe yet.
 * Unknown names are `ok: false` so save and the live path can refuse them.
 */

import { SANITIZE_WHATS, type SanitizeOptions, type SanitizeWhat } from "./types.js";

export interface ParsedAmpiRecipe {
  readonly ok: boolean;
  readonly name: string;
  readonly sanitize?: SanitizeOptions;
  readonly reason?: "unknown-recipe";
}

const SANITIZE_RE = /^sanitize(?:[/:]([a-z][a-z0-9-]*))?(\+pin)?$/i;

function unknown(raw: string): ParsedAmpiRecipe {
  return { ok: false, name: raw, reason: "unknown-recipe" };
}

export function parseAmpiRecipe(raw: string): ParsedAmpiRecipe {
  const trimmed = raw.trim();
  if (trimmed === "sweep-duplicates") {
    return { ok: true, name: "sweep-duplicates" };
  }
  const match = trimmed.match(SANITIZE_RE);
  if (!match) return unknown(trimmed);
  const whatRaw = match[1]?.toLowerCase();
  const pin = match[2] === "+pin" ? true : undefined;
  if (whatRaw === undefined) {
    return { ok: true, name: "sanitize", sanitize: { what: "duplicates", ...(pin ? { pin } : {}) } };
  }
  if (!(SANITIZE_WHATS as readonly string[]).includes(whatRaw)) {
    return unknown(trimmed);
  }
  return {
    ok: true,
    name: "sanitize",
    sanitize: { what: whatRaw as SanitizeWhat, ...(pin ? { pin } : {}) },
  };
}

/** Live sanitize strings plus the sweep-duplicates alias. */
export function isLiveAmpiRecipe(raw: string): boolean {
  return parseAmpiRecipe(raw).ok;
}
