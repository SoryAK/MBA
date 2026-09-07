/**
 * Raw-mode interactive input primitives for the `mba` CLI (ADR-0096).
 *
 * Three small, self-contained keypress handlers — no fzf, no readline
 * prompts, just stdin raw mode + ANSI redraw:
 *   - pickModelInteractive — arrow-key menu over models, type-to-filter,
 *     Esc cancels (null)
 *   - pickFieldInteractive — arrow-key menu over dials, type-to-filter,
 *     a trailing "quit" row
 *   - askValueInteractive  — single-line value prompt with a constraint hint
 *
 * These own the "how" of interactive input; `mba.ts` owns the flow (which
 * prompt comes next, what to do with the answer).
 *
 * Paint matches Prismor's wizard: cyan ▸, green ● / dim ○, bold selection.
 */

import {
  HIDE_CURSOR,
  SHOW_CURSOR,
  brand,
  clipLine,
  dim,
  option,
  paint,
  BOLD,
  CYAN,
  RED,
} from "./style.js";

/** Leave raw mode and pause stdin so Node can exit (resume() keeps the loop alive). */
function endInteractive(
  stdin: NodeJS.ReadStream,
  onData: (buf: Buffer) => void,
): void {
  stdin.removeListener("data", onData);
  if (stdin.isTTY) {
    try {
      stdin.setRawMode(false);
    } catch {
      // already cooked
    }
  }
  stdin.pause();
  process.stdout.write(SHOW_CURSOR);
}

/** Redraw a block without eating the lines above it. */
function createMenuFrame(): {
  draw(lines: readonly string[]): void;
  close(opts?: { erase?: boolean }): void;
} {
  let prev = 0;
  return {
    draw(lines) {
      if (prev > 0) process.stdout.write(`\x1b[${prev}A\x1b[J`);
      const clipped = lines.map((line) => clipLine(line));
      process.stdout.write(`${HIDE_CURSOR}${clipped.join("\n")}\n`);
      prev = clipped.length;
    },
    close(opts) {
      if (opts?.erase && prev > 0) {
        process.stdout.write(`\x1b[${prev}A\x1b[J`);
        prev = 0;
      }
      process.stdout.write(SHOW_CURSOR);
    },
  };
}

function clearLine(): void {
  process.stdout.write("\r\x1b[K");
}

// --- Shared types (mirror the service's model-config surface) ---------------

export interface ModelEntry {
  readonly id: string;
  readonly name: string;
  readonly family?: string;
  readonly modelFile?: string;
  readonly loaded: boolean;
}

export interface ModelDial {
  readonly field: string;
  readonly file: "server_setup" | "client";
  readonly current: unknown;
  readonly restartRequired: boolean;
  readonly hint?: string;
  /** Machine-aware constraint hint (e.g. "≤ 8192 RAM"). */
  readonly machineHint?: string;
}

/**
 * Split a raw stdin chunk into logical keys. Escape sequences (arrow keys,
 * etc.) start with `\x1b` and consume the following bytes; everything else is
 * one key per character. A single data event can carry several keys (fast
 * typing, paste, terminal flush), so callers must iterate.
 */
function tokenizeKeys(chunk: string): string[] {
  const keys: string[] = [];
  let i = 0;
  while (i < chunk.length) {
    const ch = chunk.charAt(i);
    if (ch === "\x1b") {
      // Escape sequence: consume until a non-control byte ends it.
      // Arrow keys are ESC [ X (X is a letter); include the final byte.
      let j = i + 1;
      while (j < chunk.length && (chunk.charCodeAt(j) < 0x20 || chunk.charAt(j) === "[")) {
        j++;
      }
      if (j < chunk.length) {
        j++; // include the final letter (e.g. 'C' in ESC [ C)
      }
      keys.push(chunk.slice(i, j));
      i = j;
    } else {
      keys.push(ch);
      i++;
    }
  }
  return keys;
}

// --- Interactive model picker (no fzf — readline keypress) -------------------

export function pickModelInteractive(models: ModelEntry[]): Promise<ModelEntry | null> {
  return new Promise<ModelEntry | null>((resolve, reject) => {
    const stdin = process.stdin;
    const frame = createMenuFrame();
    let query = "";
    let cursor = 0;

    const filtered = () =>
      models.filter(
        (m) =>
          m.id.toLowerCase().includes(query.toLowerCase()) ||
          m.name.toLowerCase().includes(query.toLowerCase()),
      );

    const render = () => {
      const list = filtered();
      const lines = [
        `${brand("models")}  ${dim(query ? `filter: ${query}` : `${models.length} models · type to filter · esc cancel`)}`,
      ];
      if (list.length === 0) {
        lines.push(dim("  (no matches)"));
      } else {
        for (const [i, m] of list.entries()) {
          const extra = `${m.family ? `(${m.family})` : ""}${m.loaded ? "  loaded" : ""}`.trim();
          lines.push(option(i === cursor, m.id, extra));
        }
      }
      frame.draw(lines);
    };

    const finish = (ok: () => void) => {
      endInteractive(stdin, onData);
      frame.close({ erase: true });
      ok();
    };

    const done = (m: ModelEntry | null) => {
      finish(() => resolve(m));
    };

    const handleKey = (key: string): boolean => {
      const list = filtered();
      if (key === "\x1b[A") {
        if (list.length === 0) return false;
        cursor = (cursor - 1 + list.length) % list.length;
        render();
        return false;
      } else if (key === "\x1b[B") {
        if (list.length === 0) return false;
        cursor = (cursor + 1) % list.length;
        render();
        return false;
      } else if (key === "\r" || key === "\n") {
        const pick = list[cursor];
        if (pick) done(pick);
        return Boolean(pick);
      } else if (key === "\x1b") {
        if (query.length > 0) {
          query = "";
          cursor = 0;
          render();
          return false;
        }
        done(null);
        return true;
      } else if (key === "\x7f" || key === "\b") {
        query = query.slice(0, -1);
        cursor = Math.min(cursor, Math.max(0, filtered().length - 1));
        render();
        return false;
      } else if (key === "\x03") {
        finish(() => reject(new Error("cancelled")));
        return true;
      } else if (key.length === 1 && !key.startsWith("\x1b")) {
        query += key;
        cursor = 0;
        render();
        return false;
      }
      return false;
    };

    const onData = (buf: Buffer) => {
      // A single data event may carry multiple characters (e.g. a pasted
      // value or a fast terminal flush); process each one in order.
      for (const key of tokenizeKeys(buf.toString("utf8"))) {
        if (handleKey(key)) return;
      }
    };

    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
    render();
  });
}

// --- Interactive field picker + value prompt ---------------------------------

/**
 * Arrow-key menu over the model's dials, with type-to-filter (mirrors the
 * model picker). A trailing "quit" row exits the guided flow. Returns the
 * picked dial, or null on quit/cancel. Esc clears the filter first, then
 * quits on a second press.
 */
export function pickFieldInteractive(fields: ModelDial[]): Promise<ModelDial | null> {
  return new Promise<ModelDial | null>((resolve, reject) => {
    const stdin = process.stdin;
    const frame = createMenuFrame();
    let query = "";
    let cursor = 0;

    const filtered = (): Array<ModelDial | null> => {
      const matches = fields.filter((f) => f.field.toLowerCase().includes(query.toLowerCase()));
      return query.length > 0 ? matches : [...matches, null];
    };

    const rowText = (f: ModelDial | null, selected: boolean): string => {
      if (f === null) return option(selected, "quit");
      const current = f.current === null ? "(unset)" : String(f.current);
      const restart = f.restartRequired ? "  restart" : "";
      const hint = f.hint ? `  ${f.hint}` : "";
      return option(selected, f.field.padEnd(16), `${current}${restart}${hint}`);
    };

    const render = () => {
      const list = filtered();
      const lines = [
        `${brand("edit")}  ${dim(query ? `filter: ${query}` : "type to filter · q/esc quit")}`,
      ];
      if (list.length === 0) lines.push(dim("  (no matches)"));
      else list.forEach((f, i) => lines.push(rowText(f, i === cursor)));
      frame.draw(lines);
    };

    const finish = (ok: () => void) => {
      endInteractive(stdin, onData);
      frame.close({ erase: true });
      ok();
    };

    const onData = (buf: Buffer) => {
      const key = buf.toString("utf8");
      const list = filtered();
      if (key === "\x1b[A") {
        if (list.length === 0) return;
        cursor = (cursor - 1 + list.length) % list.length;
        render();
      } else if (key === "\x1b[B") {
        if (list.length === 0) return;
        cursor = (cursor + 1) % list.length;
        render();
      } else if (key === "\r" || key === "\n") {
        finish(() => resolve(list[cursor] ?? null));
      } else if (key === "q") {
        finish(() => resolve(null));
      } else if (key === "\x1b") {
        if (query.length > 0) {
          query = "";
          cursor = 0;
          render();
        } else {
          finish(() => resolve(null));
        }
      } else if (key === "\x7f" || key === "\b") {
        query = query.slice(0, -1);
        cursor = Math.min(cursor, Math.max(0, filtered().length - 1));
        render();
      } else if (key === "\x03") {
        finish(() => reject(new Error("cancelled")));
      } else if (key.length === 1 && !key.startsWith("\x1b")) {
        query += key;
        cursor = 0;
        render();
      }
    };

    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
    render();
  });
}

/**
 * Raw-mode value prompt. Enter with an empty input keeps the current value
 * (returns ""); Esc returns null (cancel the edit).
 */
export function askValueInteractive(
  field: string,
  current: string,
  hint?: string,
): Promise<string | null> {
  return new Promise<string | null>((resolve, reject) => {
    const stdin = process.stdin;
    let input = "";
    const hintText = hint ? `  (${hint})` : "";

    const render = () => {
      process.stdout.write(
        `\r\x1b[K  ${paint(field, BOLD, CYAN)} ${dim(`[${current}]${hintText}`)} ${paint("▸", CYAN)} ${input}\x1b[7m \x1b[0m`,
      );
    };

    const done = (value: string | null) => {
      endInteractive(stdin, onData);
      process.stdout.write("\n");
      resolve(value);
    };

    const onData = (buf: Buffer) => {
      const key = buf.toString("utf8");
      if (key === "\r" || key === "\n") {
        done(input);
      } else if (key === "\x1b") {
        done(null);
      } else if (key === "\x7f" || key === "\b") {
        input = input.slice(0, -1);
        render();
      } else if (key === "\x03") {
        endInteractive(stdin, onData);
        process.stdout.write("\n");
        reject(new Error("cancelled"));
      } else if (key.length === 1 && !key.startsWith("\x1b")) {
        input += key;
        render();
      }
    };

    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
    render();
  });
}

/**
 * Raw-mode port prompt. Enter with an empty input keeps the default (returns
 * the default). Esc returns null (cancel). Invalid input (non-numeric, out of
 * 1-65535 range) re-prompts with an error hint.
 */
export function askPortInteractive(
  defaultPort: number,
): Promise<number | null> {
  return new Promise<number | null>((resolve, reject) => {
    const stdin = process.stdin;
    let input = "";
    let error = "";

    const render = () => {
      const errText = error ? `  ${error}` : "";
      process.stdout.write(
        `\r\x1b[K  ${paint("port", BOLD, CYAN)} ${dim(`[${defaultPort}]`)}${errText ? paint(errText, RED) : ""} ${paint("▸", CYAN)} ${input}\x1b[7m \x1b[0m`,
      );
    };

    const done = (value: number | null) => {
      endInteractive(stdin, onData);
      clearLine();
      resolve(value);
    };

    const handleKey = (key: string): boolean => {
      // Returns true when the prompt is done (resolve/reject already called).
      if (key === "\r" || key === "\n") {
        if (input.length === 0) {
          done(defaultPort);
          return true;
        }
        const port = Number(input);
        if (!Number.isInteger(port) || port <= 0 || port > 65535) {
          error = "port must be an integer 1-65535";
          input = ""; // clear so the next attempt starts fresh
          render();
          return false;
        }
        done(port);
        return true;
      } else if (key === "\x1b") {
        done(null);
        return true;
      } else if (key === "\x7f" || key === "\b") {
        input = input.slice(0, -1);
        error = "";
        render();
        return false;
      } else if (key === "\x03") {
        endInteractive(stdin, onData);
        clearLine();
        reject(new Error("cancelled"));
        return true;
      } else if (key.length === 1 && !key.startsWith("\x1b")) {
        input += key;
        error = "";
        render();
        return false;
      }
      return false;
    };

    const onData = (buf: Buffer) => {
      // A single data event may carry multiple characters (e.g. a pasted
      // value or a fast terminal flush); process each one in order.
      for (const key of buf.toString("utf8")) {
        if (handleKey(key)) return;
      }
    };

    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
    render();
  });
}

/**
 * One-line y/N. Enter or `n` is no; `y` is yes; Esc is cancel (`null`).
 * The prompt line is erased so a preview card above it stays the last screen.
 */
export function askYesNoInteractive(prompt: string): Promise<boolean | null> {
  return new Promise<boolean | null>((resolve, reject) => {
    const stdin = process.stdin;
    let input = "";

    const render = () => {
      process.stdout.write(
        `\r\x1b[K  ${paint(prompt, BOLD, CYAN)}  ${dim("[y/N]")} ${paint("▸", CYAN)} ${input}\x1b[7m \x1b[0m`,
      );
    };

    const done = (value: boolean | null) => {
      endInteractive(stdin, onData);
      clearLine();
      resolve(value);
    };

    const onData = (buf: Buffer) => {
      for (const key of tokenizeKeys(buf.toString("utf8"))) {
        if (key === "\r" || key === "\n") {
          const ans = input.trim().toLowerCase();
          done(ans === "y" || ans === "yes");
          return;
        }
        if (key === "\x1b") {
          done(null);
          return;
        }
        if (key === "\x7f" || key === "\b") {
          input = input.slice(0, -1);
          render();
          continue;
        }
        if (key === "\x03") {
          endInteractive(stdin, onData);
          clearLine();
          reject(new Error("cancelled"));
          return;
        }
        if (key.length === 1 && !key.startsWith("\x1b")) {
          input += key;
          render();
        }
      }
    };

    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
    render();
  });
}

// --- Interactive HuggingFace search prompts ----------------------------------

/**
 * Two-phase HuggingFace search prompt.
 *
 * Phase 1 (input): type a query, Enter to search, Esc to cancel, Ctrl-C to
 * abort. Phase 2 (results): arrow-key menu over the returned repos, Enter to
 * pick, Esc to cancel. If the search throws, the error is shown and the prompt
 * returns to phase 1 so the user can retry.
 *
 * `searchFn` is injected so tests can fake the network call.
 */
export function searchHfInteractive(
  searchFn: (
    q: string,
  ) => Promise<Array<{ id: string; downloads?: number; likes?: number }>>,
): Promise<string | null> {
  return new Promise<string | null>((resolve, reject) => {
    const stdin = process.stdin;
    const resultsFrame = createMenuFrame();
    let phase: "input" | "searching" | "results" = "input";
    let query = "";
    let results: Array<{ id: string; downloads?: number; likes?: number }> = [];
    let cursor = 0;

    const cleanup = () => {
      endInteractive(stdin, onData);
      resultsFrame.close({ erase: true });
      clearLine();
    };

    const done = (value: string | null) => {
      cleanup();
      resolve(value);
    };

    const cancel = () => {
      cleanup();
      reject(new Error("cancelled"));
    };

    const renderInput = () => {
      process.stdout.write(
        `\r\x1b[K  ${paint("search", BOLD, CYAN)} ${dim("HuggingFace")} ${paint("▸", CYAN)} ${query}\x1b[7m \x1b[0m`,
      );
    };

    const renderResults = () => {
      const lines = [
        `${brand("search")}  ${dim(`${results.length} for '${query}' · ↑↓ pick · enter · esc`)}`,
      ];
      if (results.length === 0) {
        lines.push(dim("  (no matches)"));
      } else {
        for (const [i, r] of results.entries()) {
          const extra = [
            r.downloads !== undefined ? `↓${r.downloads}` : "",
            r.likes !== undefined ? `♥${r.likes}` : "",
          ]
            .filter(Boolean)
            .join("  ");
          lines.push(option(i === cursor, r.id, extra));
        }
      }
      resultsFrame.draw(lines);
    };

    const startSearch = async () => {
      phase = "searching";
      process.stdout.write(`\r\x1b[K  ${dim(`searching HuggingFace for '${query}'…`)}\n`);
      try {
        results = await searchFn(query);
      } catch (err) {
        phase = "input";
        process.stdout.write(
          `\r\x1b[K  ${paint("search failed", RED)} ${dim(err instanceof Error ? err.message : String(err))}\n`,
        );
        renderInput();
        return;
      }
      phase = "results";
      cursor = 0;
      renderResults();
    };

    const onData = (buf: Buffer) => {
      for (const key of tokenizeKeys(buf.toString("utf8"))) {
        if (phase === "input") {
          if (key === "\r" || key === "\n") {
            if (query.length === 0) continue;
            void startSearch();
            return;
          } else if (key === "\x1b") {
            done(null);
            return;
          } else if (key === "\x03") {
            cancel();
            return;
          } else if (key === "\x7f" || key === "\b") {
            query = query.slice(0, -1);
            renderInput();
          } else if (key.length === 1 && !key.startsWith("\x1b")) {
            query += key;
            renderInput();
          }
        } else if (phase === "searching") {
          // Ignore keys while the search is in flight.
          continue;
        } else if (phase === "results") {
          if (key === "\x1b[A") {
            if (results.length === 0) continue;
            cursor = (cursor - 1 + results.length) % results.length;
            renderResults();
          } else if (key === "\x1b[B") {
            if (results.length === 0) continue;
            cursor = (cursor + 1) % results.length;
            renderResults();
          } else if (key === "\r" || key === "\n") {
            const pick = results[cursor];
            if (pick) done(pick.id);
            return;
          } else if (key === "\x1b") {
            done(null);
            return;
          } else if (key === "\x03") {
            cancel();
            return;
          }
        }
      }
    };

    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
    renderInput();
  });
}

/**
 * Arrow-key menu over labeled items. Enter resolves the picked item's `value`;
 * Esc resolves null. Used for the quant picker in the `mba pull search` flow.
 */
export function pickLabeledInteractive(
  title: string,
  items: Array<{ label: string; value: string }>,
): Promise<string | null> {
  return new Promise<string | null>((resolve, reject) => {
    const stdin = process.stdin;
    const frame = createMenuFrame();
    let cursor = 0;

    const render = () => {
      const lines = [`${brand(title)}  ${dim("↑↓ pick · enter · esc")}`];
      if (items.length === 0) lines.push(dim("  (none)"));
      else items.forEach((it, i) => lines.push(option(i === cursor, it.label)));
      frame.draw(lines);
    };

    const finish = (ok: () => void) => {
      endInteractive(stdin, onData);
      frame.close({ erase: true });
      ok();
    };

    const onData = (buf: Buffer) => {
      for (const key of tokenizeKeys(buf.toString("utf8"))) {
        if (key === "\x1b[A") {
          if (items.length === 0) continue;
          cursor = (cursor - 1 + items.length) % items.length;
          render();
        } else if (key === "\x1b[B") {
          if (items.length === 0) continue;
          cursor = (cursor + 1) % items.length;
          render();
        } else if (key === "\r" || key === "\n") {
          const pick = items[cursor];
          if (pick) finish(() => resolve(pick.value));
          return;
        } else if (key === "\x1b") {
          finish(() => resolve(null));
          return;
        } else if (key === "\x03") {
          finish(() => reject(new Error("cancelled")));
          return;
        }
      }
    };

    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
    render();
  });
}

/**
 * Raw-mode text prompt. Enter with an empty input returns `defaultValue`;
 * otherwise returns the typed text. Esc returns null (cancel).
 */
export function askTextInteractive(
  field: string,
  defaultValue: string,
): Promise<string | null> {
  return new Promise<string | null>((resolve, reject) => {
    const stdin = process.stdin;
    let input = "";

    const render = () => {
      process.stdout.write(
        `\r\x1b[K  ${paint(field, BOLD, CYAN)} ${dim(`[${defaultValue}]`)} ${paint("▸", CYAN)} ${input}\x1b[7m \x1b[0m`,
      );
    };

    const done = (value: string | null) => {
      endInteractive(stdin, onData);
      process.stdout.write("\n");
      resolve(value);
    };

    const onData = (buf: Buffer) => {
      for (const key of tokenizeKeys(buf.toString("utf8"))) {
        if (key === "\r" || key === "\n") {
          done(input.length === 0 ? defaultValue : input);
          return;
        } else if (key === "\x1b") {
          done(null);
          return;
        } else if (key === "\x7f" || key === "\b") {
          input = input.slice(0, -1);
          render();
        } else if (key === "\x03") {
          endInteractive(stdin, onData);
          process.stdout.write("\n");
          reject(new Error("cancelled"));
          return;
        } else if (key.length === 1 && !key.startsWith("\x1b")) {
          input += key;
          render();
        }
      }
    };

    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
    render();
  });
}

// --- Interactive server picker + action menu ---------------------------------

/** One row of GET /servers, as shown by the interactive picker. */
export interface ServerRow {
  readonly id: string;
  readonly port: number;
  readonly pid?: number;
  readonly healthy: boolean;
  readonly modelFile: string;
}

export type ServerAction = "stop" | "logs";

export interface ServerSelection {
  readonly server: ServerRow;
  readonly action: ServerAction;
}

/**
 * Two-stage raw-mode picker over running servers (ADR-0096): an arrow-key
 * menu with type-to-filter, then an action menu for the picked server.
 * Enter on a server opens its action menu; `back` (or Esc) returns to the
 * list. Esc on the list resolves null (cancel); Ctrl-C rejects.
 */
export function pickServerInteractive(
  servers: ServerRow[],
): Promise<ServerSelection | null> {
  return new Promise<ServerSelection | null>((resolve, reject) => {
    const stdin = process.stdin;
    const frame = createMenuFrame();
    let stage: "list" | "actions" = "list";
    let query = "";
    let cursor = 0;
    let listCursor = 0;
    let selected: ServerRow | null = null;

    const filtered = () =>
      servers.filter(
        (s) =>
          s.id.toLowerCase().includes(query.toLowerCase()) ||
          String(s.port).includes(query) ||
          s.modelFile.toLowerCase().includes(query.toLowerCase()),
      );

    const actionRows = (): readonly ["stop", "logs", "back"] => ["stop", "logs", "back"];

    const serverRow = (s: ServerRow, selectedRow: boolean): string => {
      const pid = s.pid !== undefined ? String(s.pid) : "-";
      const health = s.healthy ? "ok" : "down";
      return option(selectedRow, s.id.padEnd(18), `${s.port}  ${pid}  ${health}  ${s.modelFile}`);
    };

    const render = () => {
      if (stage === "list") {
        const list = filtered();
        const lines = [
          `${brand("servers")}  ${dim(`${servers.length} running · ${query ? `filter: ${query}` : "type to filter"} · esc quit`)}`,
        ];
        if (list.length === 0) lines.push(dim("  (no matches)"));
        else list.forEach((s, i) => lines.push(serverRow(s, i === cursor)));
        frame.draw(lines);
      } else {
        const rows = actionRows();
        const lines = [`${brand("actions")}  ${dim(`${selected?.id} · port ${selected?.port}`)}`];
        for (const [i, a] of rows.entries()) {
          const label =
            a === "stop"
              ? `stop ${selected?.id}`
              : a === "logs"
                ? `logs ${selected?.id}`
                : "back";
          lines.push(option(i === cursor, label));
        }
        frame.draw(lines);
      }
    };

    const finish = (ok: () => void) => {
      endInteractive(stdin, onData);
      frame.close({ erase: true });
      ok();
    };

    const done = (sel: ServerSelection | null) => {
      finish(() => resolve(sel));
    };

    const cancel = () => {
      finish(() => reject(new Error("cancelled")));
    };

    const handleKey = (key: string): boolean => {
      // Returns true when the prompt is done (resolve/reject already called).
      if (key === "\x03") {
        cancel();
        return true;
      }
      if (stage === "list") {
        const list = filtered();
        if (key === "\x1b[A") {
          if (list.length === 0) return false;
          cursor = (cursor - 1 + list.length) % list.length;
          render();
        } else if (key === "\x1b[B") {
          if (list.length === 0) return false;
          cursor = (cursor + 1) % list.length;
          render();
        } else if (key === "\r" || key === "\n") {
          const pick = list[cursor];
          if (!pick) return false;
          selected = pick;
          listCursor = cursor;
          stage = "actions";
          cursor = 0;
          render();
        } else if (key === "\x1b") {
          done(null);
          return true;
        } else if (key === "\x7f" || key === "\b") {
          query = query.slice(0, -1);
          cursor = Math.min(cursor, Math.max(0, filtered().length - 1));
          render();
        } else if (key.length === 1 && !key.startsWith("\x1b")) {
          query += key;
          cursor = 0;
          render();
        }
        return false;
      }
      // actions stage
      const rows = actionRows();
      if (key === "\x1b[A") {
        cursor = (cursor - 1 + rows.length) % rows.length;
        render();
      } else if (key === "\x1b[B") {
        cursor = (cursor + 1) % rows.length;
        render();
      } else if (key === "\r" || key === "\n") {
        const pick = rows[cursor];
        if (pick === "stop" && selected) {
          done({ server: selected, action: "stop" });
          return true;
        }
        if (pick === "logs" && selected) {
          done({ server: selected, action: "logs" });
          return true;
        }
        stage = "list"; // "back" — restore the list position
        cursor = listCursor;
        render();
      } else if (key === "\x1b") {
        stage = "list";
        cursor = listCursor;
        render();
      }
      return false;
    };

    const onData = (buf: Buffer) => {
      // A single data event may carry multiple characters (e.g. a pasted
      // filter or a fast terminal flush); process each one in order.
      for (const key of tokenizeKeys(buf.toString("utf8"))) {
        if (handleKey(key)) return;
      }
    };

    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
    render();
  });
}
