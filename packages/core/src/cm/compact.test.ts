import { describe, expect, it } from "vitest";
import { compact, COMPACT_REASONING_RESIDUE } from "./compact.js";
import { withMark } from "./types.js";

describe("compact / reasoning", () => {
  it("is a no-op when nothing looks like reasoning", () => {
    const messages = [
      { role: "user", content: "q" },
      { role: "assistant", content: "the file is foo.ts" },
    ];
    const out = compact({ messages, target: "reasoning" });
    expect(out.messages).toBe(messages);
    expect(out.progress).toBe(0);
  });

  it("rewrites a closed think block and keeps the answer", () => {
    const messages = [
      {
        role: "assistant",
        content: "<think>long search, maybe bar.ts</think>\nThe file is foo.ts",
      },
    ];
    const out = compact({ messages, target: "reasoning" });
    expect(out.progress).toBe(1);
    expect(out.messages[0]).toEqual({
      role: "assistant",
      content: `${COMPACT_REASONING_RESIDUE}\nThe file is foo.ts`,
    });
  });

  it("drops reasoning_content when the answer is already in content", () => {
    const messages = [
      {
        role: "assistant",
        content: "Use join().",
        reasoning_content: "I considered concat, then join.",
      },
    ];
    const out = compact({ messages, target: "reasoning" });
    expect(out.progress).toBe(1);
    expect(out.messages[0]).toEqual({
      role: "assistant",
      content: `${COMPACT_REASONING_RESIDUE}\nUse join().`,
    });
    expect(out.messages[0]).not.toHaveProperty("reasoning_content");
  });

  it("leaves an unclosed think alone (still writing)", () => {
    const messages = [
      { role: "assistant", content: "<think>still looking at the tree" },
    ];
    const out = compact({ messages, target: "reasoning" });
    expect(out.messages).toBe(messages);
    expect(out.progress).toBe(0);
  });

  it("leaves a reasoning field alone when there is no answer yet", () => {
    const messages = [
      { role: "assistant", content: "", reasoning_content: "still thinking" },
    ];
    const out = compact({ messages, target: "reasoning" });
    expect(out.messages).toBe(messages);
  });

  it("skips a pinned assistant", () => {
    const raw = {
      role: "assistant",
      content: "<think>keep this</think>\nanswer",
    };
    const messages = [withMark(raw, "pin")];
    const out = compact({ messages, target: "reasoning" });
    expect(out.messages).toBe(messages);
  });

  it("compacts every finished assistant, not only the last", () => {
    const messages = [
      { role: "assistant", content: "<think>a</think>\none" },
      { role: "user", content: "again" },
      { role: "assistant", content: "<think>b</think>\ntwo" },
    ];
    const out = compact({ messages, target: "reasoning" });
    expect(out.progress).toBe(2);
    expect(String(out.messages[0]!.content)).toBe(`${COMPACT_REASONING_RESIDUE}\none`);
    expect(String(out.messages[2]!.content)).toBe(`${COMPACT_REASONING_RESIDUE}\ntwo`);
  });
});
