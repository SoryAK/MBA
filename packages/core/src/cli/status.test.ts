import { describe, it, expect } from "vitest";
import { statusView } from "./status.js";
import type { StatusSnapshot } from "../service/status-snapshot.js";
import { defaultWatches } from "../service/model-watches.js";

function emptySnapshot(overrides: Partial<StatusSnapshot> = {}): StatusSnapshot {
  return {
    version: 0,
    uptimeMs: 12,
    pairing: {
      active: false,
      blocked: false,
      count: 0,
      integrity: "missing",
      sessions: [],
    },
    registry: { blocked: false, count: 0, integrity: "missing" },
    clients: { blocked: false, count: 0, integrity: "missing" },
    paths: {
      baseDir: "/tmp/mba",
      tcbPath: "/tmp/mba/tcb.json",
      ruleClassesPath: "/tmp/mba/rule-classes.json",
      versionPath: "/tmp/mba/version",
      machineOverlayPath: "/tmp/mba/overlay.json",
      modelHistoryPath: "/tmp/mba/history.db",
    },
    machineOverlay: { mode: "enforce" },
    models: [],
    servers: [],
    watches: defaultWatches(),
    ...overrides,
  };
}

describe("statusView", () => {
  it("keeps the mba status --json field names on one snapshot", () => {
    const view = statusView(
      "http://127.0.0.1:3920",
      emptySnapshot({
        models: [
          { id: "qwen3.8-27b", name: "qwen3.8-27b", family: "qwen", loaded: true },
          { id: "embed", name: "embed", loaded: false },
        ],
        servers: [
          {
            id: "llama-cpp-8080",
            serverType: "llama.cpp",
            modelFile: "/models/qwen.gguf",
            port: 8080,
            startedAt: "2026-09-20T00:00:00.000Z",
            healthy: true,
            resolved: true,
            duplicate: false,
          },
        ],
        watches: {
          modelId: "qwen3.8-27b",
          watches: [
            {
              id: "clamp",
              label: "overshoot clamp",
              tool: "read_file",
              rule: "readClamp",
              mode: "inherit",
              effective: true,
            },
          ],
        },
      }),
    );
    expect(view).toEqual({
      service: "up",
      url: "http://127.0.0.1:3920",
      machine: "enforce",
      pairing: {
        active: false,
        blocked: false,
        count: 0,
        integrity: "missing",
        sessions: [],
      },
      registry: { blocked: false, count: 0, integrity: "missing" },
      clients: { blocked: false, count: 0, integrity: "missing" },
      loaded: ["qwen3.8-27b"],
      watches: {
        modelId: "qwen3.8-27b",
        watches: [{ id: "clamp", mode: "inherit", effective: true }],
      },
      models: [
        { id: "qwen3.8-27b", family: "qwen", loaded: true },
        { id: "embed", family: undefined, loaded: false },
      ],
      servers: [
        {
          id: "llama-cpp-8080",
          port: 8080,
          healthy: true,
          modelFile: "/models/qwen.gguf",
        },
      ],
    });
  });
});
