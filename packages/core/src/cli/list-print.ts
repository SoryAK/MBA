/**
 * Shared TTY rows for lists (status, servers, models, registered clients).
 * JSON payloads stay on the command modules.
 */

import { harnessKind } from "../service/env-context.js";
import { dim, paint, shortenHome, BOLD, GRN, RED } from "./style.js";

export function formatServerLine(s: {
  readonly id: string;
  readonly port: number;
  readonly pid?: number;
  readonly healthy: boolean;
  readonly modelFile: string;
}): string {
  const health = s.healthy ? paint("ok", GRN) : paint("down", RED);
  const pid = s.pid !== undefined ? String(s.pid) : "-";
  return `    ${paint(s.id.padEnd(18), BOLD)}  ${String(s.port).padEnd(5)}  ${pid.padEnd(7)}  ${health}  ${dim(shortenHome(s.modelFile))}`;
}

export function formatModelLine(m: {
  readonly id: string;
  readonly family?: string;
  readonly loaded?: boolean;
}): string {
  const tag = (m.loaded ? "loaded" : "·").padEnd(6);
  const painted = m.loaded ? paint(tag, GRN) : dim(tag);
  const family = m.family ? dim(`  ${m.family}`) : "";
  return `    ${paint(m.id.padEnd(22), BOLD)}  ${painted}${family}`;
}

/** Catalog row: same header grammar as a paired slot (name, kind, file). */
export function formatRegisteredClientLine(h: {
  readonly name: string;
  readonly envelope: string;
  readonly source?: "built-in" | "added";
}): string {
  const extra = h.source === "added" ? "  · added" : "";
  return `    ${paint(h.name, BOLD)}  ${dim(harnessKind(h.name))}${extra}   ${dim(h.envelope)}`;
}