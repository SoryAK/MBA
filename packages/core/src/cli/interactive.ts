/**
 * Raw-mode interactive input primitives for the `mba` CLI (ADR-0096).
 *
 * Menus share one chrome: a bordered list on the left and a kv preview on
 * the right (search, home, models, servers, machine, builds). One-line
 * prompts (value, port, yes/no, text) stay a single row.
 *
 * These own the "how" of interactive input; `mba.ts` owns the flow.
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
  previewBox,
  shortenHome,
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

const PREVIEW_LIST_WINDOW = 8;

function sliceWindow<T>(
  items: readonly T[],
  cursor: number,
  size: number,
): { items: T[]; start: number } {
  if (items.length <= size) return { items: [...items], start: 0 };
  const start = Math.min(
    Math.max(0, cursor - Math.floor((size - 1) / 2)),
    items.length - size,
  );
  return { items: items.slice(start, start + size), start };
}

export interface PreviewPickItem {
  readonly label: string;
  readonly value: string;
  readonly preview: ReadonlyArray<readonly [string, string]>;
}

function matchesQuery(it: PreviewPickItem, q: string): boolean {
  const n = q.toLowerCase();
  if (it.label.toLowerCase().includes(n) || it.value.toLowerCase().includes(n)) return true;
  return it.preview.some(([, v]) => v.toLowerCase().includes(n));
}

function previewPickLines(
  title: string,
  filter: string,
  allCount: number,
  list: readonly PreviewPickItem[],
  cursor: number,
  marked?: ReadonlySet<string>,
): string[] {
  const win = sliceWindow(list, cursor, PREVIEW_LIST_WINDOW);
  const left =
    win.items.length === 0
      ? [dim("  (no matches)")]
      : win.items.map((it, i) =>
          option(win.start + i === cursor, it.label, "", marked?.has(it.value)),
        );
  const current = list[cursor];
  const count =
    marked !== undefined ? `${marked.size} sel · ${list.length}/${allCount}` : `${list.length}/${allCount}`;
  return previewBox({
    title,
    detail: filter
      ? `filter: ${filter}`
      : marked !== undefined
        ? "space toggle · enter adopt"
        : undefined,
    count,
    left,
    preview: current?.preview ?? [],
  });
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
  return pickPreviewInteractive(
    "models",
    models.map((m) => ({
      label: m.id,
      value: m.id,
      preview: [
        ["id", m.id],
        ["name", m.name],
        ["family", m.family ?? "—"],
        ["loaded", m.loaded ? "yes" : "no"],
        ["file", m.modelFile ? shortenHome(m.modelFile) : "—"],
      ],
    })),
  ).then((id) => (id === null ? null : (models.find((m) => m.id === id) ?? null)));
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

    const rowItem = (f: ModelDial | null): PreviewPickItem => {
      if (f === null) {
        return { label: "quit", value: "quit", preview: [["do", "leave this model"]] };
      }
      const preview: Array<readonly [string, string]> = [
        ["field", f.field],
        ["file", f.file],
        ["value", f.current === null ? "(unset)" : String(f.current)],
        ["restart", f.restartRequired ? "needed" : "no"],
      ];
      if (f.hint) preview.push(["hint", f.hint]);
      if (f.machineHint) preview.push(["machine", f.machineHint]);
      return { label: f.field, value: f.field, preview };
    };

    const render = () => {
      const list = filtered();
      const items = list.map(rowItem);
      frame.draw(previewPickLines(brand("edit"), query, fields.length + 1, items, cursor));
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
    let resultFilter = "";
    let results: Array<{ id: string; downloads?: number; likes?: number }> = [];
    let cursor = 0;

    const asItems = (): PreviewPickItem[] =>
      results.map((r) => ({
        label: r.id,
        value: r.id,
        preview: [
          ["repo", r.id],
          ["↓", r.downloads !== undefined ? r.downloads.toLocaleString() : "—"],
          ["♥", r.likes !== undefined ? r.likes.toLocaleString() : "—"],
        ],
      }));

    const filteredItems = (): PreviewPickItem[] => {
      const items = asItems();
      if (!resultFilter) return items;
      return items.filter((it) => matchesQuery(it, resultFilter));
    };

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
      const list = filteredItems();
      resultsFrame.draw(
        previewPickLines(brand("search"), resultFilter, results.length, list, cursor),
      );
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
      resultFilter = "";
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
          const list = filteredItems();
          if (key === "\x1b[A") {
            if (list.length === 0) continue;
            cursor = (cursor - 1 + list.length) % list.length;
            renderResults();
          } else if (key === "\x1b[B") {
            if (list.length === 0) continue;
            cursor = (cursor + 1) % list.length;
            renderResults();
          } else if (key === "\r" || key === "\n") {
            const pick = list[cursor];
            if (pick) done(pick.value);
            return;
          } else if (key === "\x1b") {
            if (resultFilter.length > 0) {
              resultFilter = "";
              cursor = 0;
              renderResults();
              continue;
            }
            done(null);
            return;
          } else if (key === "\x7f" || key === "\b") {
            resultFilter = resultFilter.slice(0, -1);
            cursor = Math.min(cursor, Math.max(0, filteredItems().length - 1));
            renderResults();
          } else if (key === "\x03") {
            cancel();
            return;
          } else if (key.length === 1 && !key.startsWith("\x1b")) {
            resultFilter += key;
            cursor = 0;
            renderResults();
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
 * Arrow-key menu over labeled items. Same two-pane chrome as search:
 * list on the left, a short preview on the right. Optional `preview` rows
 * per item; otherwise the label is shown. First Esc clears an active filter.
 */
export function pickLabeledInteractive(
  title: string,
  items: Array<{
    label: string;
    value: string;
    preview?: ReadonlyArray<readonly [string, string]>;
  }>,
  opts?: { selectedValue?: string },
): Promise<string | null> {
  return pickPreviewInteractive(
    title,
    items.map((it) => ({
      label: it.label,
      value: it.value,
      preview: it.preview ?? [["do", it.label]],
    })),
    opts,
  );
}

/**
 * Arrow-key menu with an fzf-style list + preview pane. Type-to-filter;
 * first Esc clears the filter. Enter resolves `value`; Esc resolves null.
 */
export function pickPreviewInteractive(
  title: string,
  items: readonly PreviewPickItem[],
  opts?: { selectedValue?: string },
): Promise<string | null> {
  return new Promise<string | null>((resolve, reject) => {
    const stdin = process.stdin;
    const frame = createMenuFrame();
    const selectedAt = opts?.selectedValue
      ? items.findIndex((it) => it.value === opts.selectedValue)
      : 0;
    let query = "";
    let cursor = selectedAt >= 0 ? selectedAt : 0;

    const filtered = () => (query ? items.filter((it) => matchesQuery(it, query)) : items);

    const resetCursor = () => {
      if (!query && selectedAt >= 0) {
        cursor = selectedAt;
        return;
      }
      cursor = 0;
    };

    const render = () => {
      frame.draw(previewPickLines(brand(title), query, items.length, filtered(), cursor));
    };

    const finish = (ok: () => void) => {
      endInteractive(stdin, onData);
      frame.close({ erase: true });
      ok();
    };

    const onData = (buf: Buffer) => {
      for (const key of tokenizeKeys(buf.toString("utf8"))) {
        const list = filtered();
        if (key === "\x1b[A") {
          if (list.length === 0) continue;
          cursor = (cursor - 1 + list.length) % list.length;
          render();
        } else if (key === "\x1b[B") {
          if (list.length === 0) continue;
          cursor = (cursor + 1) % list.length;
          render();
        } else if (key === "\r" || key === "\n") {
          const pick = list[cursor];
          if (!pick) continue;
          finish(() => resolve(pick.value));
          return;
        } else if (key === "\x1b") {
          if (query.length > 0) {
            query = "";
            resetCursor();
            render();
            continue;
          }
          finish(() => resolve(null));
          return;
        } else if (key === "\x7f" || key === "\b") {
          query = query.slice(0, -1);
          if (!query && selectedAt >= 0) cursor = selectedAt;
          else cursor = Math.min(cursor, Math.max(0, filtered().length - 1));
          render();
        } else if (key === "\x03") {
          finish(() => reject(new Error("cancelled")));
          return;
        } else if (key.length === 1 && !key.startsWith("\x1b")) {
          query += key;
          cursor = 0;
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

/**
 * Multi-select sibling of `pickPreviewInteractive`. Space toggles the
 * current row (does not add to the filter). Enter confirms the marked
 * set; if nothing is marked, the highlighted row is adopted. Esc clears
 * the filter first, then cancels.
 */
export function pickManyInteractive(
  title: string,
  items: readonly PreviewPickItem[],
  opts?: { marked?: readonly string[] },
): Promise<string[] | null> {
  return new Promise<string[] | null>((resolve, reject) => {
    const stdin = process.stdin;
    const frame = createMenuFrame();
    let query = "";
    let cursor = 0;
    const marked = new Set(opts?.marked ?? []);

    const filtered = () => (query ? items.filter((it) => matchesQuery(it, query)) : items);

    const render = () => {
      frame.draw(previewPickLines(brand(title), query, items.length, filtered(), cursor, marked));
    };

    const finish = (ok: () => void) => {
      endInteractive(stdin, onData);
      frame.close({ erase: true });
      ok();
    };

    const onData = (buf: Buffer) => {
      for (const key of tokenizeKeys(buf.toString("utf8"))) {
        const list = filtered();
        if (key === "\x1b[A") {
          if (list.length === 0) continue;
          cursor = (cursor - 1 + list.length) % list.length;
          render();
        } else if (key === "\x1b[B") {
          if (list.length === 0) continue;
          cursor = (cursor + 1) % list.length;
          render();
        } else if (key === " ") {
          const row = list[cursor];
          if (!row) continue;
          if (marked.has(row.value)) marked.delete(row.value);
          else marked.add(row.value);
          render();
        } else if (key === "\r" || key === "\n") {
          const chosen =
            marked.size > 0
              ? items.filter((it) => marked.has(it.value)).map((it) => it.value)
              : list[cursor]
                ? [list[cursor]!.value]
                : [];
          if (chosen.length === 0) continue;
          finish(() => resolve(chosen));
          return;
        } else if (key === "\x1b") {
          if (query.length > 0) {
            query = "";
            cursor = 0;
            render();
            continue;
          }
          finish(() => resolve(null));
          return;
        } else if (key === "\x7f" || key === "\b") {
          query = query.slice(0, -1);
          cursor = Math.min(cursor, Math.max(0, filtered().length - 1));
          render();
        } else if (key === "\x03") {
          finish(() => reject(new Error("cancelled")));
          return;
        } else if (key.length === 1 && !key.startsWith("\x1b")) {
          query += key;
          cursor = 0;
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

    const render = () => {
      if (stage === "list") {
        const list = filtered();
        const items: PreviewPickItem[] = list.map((s) => ({
          label: s.id,
          value: s.id,
          preview: [
            ["id", s.id],
            ["port", String(s.port)],
            ["pid", s.pid !== undefined ? String(s.pid) : "—"],
            ["health", s.healthy ? "ok" : "down"],
            ["model", s.modelFile],
          ],
        }));
        frame.draw(previewPickLines(brand("servers"), query, servers.length, items, cursor));
      } else {
        const rows = actionRows();
        const items: PreviewPickItem[] = rows.map((a) => ({
          label: a,
          value: a,
          preview:
            a === "stop"
              ? [
                  ["do", `stop ${selected?.id ?? ""}`],
                  ["port", String(selected?.port ?? "")],
                ]
              : a === "logs"
                ? [["do", `follow logs for ${selected?.id ?? ""}`]]
                : [["do", "back to the server list"]],
        }));
        frame.draw(previewPickLines(brand("actions"), "", rows.length, items, cursor));
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
