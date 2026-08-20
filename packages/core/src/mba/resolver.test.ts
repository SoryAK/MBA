import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveMbaConfig,
  scoreAdapter,
  loadAdapters,
  parseRuleBindings,
  inferModelFamily,
} from "./index.js";
import type { MbaAdapter, MbaResolutionContext } from "./types.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cyard-mba-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function adapter(partial: Partial<MbaAdapter> & { id: string }): MbaAdapter {
  return {
    apiVersion: "mba.c-yard.dev/v1alpha1",
    kind: "ModelBehavioralAdapter",
    metadata: { id: partial.id },
    identity: {
      model: {},
    },
    bindings: {},
    ...partial,
  } as MbaAdapter;
}

/** Wrap a bare adapter in an AdapterEntry (flat location, no path lineage). */
function entry(a: MbaAdapter): { path: string; adapter: MbaAdapter; pathSegments: readonly string[] } {
  return { path: "/adapters/x.yaml", adapter: a, pathSegments: [] };
}

describe("loadAdapters", () => {
  it("finds yaml files recursively under adapters/", () => {
    const adaptersDir = join(dir, "adapters");
    mkdirSync(join(adaptersDir, "family"), { recursive: true });
    writeFileSync(
      join(adaptersDir, "model.yaml"),
      `apiVersion: mba.c-yard.dev/v1alpha1
kind: ModelBehavioralAdapter
metadata:
  id: model-1
identity:
  model:
    name: m1
bindings: {}
`,
    );
    writeFileSync(
      join(adaptersDir, "family", "family.yaml"),
      `apiVersion: mba.c-yard.dev/v1alpha1
kind: ModelBehavioralAdapter
metadata:
  id: family-1
identity:
  model:
    family: f1
bindings: {}
`,
    );
    const loaded = loadAdapters(adaptersDir);
    expect(loaded.map((e) => e.adapter.metadata.id).sort()).toEqual(["family-1", "model-1"]);
  });
});

describe("scoreAdapter", () => {
  it("returns null when model identity does not match", () => {
    const a = adapter({ id: "x", identity: { model: { name: "other" } } });
    const ctx: MbaResolutionContext = { modelName: "m", harness: "copilot" };
    expect(scoreAdapter(entry(a), ctx)).toBeNull();
  });

  it("matches by name", () => {
    const a = adapter({ id: "x", identity: { model: { name: "m" } } });
    const ctx: MbaResolutionContext = { modelName: "m", harness: "copilot" };
    expect(scoreAdapter(entry(a), ctx)).toBe(50);
  });

  it("matches by family", () => {
    const a = adapter({ id: "x", identity: { model: { family: "f" } } });
    const ctx: MbaResolutionContext = { modelName: "m", modelFamily: "f", harness: "copilot" };
    expect(scoreAdapter(entry(a), ctx)).toBe(25);
  });

  it("matches by dna digest over name", () => {
    const a = adapter({
      id: "x",
      identity: { model: { dna: { digest: "abc" }, name: "m" } },
    });
    const ctx: MbaResolutionContext = {
      modelName: "m",
      modelDna: { digest: "abc" },
      harness: "copilot",
    };
    expect(scoreAdapter(entry(a), ctx)).toBe(100);
  });

  it("adds environment and server specificity", () => {
    const a = adapter({
      id: "x",
      identity: {
        model: { name: "m" },
        environment: { harness: "copilot", ide: "vscode" },
        server: { runtime: "llama.cpp", version: ">=b3659" },
      },
    });
    const ctx: MbaResolutionContext = {
      modelName: "m",
      harness: "copilot",
      ide: "vscode",
      serverRuntime: "llama.cpp",
      serverVersion: "b3700",
    };
    expect(scoreAdapter(entry(a), ctx)).toBe(50 + 8 + 4 + 2 + 1);
  });

  it("returns null when harness does not match", () => {
    const a = adapter({
      id: "x",
      identity: { model: { name: "m" }, environment: { harness: "cline" } },
    });
    const ctx: MbaResolutionContext = { modelName: "m", harness: "copilot" };
    expect(scoreAdapter(entry(a), ctx)).toBeNull();
  });

  it("returns null when server version is out of range", () => {
    const a = adapter({
      id: "x",
      identity: {
        model: { name: "m" },
        server: { runtime: "llama.cpp", version: ">=b3700" },
      },
    });
    const ctx: MbaResolutionContext = {
      modelName: "m",
      harness: "copilot",
      serverRuntime: "llama.cpp",
      serverVersion: "b3659",
    };
    expect(scoreAdapter(entry(a), ctx)).toBeNull();
  });
});

describe("resolveMbaConfig", () => {
  it("falls back to defaults when no adapters match", () => {
    const mbaDir = join(dir, "mba");
    mkdirSync(join(mbaDir, "adapters"), { recursive: true });
    const resolved = resolveMbaConfig(mbaDir, {
      modelName: "unknown",
      harness: "copilot",
    });
    expect(resolved.selectedIds).toEqual([]);
    expect(resolved.bcbConfig.tools.read_file?.repeatRun?.enabled).toBe(true);
  });

  it("merges family → name → dna layers", () => {
    const mbaDir = join(dir, "mba");
    const adaptersDir = join(mbaDir, "adapters");
    mkdirSync(adaptersDir, { recursive: true });
    mkdirSync(join(adaptersDir, "qwen3-coder"), { recursive: true });

    writeFileSync(
      join(adaptersDir, "qwen3-coder", "family.yaml"),
      `apiVersion: mba.c-yard.dev/v1alpha1
kind: ModelBehavioralAdapter
metadata:
  id: qwen3-coder-family
  family: qwen3-coder
identity:
  model:
    family: qwen3-coder
bindings:
  bcb: "./family-bcb.jsonl"
`,
    );
    writeFileSync(
      join(adaptersDir, "qwen3-coder", "family-bcb.jsonl"),
      JSON.stringify({ tool: "read_file", rule: "repeatRun", enabled: true, params: { threshold: 3 } }) + "\n",
    );

    mkdirSync(join(adaptersDir, "qwen3-coder-30b"), { recursive: true });
    writeFileSync(
      join(adaptersDir, "qwen3-coder-30b", "model.yaml"),
      `apiVersion: mba.c-yard.dev/v1alpha1
kind: ModelBehavioralAdapter
metadata:
  id: qwen3-coder-30b
identity:
  model:
    name: qwen3-coder-30b
    family: qwen3-coder
bindings:
  bcb: "./specific-bcb.jsonl"
`,
    );
    writeFileSync(
      join(adaptersDir, "qwen3-coder-30b", "specific-bcb.jsonl"),
      JSON.stringify({ tool: "read_file", rule: "eofOverflow", enabled: false }) + "\n",
    );

    const resolved = resolveMbaConfig(mbaDir, {
      modelName: "qwen3-coder-30b",
      modelFamily: "qwen3-coder",
      harness: "copilot",
    });
    expect(resolved.selectedIds).toEqual(["qwen3-coder-family", "qwen3-coder-30b"]);
    expect(resolved.bcbConfig.tools.read_file?.repeatRun?.threshold).toBe(3);
    expect(resolved.bcbConfig.tools.read_file?.eofOverflow?.enabled).toBe(false);
  });

  it("loads structural config and alerts", () => {
    const mbaDir = join(dir, "mba");
    const adaptersDir = join(mbaDir, "adapters");
    mkdirSync(join(adaptersDir, "m1"), { recursive: true });

    writeFileSync(
      join(adaptersDir, "m1", "model.yaml"),
      `apiVersion: mba.c-yard.dev/v1alpha1
kind: ModelBehavioralAdapter
metadata:
  id: model-1
identity:
  model:
    name: m1
bindings:
  structural: "./structural.json"
alerts:
  - events: ["tcb:killed"]
    sink: stderr
    params:
      level: warn
`,
    );
    writeFileSync(
      join(adaptersDir, "m1", "structural.json"),
      JSON.stringify({ grammar: { mode: "forced-grammar" } }),
    );

    const resolved = resolveMbaConfig(mbaDir, { modelName: "m1", harness: "copilot" });
    expect(resolved.structural.grammar?.mode).toBe("forced-grammar");
    expect(resolved.alerts).toHaveLength(1);
    expect(resolved.alerts[0]?.sink).toBe("stderr");
  });

  it("reports ambiguous resolution for tied top adapters", () => {
    const mbaDir = join(dir, "mba");
    const adaptersDir = join(mbaDir, "adapters");
    mkdirSync(adaptersDir, { recursive: true });

    for (const id of ["a", "b"]) {
      writeFileSync(
        join(adaptersDir, `${id}.yaml`),
        `apiVersion: mba.c-yard.dev/v1alpha1
kind: ModelBehavioralAdapter
metadata:
  id: ${id}
identity:
  model:
    name: m1
bindings: {}
`,
      );
    }

    const resolved = resolveMbaConfig(mbaDir, { modelName: "m1", harness: "copilot" });
    const ambiguous = resolved.diagnostics.filter((d) => d.kind === "ambiguous-resolution");
    expect(ambiguous).toHaveLength(1);
    expect([...(ambiguous[0]?.adapterIds ?? [])].sort()).toEqual(["a", "b"]);
  });
});

describe("inferModelFamily", () => {
  it("returns an explicit family hint unchanged", () => {
    expect(inferModelFamily({ modelName: "x", modelFamily: "qwen3-coder" })).toBe("qwen3-coder");
  });

  it("maps Qwen3-Coder-30B to qwen3-coder", () => {
    expect(inferModelFamily({ modelName: "Qwen3-Coder-30B" })).toBe("qwen3-coder");
  });

  it("maps a full GGUF path to qwen3-coder", () => {
    expect(
      inferModelFamily({
        modelName: "/home/skaba/models/qwen3/Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf",
      }),
    ).toBe("qwen3-coder");
  });

  it("maps qwen3 to qwen3-coder", () => {
    expect(inferModelFamily({ modelName: "qwen3" })).toBe("qwen3-coder");
  });

  it("returns undefined for an unknown model", () => {
    expect(inferModelFamily({ modelName: "gpt-4" })).toBeUndefined();
  });
});

describe("parseRuleBindings", () => {
  it("ignores blank and comment lines", () => {
    const text = `// header
{"tool":"read_file","rule":"readClamp","enabled":true}

{"tool":"read_file","rule":"eofOverflow","enabled":false}
`;
    const lines = parseRuleBindings(text);
    expect(lines).toHaveLength(2);
    expect(lines[1]?.rule).toBe("eofOverflow");
  });

  it("parses a rule_class binding with overrides", () => {
    const text = `{"tool":"read_file","rule_class":"readSafety","enabled":true,"overrides":{"eofOverflow":{"kill":{"enabled":false,"ignoredTrips":0,"action":"return-error"}}}}`;
    const [line] = parseRuleBindings(text);
    expect(line?.ruleClass).toBe("readSafety");
    expect(line?.rule).toBeUndefined();
    expect(line?.overrides?.eofOverflow).toBeDefined();
  });

  it("parses a rule_class array binding", () => {
    const text = `{"tool":"read_file","rule_class":["readSafety","readLoop"],"enabled":true}`;
    const [line] = parseRuleBindings(text);
    expect(line?.ruleClass).toEqual(["readSafety", "readLoop"]);
  });
});

describe("rule-class expansion", () => {
  it("expands a built-in class into its member rules", () => {
    const mbaDir = join(dir, "mba");
    const adaptersDir = join(mbaDir, "adapters");
    mkdirSync(join(adaptersDir, "m1"), { recursive: true });
    writeFileSync(
      join(adaptersDir, "m1", "model.yaml"),
      `apiVersion: mba.c-yard.dev/v1alpha1
kind: ModelBehavioralAdapter
metadata:
  id: m1
identity:
  model:
    name: m1
bindings:
  tcb: "./tcb.jsonl"
`,
    );
    writeFileSync(
      join(adaptersDir, "m1", "tcb.jsonl"),
      JSON.stringify({ tool: "read_file", rule_class: "readSafety", enabled: true }) + "\n",
    );

    const resolved = resolveMbaConfig(mbaDir, { modelName: "m1", harness: "copilot" });
    const rs = resolved.bcbConfig.tools.read_file;
    expect(rs?.readClamp?.enabled).toBe(true);
    expect(rs?.eofOverflow?.enabled).toBe(true);
    expect(rs?.binaryBlock?.enabled).toBe(true);
    expect(Array.isArray(rs?.binaryBlock?.extensions)).toBe(true);
  });

  it("applies loopBreaker's mask escalation and honours per-member overrides", () => {
    const mbaDir = join(dir, "mba");
    const adaptersDir = join(mbaDir, "adapters");
    mkdirSync(join(adaptersDir, "m1"), { recursive: true });
    writeFileSync(
      join(adaptersDir, "m1", "model.yaml"),
      `apiVersion: mba.c-yard.dev/v1alpha1
kind: ModelBehavioralAdapter
metadata:
  id: m1
identity:
  model:
    name: m1
bindings:
  tcb: "./tcb.jsonl"
`,
    );
    writeFileSync(
      join(adaptersDir, "m1", "tcb.jsonl"),
      JSON.stringify({
        tool: "meta_tool",
        rule_class: "loopBreaker",
        enabled: true,
        overrides: { directDuplication: { threshold: 9 } },
      }) + "\n",
    );

    const resolved = resolveMbaConfig(mbaDir, { modelName: "m1", harness: "copilot" });
    const dd = resolved.bcbConfig.tools.meta_tool?.directDuplication;
    expect(dd?.threshold).toBe(9);
    expect(dd?.escalation?.tiers.some((t) => t.tier === "mask")).toBe(true);
  });

  it("lets a user rule-classes.json override a built-in and reports the collision", () => {
    const mbaDir = join(dir, "mba");
    const adaptersDir = join(mbaDir, "adapters");
    mkdirSync(join(adaptersDir, "m1"), { recursive: true });
    writeFileSync(
      join(adaptersDir, "m1", "model.yaml"),
      `apiVersion: mba.c-yard.dev/v1alpha1
kind: ModelBehavioralAdapter
metadata:
  id: m1
identity:
  model:
    name: m1
bindings:
  tcb: "./tcb.jsonl"
  ruleClasses: "./rule-classes.json"
`,
    );
    writeFileSync(
      join(adaptersDir, "m1", "rule-classes.json"),
      JSON.stringify({ classes: { loopBreaker: { members: { directDuplication: { threshold: 2 } } } } }),
    );
    writeFileSync(
      join(adaptersDir, "m1", "tcb.jsonl"),
      JSON.stringify({ tool: "meta_tool", rule_class: "loopBreaker", enabled: true }) + "\n",
    );

    const resolved = resolveMbaConfig(mbaDir, { modelName: "m1", harness: "copilot" });
    expect(resolved.bcbConfig.tools.meta_tool?.directDuplication?.threshold).toBe(2);
    // repeatRun is gone — the user class redefined loopBreaker's members.
    expect(resolved.bcbConfig.tools.meta_tool?.repeatRun).toBeUndefined();
    expect(resolved.diagnostics.some((d) => d.kind === "rule-class-override")).toBe(true);
  });

  it("expands multiple classes on one line (array), merging their members", () => {
    const mbaDir = join(dir, "mba");
    const adaptersDir = join(mbaDir, "adapters");
    mkdirSync(join(adaptersDir, "m1"), { recursive: true });
    writeFileSync(
      join(adaptersDir, "m1", "model.yaml"),
      `apiVersion: mba.c-yard.dev/v1alpha1
kind: ModelBehavioralAdapter
metadata:
  id: m1
identity:
  model:
    name: m1
bindings:
  tcb: "./tcb.jsonl"
`,
    );
    writeFileSync(
      join(adaptersDir, "m1", "tcb.jsonl"),
      JSON.stringify({ tool: "read_file", rule_class: ["readSafety", "readLoop"], enabled: true }) + "\n",
    );

    const resolved = resolveMbaConfig(mbaDir, { modelName: "m1", harness: "copilot" });
    const rs = resolved.bcbConfig.tools.read_file;
    // readSafety members present:
    expect(rs?.readClamp?.enabled).toBe(true);
    expect(rs?.binaryBlock?.enabled).toBe(true);
    // readLoop member with its mask ladder, and NO directDuplication:
    expect(rs?.repeatRun?.enabled).toBe(true);
    expect(rs?.repeatRun?.escalation?.tiers.some((t) => t.tier === "mask")).toBe(true);
    expect(rs?.directDuplication).toBeUndefined();
  });

  it("reports an unknown rule class", () => {
    const mbaDir = join(dir, "mba");
    const adaptersDir = join(mbaDir, "adapters");
    mkdirSync(join(adaptersDir, "m1"), { recursive: true });
    writeFileSync(
      join(adaptersDir, "m1", "model.yaml"),
      `apiVersion: mba.c-yard.dev/v1alpha1
kind: ModelBehavioralAdapter
metadata:
  id: m1
identity:
  model:
    name: m1
bindings:
  tcb: "./tcb.jsonl"
`,
    );
    writeFileSync(
      join(adaptersDir, "m1", "tcb.jsonl"),
      JSON.stringify({ tool: "read_file", rule_class: "doesNotExist", enabled: true }) + "\n",
    );

    const resolved = resolveMbaConfig(mbaDir, { modelName: "m1", harness: "copilot" });
    expect(resolved.diagnostics.some((d) => d.kind === "unknown-rule-class")).toBe(true);
  });
});
