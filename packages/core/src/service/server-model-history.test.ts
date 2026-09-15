/**
 * GET /models/history — tool + trip ledger for one catalog id.
 */

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import { createMbaServiceApp } from "./server.js";
import { defaultStorePaths } from "./config-store.js";
import { openModelHistoryDb, recordModelHistory, type ModelHistoryEvent } from "./model-history.js";

function writeAdapter(dir: string, rel: string, id: string): void {
  const yamlFile = join(dir, rel);
  mkdirSync(join(yamlFile, ".."), { recursive: true });
  writeFileSync(
    yamlFile,
    [
      "apiVersion: mba.ai/v1alpha1",
      "kind: ModelBehavioralAdapter",
      "metadata:",
      `  id: ${id}`,
      "identity:",
      "  model:",
      '    file: "./m.gguf"',
      "bindings: {}",
    ].join("\n"),
  );
}

describe("GET /models/history", () => {
  let paths: ReturnType<typeof defaultStorePaths>;
  let adapterDir: string;
  let historyPath: string;

  beforeEach(() => {
    paths = defaultStorePaths(mkdtempSync(join(tmpdir(), "mba-svc-hist-")));
    adapterDir = mkdtempSync(join(tmpdir(), "mba-svc-hist-ad-"));
    writeAdapter(adapterDir, "qwen/qwen3-coder/qwen3-coder-30b/qwen3-coder-30b.yaml", "qwen3-coder-30b");
    historyPath = join(mkdtempSync(join(tmpdir(), "mba-hist-db-")), "mba-model-history.db");
  });

  it("returns an empty ledger for a known model", async () => {
    const historyDb = openModelHistoryDb(historyPath);
    const app = createMbaServiceApp({ paths, adapterDir, historyDb });
    const res = await app.request("/models/history?id=qwen3-coder-30b");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { modelId: string; events: ModelHistoryEvent[] };
    expect(body.modelId).toBe("qwen3-coder-30b");
    expect(body.events).toEqual([]);
    historyDb.close();
  });

  it("returns last-N tools and trips without sqlite ids", async () => {
    const historyDb = openModelHistoryDb(historyPath);
    recordModelHistory(historyDb, {
      modelId: "qwen3-coder-30b",
      harness: "cursor",
      tools: [{ tool: "read_file", toolCallId: "call_1" }],
      trips: [],
      now: 1_700_000_000_000,
    });
    recordModelHistory(historyDb, {
      modelId: "qwen3-coder-30b",
      harness: "cursor",
      tools: [{ tool: "read_file", toolCallId: "call_2" }],
      trips: [
        {
          tool: "read_file",
          toolCallId: "call_2",
          rule: "eofOverflow",
          targetKey: "f:1-100",
        },
      ],
      lastTier: "nudge",
      now: 1_700_000_000_001,
    });
    const app = createMbaServiceApp({ paths, adapterDir, historyDb });
    const res = await app.request("/models/history?id=qwen3-coder-30b&lines=2");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: Array<ModelHistoryEvent & { id?: unknown; modelId?: unknown }> };
    expect(body.events).toHaveLength(2);
    expect(body.events.map((e) => e.kind)).toEqual(["tool", "trip"]);
    expect(body.events[1]?.rule).toBe("eofOverflow");
    expect(body.events[1]?.tier).toBe("nudge");
    expect(body.events.every((e) => e.id === undefined && e.modelId === undefined)).toBe(true);
    historyDb.close();
  });

  it("404s an unknown model and 400s a missing id", async () => {
    const historyDb = openModelHistoryDb(historyPath);
    const app = createMbaServiceApp({ paths, adapterDir, historyDb });
    const missing = await app.request("/models/history?id=nope");
    expect(missing.status).toBe(404);
    const noId = await app.request("/models/history");
    expect(noId.status).toBe(400);
    const badLines = await app.request("/models/history?id=qwen3-coder-30b&lines=-1");
    expect(badLines.status).toBe(400);
    historyDb.close();
  });
});
