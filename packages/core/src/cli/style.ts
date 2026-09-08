/**
 * Terminal paint — same vocabulary as Prismor's setup wizard.
 * No extra deps. Colors only on a TTY (honors NO_COLOR).
 */

import { homedir } from "node:os";

export const RST = "\x1b[0m";
export const BOLD = "\x1b[1m";
/** Light gray, matching Prismor's DIM (not faint/2). */
export const DIM = "\x1b[37m";
export const CYAN = "\x1b[36m";
export const GRN = "\x1b[32m";
export const YEL = "\x1b[33m";
export const RED = "\x1b[31m";

export function colorEnabled(): boolean {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return process.stdout.isTTY === true;
}

export function paint(text: string, ...codes: string[]): string {
  if (!colorEnabled() || codes.length === 0) return text;
  return `${codes.join("")}${text}${RST}`;
}

/** `MBA · models` */
export function brand(subtitle?: string): string {
  const name = paint("MBA", BOLD, CYAN);
  if (!subtitle) return ` ${name}`;
  return ` ${name}${paint(` · ${subtitle}`, DIM)}`;
}

export function rule(width = 40): string {
  return paint(` ${"─".repeat(width)}`, DIM);
}

/** Selected: cyan ▸ + green ● + bold name. Idle: dim ○ + dim name. */
export function option(selected: boolean, name: string, desc = ""): string {
  const arrow = selected ? paint("▸ ", CYAN) : "  ";
  const dot = selected ? paint("●", GRN) : paint("○", DIM);
  const label = selected ? paint(name, BOLD) : paint(name, DIM);
  const extra = desc ? paint(`  ${desc}`, DIM) : "";
  return ` ${arrow}${dot} ${label}${extra}`;
}

/** `↑↓ move · type filter · enter pick` */
export function keys(items: ReadonlyArray<readonly [string, string]>): string {
  return (
    " " +
    items
      .map(([k, d]) => paint(k, BOLD, CYAN) + paint(` ${d}`, DIM))
      .join(paint(" · ", DIM))
  );
}

export function dim(text: string): string {
  return paint(text, DIM);
}

export function heading(text: string): string {
  return paint(text, BOLD, CYAN);
}

/** `  model   qwen3-coder-30b` — labeled row for status / preview cards. */
export function kv(key: string, value: string, keyWidth = 8): string {
  return `  ${paint(key.padEnd(keyWidth), BOLD)}  ${value}`;
}

/** Replace `$HOME/` with `~/` so store paths fit a terminal. */
export function shortenHome(path: string): string {
  const home = homedir();
  if (home.length > 0 && (path === home || path.startsWith(`${home}/`))) {
    return `~${path.slice(home.length)}`;
  }
  return path;
}

/**
 * Prismor-style confirm box. Sized to the content, capped at the terminal
 * width. Long values ellipsize so the right edge stays a straight line.
 */
export function doneBox(title: string, rows: ReadonlyArray<readonly [string, string]>): string {
  const inner = rows.map(([k, v]) => `${k.padEnd(8)}${v}`);
  const longest = Math.max(visibleLen(title), ...inner.map((line) => visibleLen(line)));
  // Dash count: one gutter space after │ plus the content. Cap to the
  // terminal so a long path cannot shove the right border off-screen.
  const cap = Math.max(24, termCols() - 3);
  const width = Math.min(cap, Math.max(24, longest + 3));
  const content = width - 1;
  const top = paint(` ╭${"─".repeat(width)}╮`, DIM);
  const bot = paint(` ╰${"─".repeat(width)}╯`, DIM);
  const cell = (text: string, style: string[] = [DIM]) => {
    const shown = clipEllipsis(text, content);
    const pad = " ".repeat(Math.max(0, content - visibleLen(shown)));
    return `${paint(" │", DIM)} ${paint(shown, ...style)}${pad}${paint("│", DIM)}`;
  };
  return [
    top,
    cell(title, [BOLD, CYAN]),
    ...inner.map((line) => cell(line)),
    bot,
  ].join("\n");
}

export const HIDE_CURSOR = "\x1b[?25l";
export const SHOW_CURSOR = "\x1b[?25h";

export function visibleLen(text: string): number {
  return [...text.replace(/\x1b\[[0-9;]*m/g, "")].length;
}

export function termCols(): number {
  const cols = process.stdout.columns;
  return cols && cols > 0 ? cols : 80;
}

function clipEllipsis(text: string, width: number): string {
  if (visibleLen(text) <= width) return text;
  if (width <= 1) return clipLine(text, width);
  return `${clipLine(text, width - 1)}…`;
}

/** Keep a painted line on one terminal row so redraw math stays honest. */
export function clipLine(text: string, width = Math.max(termCols() - 1, 20)): string {
  if (visibleLen(text) <= width) return text;
  let out = "";
  let vis = 0;
  let i = 0;
  while (i < text.length) {
    if (text.charCodeAt(i) === 0x1b) {
      const m = text.slice(i).match(/^\x1b\[[0-9;]*m/);
      if (m) {
        out += m[0];
        i += m[0].length;
        continue;
      }
    }
    if (vis >= width) break;
    out += text.charAt(i);
    vis += 1;
    i += 1;
  }
  return colorEnabled() ? `${out}${RST}` : out;
}
