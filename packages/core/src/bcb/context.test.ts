/**
 * Tests for buildBcbContext (ADR-0101 Step 2).
 *
 * Copied from C-Yard `packages/proxy/src/server.ts`. Resolves live line
 * counts from disk for read targets so the eofOverflow / readClamp rules can
 * compare a requested range against the file's actual length.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildBcbContext } from "./context.js";
import type { ToolCircuitBreakerConfig } from "./types.js";
import type { ChatMessage } from "../chat-message.js";

let dir: string;
let file3: string; // 3 lines, no trailing newline
let file5: string; // 5 lines, trailing newline

const config: ToolCircuitBreakerConfig = {
  tools: {
    read_file: {
      eofOverflow: { enabled: true },
      readClamp: { enabled: true },
    },
  },
};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "bcb-context-"));
  file3 = join(dir, "three.txt");
  file5 = join(dir, "five.txt");
  writeFileSync(file3, "a\nb\nc"); // 3 lines, no trailing newline
  writeFileSync(file5, "1\n2\n3\n4\n5\n"); // 5 lines + trailing newline
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const readCall = (filePath: string): ChatMessage => ({
  role: "assistant",
  tool_calls: [
    {
      id: "call_1",
      type: "function",
      function: { name: "read_file", arguments: JSON.stringify({ filePath }) },
    },
  ],
});

describe("buildBcbContext", () => {
  it("resolves the line count for a read target", () => {
    const { ctx } = buildBcbContext([readCall(file3)], config);
    expect(ctx.lineCounts[file3]).toBe(3);
  });

  it("counts a trailing newline as one extra element (wc -l convention)", () => {
    const { ctx } = buildBcbContext([readCall(file5)], config);
    expect(ctx.lineCounts[file5]).toBe(6); // "1\n2\n3\n4\n5\n".split("\n").length
  });

  it("leaves the count undefined for a missing file (rule skips it)", () => {
    const missing = join(dir, "does-not-exist.txt");
    const { ctx } = buildBcbContext([readCall(missing)], config);
    expect(ctx.lineCounts[missing]).toBeUndefined();
  });

  it("does not read files for tools without eofOverflow/readClamp enabled", () => {
    const noRule: ToolCircuitBreakerConfig = { tools: { read_file: {} } };
    const { ctx } = buildBcbContext([readCall(file3)], noRule);
    expect(ctx.lineCounts[file3]).toBeUndefined();
  });

  it("ignores messages without tool_calls", () => {
    const { ctx } = buildBcbContext([{ role: "user", content: "hi" }], config);
    expect(ctx.lineCounts).toEqual({});
  });

  it("reads each file only once across duplicate calls", () => {
    const { ctx } = buildBcbContext([readCall(file3), readCall(file3)], config);
    expect(ctx.lineCounts[file3]).toBe(3);
  });
});
