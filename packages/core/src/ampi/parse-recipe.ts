/**
 * Parse a ladder recipe string into a built-in name + sanitize mode.
 *
 * Policy names AMPI only (ADR-0102 / 0105). Modes ride on the string:
 *   sanitize
 *   sanitize/duplicates | scratch | reasoning | phase | pin
 *   sanitize/reasoning+pin
 *   sweep-duplicates
 *
 * Unknown names are returned as-is so the engine can no-op.
 */

import { SANITIZE_WHATS, type SanitizeOptions, type SanitizeWhat } from "./types.js";

export interface ParsedAmpiRecipe {
  readonly name: string;
  readonly sanitize?: SanitizeOptions;
}

const SANITIZE_RE = /^sanitize(?:[/:]([a-z][a-z0-9-]*))?(\+pin)?$/i;

export function parseAmpiRecipe(raw: string): ParsedAmpiRecipe {
  const trimmed = raw.trim();
  if (trimmed === "sweep-duplicates") {
    return { name: "sweep-duplicates" };
  }
  const match = trimmed.match(SANITIZE_RE);
  if (!match) return { name: trimmed };
  const whatRaw = match[1]?.toLowerCase();
  const pin = match[2] === "+pin" ? true : undefined;
  if (whatRaw === undefined) {
    return { name: "sanitize", sanitize: { what: "duplicates", ...(pin ? { pin } : {}) } };
  }
  if (!(SANITIZE_WHATS as readonly string[]).includes(whatRaw)) {
    return { name: trimmed };
  }
  return {
    name: "sanitize",
    sanitize: { what: whatRaw as SanitizeWhat, ...(pin ? { pin } : {}) },
  };
}
