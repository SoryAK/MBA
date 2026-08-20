import { describe, expect, it } from "vitest";
import { formatDirectDuplicationMessage, runDirectDuplication } from "./direct-duplication.js";
import type { ChatMessage } from "../../chat-message.js";
import type { ToolCall, ToolRuleSet } from "../types.js";

const toolMsg = (id: string, content: string): ChatMessage => ({
  role: "tool",
  tool_call_id: id,
  content,
});

const call = (id: string, tool: string, argHash: string): ToolCall => ({
  toolCallId: id,
  tool,
  rawArgs: {},
  argHash,
  turnIndex: 0,
});

const ruleSet = (enabled: boolean, threshold = 3): ToolRuleSet => ({
  directDuplication: { enabled, threshold },
});

describe("runDirectDuplication", () => {
  it("does nothing when disabled", () => {
    const messages = [toolMsg("a", "x")];
    const out = runDirectDuplication(messages, [call("a", "t", "h")], ruleSet(false));
    expect(out.tripped).toBe(false);
    expect(out.messages).toBe(messages);
  });

  it("trips when the trailing run of identical tool+argHash reaches threshold", () => {
    const messages = [toolMsg("c", "body")];
    const calls = [call("a", "meta", "h1"), call("b", "meta", "h1"), call("c", "meta", "h1")];
    const out = runDirectDuplication(messages, calls, ruleSet(true, 3));
    expect(out.tripped).toBe(true);
    expect(out.trips[0]!.rule).toBe("directDuplication");
    expect(out.trips[0]!.tool).toBe("meta");
    expect(out.trips[0]!.targetKey).toBe("meta:h1");
    expect(out.trips[0]!.meta.runLength).toBe(3);
    expect(String(out.messages[0]!.content)).toContain("meta");
  });

  it("works on a no-line-range tool (the mba_file_metadata case)", () => {
    const messages = [toolMsg("c", "body")];
    const calls = [
      call("a", "mba_file_metadata", "hx"),
      call("b", "mba_file_metadata", "hx"),
      call("c", "mba_file_metadata", "hx"),
    ];
    expect(runDirectDuplication(messages, calls, ruleSet(true, 3)).tripped).toBe(true);
  });

  it("does not trip below threshold", () => {
    const calls = [call("a", "meta", "h1"), call("b", "meta", "h1")];
    expect(runDirectDuplication([toolMsg("b", "x")], calls, ruleSet(true, 3)).tripped).toBe(false);
  });

  it("does not trip when the trailing run is broken by a different call", () => {
    const calls = [
      call("a", "meta", "h1"),
      call("b", "meta", "h1"),
      call("c", "other", "hz"), // breaks the run
    ];
    expect(runDirectDuplication([toolMsg("c", "x")], calls, ruleSet(true, 2)).tripped).toBe(false);
  });

  it("distinguishes different argHashes for the same tool", () => {
    const calls = [call("a", "meta", "h1"), call("b", "meta", "h2"), call("c", "meta", "h2")];
    const out = runDirectDuplication([toolMsg("c", "x")], calls, ruleSet(true, 2));
    expect(out.tripped).toBe(true);
    expect(out.trips[0]!.meta.runLength).toBe(2);
  });
});

describe("formatDirectDuplicationMessage", () => {
  it("names the tool and run length", () => {
    const m = formatDirectDuplicationMessage("meta", 4);
    expect(m).toContain("meta");
    expect(m).toContain("4");
  });
});
