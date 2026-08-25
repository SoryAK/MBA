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

    const onData = (buf: Buffer) => {
      const key = buf.toString("utf8");
      const list = filtered();
      if (key === "\x1b[A") {
        // up
        cursor = (cursor - 1 + list.length) % list.length;
        render();
      } else if (key === "\x1b[B") {
        // down
        cursor = (cursor + 1) % list.length;
        render();
      } else if (key === "\r" || key === "\n") {
        const pick = list[cursor];
        if (pick) done(pick);
      } else if (key === "\x7f" || key === "\b") {
        // backspace
        query = query.slice(0, -1);
        cursor = Math.min(cursor, Math.max(0, filtered().length - 1));
        render();
      } else if (key === "\x03") {
        // ctrl-c
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
