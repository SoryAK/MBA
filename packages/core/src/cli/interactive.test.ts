import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { askPortInteractive, pickServerInteractive, type ServerRow } from "./interactive.js";

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
