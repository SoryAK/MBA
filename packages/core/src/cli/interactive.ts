/**
 * Raw-mode interactive input primitives for the `mba` CLI (ADR-0096).
 *
 * Three small, self-contained keypress handlers — no fzf, no readline
 * prompts, just stdin raw mode + ANSI redraw:
 *   - pickModelInteractive — arrow-key menu over models, type-to-filter
 *   - pickFieldInteractive — arrow-key menu over dials, type-to-filter,
 *     a trailing "quit" row
 *   - askValueInteractive  — single-line value prompt with a constraint hint
 *
 * These own the "how" of interactive input; `mba.ts` owns the flow (which
 * prompt comes next, what to do with the answer).
 */

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

export function pickModelInteractive(models: ModelEntry[]): Promise<ModelEntry> {
  return new Promise<ModelEntry>((resolve, reject) => {
    const stdin = process.stdin;
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
      // Move the cursor back over the previous frame and redraw.
      process.stdout.write(`\x1b[${list.length + 1}A\x1b[J`);
      process.stdout.write(`  mba models — ${query ? `filter: ${query}` : "type to filter"}\n`);
      if (list.length === 0) {
        process.stdout.write("  (no matches)\n");
        return;
      }
      list.forEach((m, i) => {
        const marker = i === cursor ? ">" : " ";
        const loaded = m.loaded ? "  [loaded]" : "";
        process.stdout.write(
          ` ${marker} ${m.id}${m.family ? `  (${m.family})` : ""}${loaded}\n`,
        );
      });
    };

    const firstRender = () => {
      process.stdout.write(`  mba models — ${models.length} models, type to filter\n`);
      const list = filtered();
      list.forEach((m, i) => {
        const marker = i === cursor ? ">" : " ";
        const loaded = m.loaded ? "  [loaded]" : "";
        process.stdout.write(
          ` ${marker} ${m.id}${m.family ? `  (${m.family})` : ""}${loaded}\n`,
        );
      });
    };

    const done = (m: ModelEntry) => {
      stdin.setRawMode(false);
      stdin.removeListener("data", onData);
      process.stdout.write("\n");
      resolve(m);
    };

    const handleKey = (key: string): boolean => {
      // Returns true when the prompt is done (resolve/reject already called).
      const list = filtered();
      if (key === "\x1b[A") {
        // up
        cursor = (cursor - 1 + list.length) % list.length;
        render();
        return false;
      } else if (key === "\x1b[B") {
        // down
        cursor = (cursor + 1) % list.length;
        render();
        return false;
      } else if (key === "\r" || key === "\n") {
        const pick = list[cursor];
        if (pick) done(pick);
        return true;
      } else if (key === "\x7f" || key === "\b") {
        // backspace
        query = query.slice(0, -1);
        cursor = Math.min(cursor, Math.max(0, filtered().length - 1));
        render();
        return false;
      } else if (key === "\x03") {
        // ctrl-c
        stdin.setRawMode(false);
        stdin.removeListener("data", onData);
        process.stdout.write("\n");
        reject(new Error("cancelled"));
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
    firstRender();
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
    let query = "";
    let cursor = 0;
    const rows = [...fields, null]; // null = quit row

    const filtered = () =>
      rows.filter((f) => f !== null && f.field.toLowerCase().includes(query.toLowerCase()));

    const drawRow = (f: ModelDial | null, i: number, cursorIdx: number): void => {
      const marker = i === cursorIdx ? ">" : " ";
      if (f === null) {
        process.stdout.write(` ${marker} quit\n`);
        return;
      }
      const current = f.current === null ? "(unset)" : String(f.current);
      const restart = f.restartRequired ? "  [restart]" : "";
      const hint = f.hint ? `  (${f.hint})` : "";
      process.stdout.write(` ${marker} ${f.field.padEnd(16)} ${current}${restart}${hint}\n`);
    };

    const render = () => {
      const list = filtered();
      process.stdout.write(`\x1b[${rows.length + 1}A\x1b[J`);
      process.stdout.write(
        `  pick a field to edit — ${query ? `filter: ${query}` : "type to filter"} (q/Esc quits):\n`,
      );
      if (list.length === 0) {
        process.stdout.write("  (no matches)\n");
        return;
      }
      list.forEach((f, i) => drawRow(f, i, cursor));
    };

    const done = (f: ModelDial | null) => {
      stdin.setRawMode(false);
      stdin.removeListener("data", onData);
      process.stdout.write("\n");
      resolve(f);
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
        done(list[cursor] ?? null);
      } else if (key === "q") {
        done(null);
      } else if (key === "\x1b") {
        // Esc clears the filter first; a second press quits.
        if (query.length > 0) {
          query = "";
          cursor = 0;
          render();
        } else {
          done(null);
        }
      } else if (key === "\x7f" || key === "\b") {
        query = query.slice(0, -1);
        cursor = Math.min(cursor, Math.max(0, filtered().length - 1));
        render();
      } else if (key === "\x03") {
        stdin.setRawMode(false);
        stdin.removeListener("data", onData);
        process.stdout.write("\n");
        reject(new Error("cancelled"));
      } else if (key.length === 1 && !key.startsWith("\x1b")) {
        query += key;
        cursor = 0;
        render();
      }
    };

    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
    // First frame: print the header line, then the body (render() assumes a
    // previous frame to move back over, so the first draw is done inline).
    process.stdout.write("  pick a field to edit — type to filter (q/Esc quits):\n");
    rows.forEach((f, i) => drawRow(f, i, cursor));
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
        `\r\x1b[K  ${field} [${current}]${hintText} > ${input}\x1b[7 >\x1b[0m`,
      );
    };

    const done = (value: string | null) => {
      stdin.setRawMode(false);
      stdin.removeListener("data", onData);
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
        stdin.setRawMode(false);
        stdin.removeListener("data", onData);
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
        `\r\x1b[K  port [${defaultPort}]${errText} > ${input}\x1b[7 >\x1b[0m`,
      );
    };

    const done = (value: number | null) => {
      stdin.setRawMode(false);
      stdin.removeListener("data", onData);
      process.stdout.write("\n");
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
        stdin.setRawMode(false);
        stdin.removeListener("data", onData);
        process.stdout.write("\n");
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
    let stage: "list" | "actions" = "list";
    let query = "";
    let cursor = 0;
    let listCursor = 0; // list position to restore when leaving the action menu
    let selected: ServerRow | null = null;
    let prevLines = 0;

    const filtered = () =>
      servers.filter(
        (s) =>
          s.id.toLowerCase().includes(query.toLowerCase()) ||
          String(s.port).includes(query) ||
          s.modelFile.toLowerCase().includes(query.toLowerCase()),
      );

    const actionRows = (): readonly ["stop", "logs", "back"] => ["stop", "logs", "back"];

    const drawServerRow = (s: ServerRow, i: number, cursorIdx: number): void => {
      const marker = i === cursorIdx ? ">" : " ";
      const pid = s.pid !== undefined ? String(s.pid) : "-";
      const health = s.healthy ? "ok" : "DOWN";
      process.stdout.write(
        ` ${marker} ${s.id.padEnd(18)} ${String(s.port).padEnd(7)} ${pid.padEnd(8)} ${health.padEnd(5)} ${s.modelFile}\n`,
      );
    };

    const render = () => {
      if (prevLines > 0) {
        process.stdout.write(`\x1b[${prevLines}A\x1b[J`);
      }
      if (stage === "list") {
        const list = filtered();
        process.stdout.write(
          `  mba servers — ${servers.length} running — ${query ? `filter: ${query}` : "type to filter"} (Esc quits):\n`,
        );
        if (list.length === 0) {
          process.stdout.write("  (no matches)\n");
          prevLines = 2;
          return;
        }
        list.forEach((s, i) => drawServerRow(s, i, cursor));
        prevLines = list.length + 1;
      } else {
        const rows = actionRows();
        process.stdout.write(
          `  actions for ${selected?.id} (port ${selected?.port}):\n`,
        );
        rows.forEach((a, i) => {
          const marker = i === cursor ? ">" : " ";
          const label =
            a === "stop"
              ? `stop ${selected?.id}`
              : a === "logs"
                ? `logs ${selected?.id}`
                : "back";
          process.stdout.write(` ${marker} ${label}\n`);
        });
        prevLines = rows.length + 1;
      }
    };

    const done = (sel: ServerSelection | null) => {
      stdin.setRawMode(false);
      stdin.removeListener("data", onData);
      process.stdout.write("\n");
      resolve(sel);
    };

    const cancel = () => {
      stdin.setRawMode(false);
      stdin.removeListener("data", onData);
      process.stdout.write("\n");
      reject(new Error("cancelled"));
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
