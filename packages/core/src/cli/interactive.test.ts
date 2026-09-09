import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  askPortInteractive,
  askTextInteractive,
  askYesNoInteractive,
  pickLabeledInteractive,
  pickModelInteractive,
  pickPreviewInteractive,
  pickServerInteractive,
  searchHfInteractive,
  type ModelEntry,
  type ServerRow,
} from "./interactive.js";

/**
 * Build a fake stdin stream that mimics the subset of the Node stdin API the
 * interactive prompts use: setRawMode, resume, on("data"), removeListener.
 * `emit` pushes a Buffer through the data handler.
 */
function fakeStdin() {
  const emitter = new EventEmitter();
  const stdin = {
    setRawMode: vi.fn(),
    resume: vi.fn(),
    pause: vi.fn(),
    on: (event: string, handler: (buf: Buffer) => void) => {
      emitter.on(event, handler);
      return stdin;
    },
    removeListener: (event: string, handler: (buf: Buffer) => void) => {
      emitter.removeListener(event, handler);
      return stdin;
    },
    emit: (key: string) => emitter.emit("data", Buffer.from(key)),
  };
  return stdin;
}

/** Yield to the microtask queue so the prompt's listener is attached. */
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("askPortInteractive", () => {
  let stdin: ReturnType<typeof fakeStdin>;
  beforeEach(() => {
    stdin = fakeStdin();
    vi.spyOn(process, "stdin", "get").mockReturnValue(stdin as unknown as NodeJS.ReadStream & { fd: 0 });
    vi.spyOn(process.stdout, "write").mockReturnValue(true as unknown as ReturnType<typeof process.stdout.write>);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the default when Enter is pressed with empty input", async () => {
    const p = askPortInteractive(8080);
    await tick();
    stdin.emit("\r");
    await expect(p).resolves.toBe(8080);
  });

  it("returns the typed port", async () => {
    const p = askPortInteractive(8080);
    await tick();
    stdin.emit("9");
    stdin.emit("0");
    stdin.emit("0");
    stdin.emit("1");
    stdin.emit("\r");
    await expect(p).resolves.toBe(9001);
  });

  it("re-prompts on non-numeric input", async () => {
    const p = askPortInteractive(8080);
    await tick();
    stdin.emit("a");
    stdin.emit("\r");
    // still pending
    stdin.emit("8");
    stdin.emit("0");
    stdin.emit("8");
    stdin.emit("0");
    stdin.emit("\r");
    await expect(p).resolves.toBe(8080);
  });

  it("re-prompts on out-of-range input", async () => {
    const p = askPortInteractive(8080);
    await tick();
    stdin.emit("9");
    stdin.emit("9");
    stdin.emit("9");
    stdin.emit("9");
    stdin.emit("9");
    stdin.emit("\r"); // 99999 > 65535
    stdin.emit("8");
    stdin.emit("0");
    stdin.emit("8");
    stdin.emit("0");
    stdin.emit("\r");
    await expect(p).resolves.toBe(8080);
  });

  it("returns null on Esc", async () => {
    const p = askPortInteractive(8080);
    await tick();
    stdin.emit("\x1b");
    await expect(p).resolves.toBeNull();
  });

  it("rejects on Ctrl-C", async () => {
    const p = askPortInteractive(8080);
    await tick();
    stdin.emit("\x03");
    await expect(p).rejects.toThrow("cancelled");
  });

  it("backspace clears the input", async () => {
    const p = askPortInteractive(8080);
    await tick();
    stdin.emit("9");
    stdin.emit("0");
    stdin.emit("\x7f"); // backspace
    stdin.emit("\r");
    await expect(p).resolves.toBe(9);
  });
});

describe("pickServerInteractive", () => {
  let stdin: ReturnType<typeof fakeStdin>;
  const servers: ServerRow[] = [
    { id: "srv-1", port: 8080, pid: 111, healthy: true, modelFile: "/models/a.gguf" },
    { id: "srv-2", port: 8085, pid: 222, healthy: false, modelFile: "/models/b.gguf" },
  ];

  beforeEach(() => {
    stdin = fakeStdin();
    vi.spyOn(process, "stdin", "get").mockReturnValue(stdin as unknown as NodeJS.ReadStream & { fd: 0 });
    vi.spyOn(process.stdout, "write").mockReturnValue(true as unknown as ReturnType<typeof process.stdout.write>);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("selects the first server and stops it", async () => {
    const p = pickServerInteractive(servers);
    await tick();
    stdin.emit("\r"); // pick srv-1 -> action menu
    await tick();
    stdin.emit("\r"); // "stop" is the first action row
    await expect(p).resolves.toEqual({ server: servers[0], action: "stop" });
  });

  it("selects the logs action for a server", async () => {
    const p = pickServerInteractive(servers);
    await tick();
    stdin.emit("\r"); // pick srv-1 -> action menu
    await tick();
    stdin.emit("\x1b[B"); // down -> "logs"
    stdin.emit("\r"); // pick logs
    await expect(p).resolves.toEqual({ server: servers[0], action: "logs" });
  });

  it("navigates down to the second server", async () => {
    const p = pickServerInteractive(servers);
    await tick();
    stdin.emit("\x1b[B"); // down
    stdin.emit("\r"); // pick srv-2 -> action menu
    await tick();
    stdin.emit("\r"); // stop
    await expect(p).resolves.toEqual({ server: servers[1], action: "stop" });
  });

  it("back returns to the list, then picks another server", async () => {
    const p = pickServerInteractive(servers);
    await tick();
    stdin.emit("\r"); // action menu for srv-1
    await tick();
    stdin.emit("\x1b[B"); // down -> "logs"
    stdin.emit("\x1b[B"); // down -> "back"
    stdin.emit("\r"); // back to the list
    await tick();
    stdin.emit("\x1b[B"); // down -> srv-2
    stdin.emit("\r"); // action menu for srv-2
    await tick();
    stdin.emit("\r"); // stop
    await expect(p).resolves.toEqual({ server: servers[1], action: "stop" });
  });

  it("Esc in the action menu returns to the list, Esc on the list cancels", async () => {
    const p = pickServerInteractive(servers);
    await tick();
    stdin.emit("\r"); // action menu
    await tick();
    stdin.emit("\x1b"); // back to the list
    await tick();
    stdin.emit("\x1b"); // quit
    await expect(p).resolves.toBeNull();
  });

  it("Esc on the list resolves null", async () => {
    const p = pickServerInteractive(servers);
    await tick();
    stdin.emit("\x1b");
    await expect(p).resolves.toBeNull();
  });

  it("type-to-filter narrows the list before picking", async () => {
    const p = pickServerInteractive(servers);
    await tick();
    stdin.emit("8085"); // only srv-2 matches
    stdin.emit("\r"); // pick srv-2 -> action menu
    await tick();
    stdin.emit("\r"); // stop
    await expect(p).resolves.toEqual({ server: servers[1], action: "stop" });
  });

  it("rejects on Ctrl-C", async () => {
    const p = pickServerInteractive(servers);
    await tick();
    stdin.emit("\x03");
    await expect(p).rejects.toThrow("cancelled");
  });
});

describe("searchHfInteractive", () => {
  let stdin: ReturnType<typeof fakeStdin>;
  beforeEach(() => {
    stdin = fakeStdin();
    vi.spyOn(process, "stdin", "get").mockReturnValue(stdin as unknown as NodeJS.ReadStream & { fd: 0 });
    vi.spyOn(process.stdout, "write").mockReturnValue(true as unknown as ReturnType<typeof process.stdout.write>);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("searches on Enter, then picks the first result", async () => {
    const search = vi.fn(async (q: string) => [
      { id: "Qwen/Qwen3-Coder-30B", downloads: 1000, likes: 50 },
      { id: "other/repo", downloads: 5, likes: 1 },
    ]);
    const p = searchHfInteractive(search);
    await tick();
    stdin.emit("q");
    stdin.emit("w");
    stdin.emit("\r"); // search
    await tick();
    await tick(); // let the async search resolve + redraw
    stdin.emit("\r"); // pick first
    await expect(p).resolves.toBe("Qwen/Qwen3-Coder-30B");
    expect(search).toHaveBeenCalledWith("qw");
  });

  it("navigates down to the second result before picking", async () => {
    const search = vi.fn(async () => [
      { id: "a/one", downloads: 1 },
      { id: "b/two", downloads: 2 },
    ]);
    const p = searchHfInteractive(search);
    await tick();
    stdin.emit("x");
    stdin.emit("\r"); // search
    await tick();
    await tick();
    stdin.emit("\x1b[B"); // down
    stdin.emit("\r"); // pick second
    await expect(p).resolves.toBe("b/two");
  });

  it("resolves null on Esc (cancel)", async () => {
    const search = vi.fn(async () => []);
    const p = searchHfInteractive(search);
    await tick();
    stdin.emit("\x1b");
    await expect(p).resolves.toBeNull();
  });

  it("rejects on Ctrl-C", async () => {
    const search = vi.fn(async () => []);
    const p = searchHfInteractive(search);
    await tick();
    stdin.emit("\x03");
    await expect(p).rejects.toThrow("cancelled");
  });

  it("shows an error and stays open when the search throws", async () => {
    const search = vi.fn(async () => {
      throw new Error("boom");
    });
    const p = searchHfInteractive(search);
    await tick();
    stdin.emit("x");
    stdin.emit("\r"); // search -> throws
    await tick();
    await tick();
    // still open: Esc cancels
    stdin.emit("\x1b");
    await expect(p).resolves.toBeNull();
    expect(search).toHaveBeenCalled();
  });

  it("does not move the cursor up on the first results frame, but does on redraws", async () => {
    const write = vi.spyOn(process.stdout, "write");
    const search = vi.fn(async () => [
      { id: "a/one", downloads: 1 },
      { id: "b/two", downloads: 2 },
    ]);
    const p = searchHfInteractive(search);
    await tick();
    stdin.emit("x");
    stdin.emit("\r"); // search
    await tick();
    await tick(); // first results frame

    const firstFrame = write.mock.calls.map((c) => String(c[0])).join("");
    // First frame must NOT contain a cursor-up (no prior results frame to overwrite).
    expect(firstFrame).not.toMatch(/\x1b\[\d+A/);

    // Now redraw via a down-arrow: box is 7 lines (top, header, split, 3 body, bottom).
    write.mockClear();
    stdin.emit("\x1b[B"); // down -> redraw
    const redraw = write.mock.calls.map((c) => String(c[0])).join("");
    expect(redraw).toContain("\x1b[7A");

    stdin.emit("\x1b"); // Esc to settle
    await expect(p).resolves.toBeNull();
  });
});

describe("pickLabeledInteractive", () => {
  let stdin: ReturnType<typeof fakeStdin>;
  const items = [
    { label: "model.Q4_K_M.gguf", value: "Q4_K_M" },
    { label: "model.Q8_0.gguf", value: "Q8_0" },
  ];
  beforeEach(() => {
    stdin = fakeStdin();
    vi.spyOn(process, "stdin", "get").mockReturnValue(stdin as unknown as NodeJS.ReadStream & { fd: 0 });
    vi.spyOn(process.stdout, "write").mockReturnValue(true as unknown as ReturnType<typeof process.stdout.write>);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("picks the first item's value", async () => {
    const p = pickLabeledInteractive("pick a quant", items);
    await tick();
    stdin.emit("\r");
    await expect(p).resolves.toBe("Q4_K_M");
  });

  it("starts on selectedValue", async () => {
    const p = pickLabeledInteractive("pick a quant", items, { selectedValue: "Q8_0" });
    await tick();
    stdin.emit("\r");
    await expect(p).resolves.toBe("Q8_0");
  });

  it("navigates down and picks the second item's value", async () => {
    const p = pickLabeledInteractive("pick a quant", items);
    await tick();
    stdin.emit("\x1b[B");
    stdin.emit("\r");
    await expect(p).resolves.toBe("Q8_0");
  });

  it("resolves null on Esc", async () => {
    const p = pickLabeledInteractive("pick a quant", items);
    await tick();
    stdin.emit("\x1b");
    await expect(p).resolves.toBeNull();
  });

  it("draws the two-pane list + preview chrome", async () => {
    const write = vi.spyOn(process.stdout, "write");
    const p = pickLabeledInteractive("home", [
      { label: "models", value: "models", preview: [["do", "edit dials"]] },
      { label: "quit", value: "quit" },
    ]);
    await tick();
    const frame = write.mock.calls.map((c) => String(c[0])).join("");
    expect(frame).toContain("┬");
    expect(frame).toContain("edit dials");
    stdin.emit("\x1b");
    await expect(p).resolves.toBeNull();
  });

  it("type-to-filter narrows the list before picking", async () => {
    const p = pickLabeledInteractive("pick a quant", items);
    await tick();
    stdin.emit("Q8");
    stdin.emit("\r");
    await expect(p).resolves.toBe("Q8_0");
  });

  it("clears the filter on first Esc, then cancels on the second", async () => {
    const p = pickLabeledInteractive("pick a quant", items);
    await tick();
    stdin.emit("Q8");
    stdin.emit("\x1b");
    await tick();
    stdin.emit("\x1b");
    await expect(p).resolves.toBeNull();
  });
});

describe("pickPreviewInteractive", () => {
  let stdin: ReturnType<typeof fakeStdin>;
  const items = [
    {
      label: "model.Q4_K_M.gguf",
      value: "Q4_K_M",
      preview: [["file", "model.Q4_K_M.gguf"], ["size", "4.2 GiB"]] as const,
    },
    {
      label: "model.Q8_0.gguf",
      value: "Q8_0",
      preview: [["file", "model.Q8_0.gguf"], ["size", "8.1 GiB"]] as const,
    },
  ];
  beforeEach(() => {
    stdin = fakeStdin();
    vi.spyOn(process, "stdin", "get").mockReturnValue(stdin as unknown as NodeJS.ReadStream & { fd: 0 });
    vi.spyOn(process.stdout, "write").mockReturnValue(true as unknown as ReturnType<typeof process.stdout.write>);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("picks the first item on Enter", async () => {
    const p = pickPreviewInteractive("quant", items);
    await tick();
    stdin.emit("\r");
    await expect(p).resolves.toBe("Q4_K_M");
  });

  it("type-to-filter then picks the remaining row", async () => {
    const p = pickPreviewInteractive("quant", items);
    await tick();
    stdin.emit("Q8");
    stdin.emit("\r");
    await expect(p).resolves.toBe("Q8_0");
  });

  it("draws a split pane with a preview of the selected row", async () => {
    const write = vi.spyOn(process.stdout, "write");
    const p = pickPreviewInteractive("quant", items);
    await tick();
    const frame = write.mock.calls.map((c) => String(c[0])).join("");
    expect(frame).toContain("┬");
    expect(frame).toContain("4.2 GiB");
    stdin.emit("\x1b");
    await expect(p).resolves.toBeNull();
  });
});

describe("askTextInteractive", () => {
  let stdin: ReturnType<typeof fakeStdin>;
  beforeEach(() => {
    stdin = fakeStdin();
    vi.spyOn(process, "stdin", "get").mockReturnValue(stdin as unknown as NodeJS.ReadStream & { fd: 0 });
    vi.spyOn(process.stdout, "write").mockReturnValue(true as unknown as ReturnType<typeof process.stdout.write>);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the typed text", async () => {
    const p = askTextInteractive("model id", "default-id");
    await tick();
    stdin.emit("m");
    stdin.emit("y");
    stdin.emit("\r");
    await expect(p).resolves.toBe("my");
  });

  it("returns the default when Enter is pressed with empty input", async () => {
    const p = askTextInteractive("model id", "default-id");
    await tick();
    stdin.emit("\r");
    await expect(p).resolves.toBe("default-id");
  });

  it("resolves null on Esc", async () => {
    const p = askTextInteractive("model id", "default-id");
    await tick();
    stdin.emit("\x1b");
    await expect(p).resolves.toBeNull();
  });

  it("backspace clears the input", async () => {
    const p = askTextInteractive("model id", "default-id");
    await tick();
    stdin.emit("a");
    stdin.emit("b");
    stdin.emit("\x7f");
    stdin.emit("\r");
    await expect(p).resolves.toBe("a");
  });
});

describe("pickModelInteractive", () => {
  let stdin: ReturnType<typeof fakeStdin>;
  const models: ModelEntry[] = [
    { id: "qwen3-coder-30b", name: "Qwen3 Coder", family: "qwen3-coder", loaded: true },
    { id: "smollm2", name: "SmolLM2", family: "smollm2", loaded: false },
  ];

  beforeEach(() => {
    stdin = fakeStdin();
    vi.spyOn(process, "stdin", "get").mockReturnValue(stdin as unknown as NodeJS.ReadStream & { fd: 0 });
    vi.spyOn(process.stdout, "write").mockReturnValue(true as unknown as ReturnType<typeof process.stdout.write>);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("picks the first model on Enter", async () => {
    const p = pickModelInteractive(models);
    await tick();
    stdin.emit("\r");
    await expect(p).resolves.toEqual(models[0]);
  });

  it("resolves null on Esc", async () => {
    const p = pickModelInteractive(models);
    await tick();
    stdin.emit("\x1b");
    await expect(p).resolves.toBeNull();
  });

  it("clears the filter on first Esc, then cancels on the second", async () => {
    const p = pickModelInteractive(models);
    await tick();
    stdin.emit("s");
    stdin.emit("\x1b"); // clear filter
    await tick();
    stdin.emit("\x1b"); // cancel
    await expect(p).resolves.toBeNull();
  });
});

describe("askYesNoInteractive", () => {
  let stdin: ReturnType<typeof fakeStdin>;
  beforeEach(() => {
    stdin = fakeStdin();
    vi.spyOn(process, "stdin", "get").mockReturnValue(stdin as unknown as NodeJS.ReadStream & { fd: 0 });
    vi.spyOn(process.stdout, "write").mockReturnValue(true as unknown as ReturnType<typeof process.stdout.write>);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("defaults to no on Enter", async () => {
    const p = askYesNoInteractive("boot with these flags?");
    await tick();
    stdin.emit("\r");
    await expect(p).resolves.toBe(false);
  });

  it("returns true on y", async () => {
    const p = askYesNoInteractive("boot with these flags?");
    await tick();
    stdin.emit("y");
    stdin.emit("\r");
    await expect(p).resolves.toBe(true);
  });

  it("returns null on Esc", async () => {
    const p = askYesNoInteractive("boot with these flags?");
    await tick();
    stdin.emit("\x1b");
    await expect(p).resolves.toBeNull();
  });
});
