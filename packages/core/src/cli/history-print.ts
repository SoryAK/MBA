/**
 * TTY for the per-model tool + trip ledger. Facts only — not a debugger.
 */

import type { ModelHistoryEvent } from "./types.js";
import { brand, dim, paint, BOLD, YEL } from "./style.js";

export function formatHistoryTime(ts: number): string {
  const iso = new Date(ts).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)}Z`;
}

export function formatHistoryEventLine(event: ModelHistoryEvent): string {
  const time = dim(formatHistoryTime(event.ts));
  const kind = event.kind === "trip" ? paint("trip", YEL) : dim("tool");
  const name = event.kind === "trip" && event.rule.length > 0 ? event.rule : event.tool;
  const tier = event.tier.length > 0 ? `  ${event.tier}` : "";
  const harness = event.harness.length > 0 ? dim(`  ${event.harness}`) : "";
  return `    ${time}  ${kind}  ${paint(name, BOLD)}${tier}${harness}`;
}

export function formatHistoryLines(
  modelId: string,
  events: readonly ModelHistoryEvent[],
): string[] {
  const lines = [`${brand("history")}  ${paint(modelId, BOLD)}`];
  if (events.length === 0) {
    lines.push(`    ${dim("none")}`);
    return lines;
  }
  for (const event of events) lines.push(formatHistoryEventLine(event));
  return lines;
}
