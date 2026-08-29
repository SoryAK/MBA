import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { askPortInteractive } from "./interactive.js";

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
