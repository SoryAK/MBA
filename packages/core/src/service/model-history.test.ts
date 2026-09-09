/**
 * Tests for the per-model append-only history DB (separate from kill-state).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ChatMessage } from "../chat-message.js";
import {
  appendHistoryFromChatRequest,
  lastTurnToolCalls,
  listModelEvents,
  openModelHistoryDb,
  recordModelHistory,
} from "./model-history.js";
import { incrementBcbKillState, openBcbDb, resetBcbKillState } from "../bcb/kill-state.js";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "mba-model-history-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function assistantTurn(id: string, tool: string): ChatMessage {
  return {
    role: "assistant",
    tool_calls: [
      {
        id,
        type: "function",
        function: { name: tool, arguments: "{}" },
      },
    ],
  };
}

describe("lastTurnToolCalls", () => {
  it("keeps only the latest assistant tool turn", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "go" },
      assistantTurn("call_1", "glob"),
      { role: "tool", tool_call_id: "call_1", content: "a.ts" },
      assistantTurn("call_2", "grep"),
      { role: "tool", tool_call_id: "call_2", content: "hit" },
    ];
    expect(lastTurnToolCalls(messages).map((c) => c.tool)).toEqual(["grep"]);
  });
});

describe("recordModelHistory", () => {
  it("appends tools and trips; retries do not duplicate", () => {
    const db = openModelHistoryDb(join(dir, "hist-1.db"));
    const input = {
      modelId: "deepseek_test",
      harness: "cursor",
      tools: [{ tool: "read_file", toolCallId: "call_1" }],
      trips: [
        {
          tool: "read_file",
          toolCallId: "call_1",
          rule: "eofOverflow",
          targetKey: "f:1-100",
        },
      ],
      lastTier: "nudge",
      now: 1_700_000_000_000,
    };
    recordModelHistory(db, input);
    recordModelHistory(db, input);
    const rows = listModelEvents(db, "deepseek_test");
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.kind).sort()).toEqual(["tool", "trip"]);
    expect(rows.find((r) => r.kind === "trip")?.tier).toBe("nudge");
    db.close();
  });

  it("survives a kill-state fuse reset in a separate db", () => {
    const history = openModelHistoryDb(join(dir, "hist-2.db"));
    const kill = openBcbDb(join(dir, "kill-2.db"));
    recordModelHistory(history, {
      modelId: "m",
      harness: "copilot",
      tools: [{ tool: "read_file", toolCallId: "call_k" }],
      trips: [
        {
          tool: "read_file",
          toolCallId: "call_k",
          rule: "eofOverflow",
          targetKey: "t",
        },
      ],
      lastTier: "kill",
    });
    incrementBcbKillState(kill, {
      sessionId: "s",
      tool: "read_file",
      rule: "eofOverflow",
      targetKey: "t",
    });
    resetBcbKillState(kill, "s", "read_file", "eofOverflow");
    expect(listModelEvents(history, "m")).toHaveLength(2);
    history.close();
    kill.close();
  });
});

describe("appendHistoryFromChatRequest", () => {
  it("is a no-op when db or model is missing", () => {
    appendHistoryFromChatRequest(undefined, {
      modelId: "m",
      body: "{}",
      ua: "copilot",
    });
    const db = openModelHistoryDb(join(dir, "hist-3.db"));
    appendHistoryFromChatRequest(db, { modelId: undefined, body: "{}", ua: "copilot" });
    expect(listModelEvents(db)).toHaveLength(0);
    db.close();
  });

  it("never throws on bad JSON", () => {
    const db = openModelHistoryDb(join(dir, "hist-4.db"));
    expect(() =>
      appendHistoryFromChatRequest(db, { modelId: "m", body: "not-json", ua: "x" }),
    ).not.toThrow();
    db.close();
  });
});
