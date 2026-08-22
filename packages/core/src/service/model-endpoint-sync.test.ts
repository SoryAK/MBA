import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  readClientBlock,
  buildEndpointBlock,
  syncVsCodeEndpoints,
  type ClientBlock,
} from "./model-endpoint-sync.js";

const API_KEY_REF = "${input:chat.lm.secret.11180837}";

function writeAdapter(
  dir: string,
  rel: string,
  opts: { id: string; name: string; file: string; client?: string[] },
): void {
  const file = join(dir, rel);
  mkdirSync(dirname(file), { recursive: true });
  const yaml = [
    "apiVersion: mba.c-yard.dev/v1alpha1",
    "kind: ModelBehavioralAdapter",
    "metadata:",
    `  id: ${opts.id}`,
    `  name: "${opts.name}"`,
    "identity:",
    "  model:",
    `    file: "${opts.file}"`,
    ...(opts.client ? ["client:", ...opts.client] : []),
    "bindings: {}",
  ].join("\n");
  writeFileSync(file, yaml);
}

describe("readClientBlock", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mba-endpoint-sync-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns null when the adapter has no client block", () => {
    writeAdapter(root, "qwen/a/a.yaml", {
      id: "a",
      name: "A",
      file: "./a.gguf",
    });
    expect(readClientBlock(join(root, "qwen/a/a.yaml"))).toBeNull();
  });

  it("returns null for an empty client block", () => {
    writeAdapter(root, "qwen/a/a.yaml", {
      id: "a",
      name: "A",
      file: "./a.gguf",
      client: ["  {}"],
    });
    expect(readClientBlock(join(root, "qwen/a/a.yaml"))).toBeNull();
  });

  it("parses a full client block", () => {
    writeAdapter(root, "qwen/a/a.yaml", {
      id: "a",
      name: "A",
      file: "./a.gguf",
      client: [
        "  url: http://127.0.0.1:8090/v1",
        "  contextSize: 131072",
        "  maxOutputTokens: 16384",
        "  toolCalling: false",
        "  vision: false",
      ],
    });
    expect(readClientBlock(join(root, "qwen/a/a.yaml"))).toEqual({
      url: "http://127.0.0.1:8090/v1",
      contextSize: 131072,
      maxOutputTokens: 16384,
      toolCalling: false,
      vision: false,
    });
  });

  it("tolerates a partial client block (url only)", () => {
    writeAdapter(root, "qwen/a/a.yaml", {
      id: "a",
      name: "A",
      file: "./a.gguf",
      client: ["  url: http://127.0.0.1:8080/v1"],
    });
    expect(readClientBlock(join(root, "qwen/a/a.yaml"))).toEqual({
      url: "http://127.0.0.1:8080/v1",
    });
  });
});

describe("buildEndpointBlock", () => {
  it("builds the SK.LocalModels block from a client block", () => {
    const block = buildEndpointBlock(
      [
        {
          id: "qwen3-coder-30b",
          name: "Qwen3 Coder 30B",
          client: {
            url: "http://127.0.0.1:8090/v1",
            contextSize: 131072,
            maxOutputTokens: 16384,
            toolCalling: false,
            vision: false,
          },
        },
      ],
      API_KEY_REF,
    );
    expect(block).toEqual({
      name: "SK.LocalModels",
      vendor: "customendpoint",
      apiKey: API_KEY_REF,
      apiType: "chat-completions",
      models: [
        {
          id: "qwen3-coder-30b",
          name: "Qwen3 Coder 30B",
          url: "http://127.0.0.1:8090/v1",
          toolCalling: false,
          vision: false,
          maxInputTokens: 131072,
          maxOutputTokens: 16384,
        },
      ],
    });
  });

  it("applies defaults for missing client fields", () => {
    const block = buildEndpointBlock(
      [{ id: "a", name: "A", client: { url: "http://127.0.0.1:8080/v1" } }],
      API_KEY_REF,
    );
    expect(block.models).toEqual([
      {
        id: "a",
        name: "A",
        url: "http://127.0.0.1:8080/v1",
        toolCalling: true,
        vision: true,
        maxInputTokens: 128000,
        maxOutputTokens: 16384,
      },
    ]);
  });
});

describe("syncVsCodeEndpoints", () => {
  let root: string;
  let adaptersDir: string;
  let configPath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mba-endpoint-sync-"));
    adaptersDir = join(root, "adapters");
    configPath = join(root, "chatLanguageModels.json");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("creates the config file with the generated block when absent", () => {
    writeAdapter(adaptersDir, "qwen/a/a.yaml", {
      id: "a",
      name: "A",
      file: "./a.gguf",
      client: ["  url: http://127.0.0.1:8080/v1"],
    });
    const result = syncVsCodeEndpoints({
      adapterDir: adaptersDir,
      configPath,
      apiKeyRef: API_KEY_REF,
    });
    expect(result.created).toBe(true);
    expect(result.updated).toBe(false);
    expect(result.models).toEqual(["a"]);
    const parsed = JSON.parse(readFileSync(configPath, "utf8"));
    expect(parsed).toEqual([
      {
        name: "SK.LocalModels",
        vendor: "customendpoint",
        apiKey: API_KEY_REF,
        apiType: "chat-completions",
        models: [
          {
            id: "a",
            name: "A",
            url: "http://127.0.0.1:8080/v1",
            toolCalling: true,
            vision: true,
            maxInputTokens: 128000,
            maxOutputTokens: 16384,
          },
        ],
      },
    ]);
  });

  it("replaces only the generated block, preserving foreign blocks", () => {
    writeAdapter(adaptersDir, "qwen/a/a.yaml", {
      id: "a",
      name: "A",
      file: "./a.gguf",
      client: ["  url: http://127.0.0.1:8080/v1"],
    });
    const foreign = {
      name: "SK.Other",
      vendor: "customendpoint",
      apiKey: "other",
      apiType: "chat-completions",
      models: [{ id: "x", name: "X", url: "http://example/v1" }],
    };
    writeFileSync(configPath, JSON.stringify([foreign], null, 2));
    const result = syncVsCodeEndpoints({
      adapterDir: adaptersDir,
      configPath,
      apiKeyRef: API_KEY_REF,
    });
    expect(result.created).toBe(false);
    expect(result.updated).toBe(true);
    const parsed = JSON.parse(readFileSync(configPath, "utf8"));
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toEqual(foreign);
    expect(parsed[1].name).toBe("SK.LocalModels");
    expect(parsed[1].models).toHaveLength(1);
  });

  it("is a no-op when the generated block is already current", () => {
    writeAdapter(adaptersDir, "qwen/a/a.yaml", {
      id: "a",
      name: "A",
      file: "./a.gguf",
      client: ["  url: http://127.0.0.1:8080/v1"],
    });
    const opts = {
      adapterDir: adaptersDir,
      configPath,
      apiKeyRef: API_KEY_REF,
    };
    syncVsCodeEndpoints(opts);
    const before = readFileSync(configPath, "utf8");
    const result = syncVsCodeEndpoints(opts);
    expect(result.updated).toBe(false);
    expect(readFileSync(configPath, "utf8")).toBe(before);
  });

  it("updates the generated block when the client config changes", () => {
    writeAdapter(adaptersDir, "qwen/a/a.yaml", {
      id: "a",
      name: "A",
      file: "./a.gguf",
      client: ["  url: http://127.0.0.1:8080/v1", "  contextSize: 65536"],
    });
    const opts = {
      adapterDir: adaptersDir,
      configPath,
      apiKeyRef: API_KEY_REF,
    };
    syncVsCodeEndpoints(opts);
    // User edits the adapter: context size changes.
    writeAdapter(adaptersDir, "qwen/a/a.yaml", {
      id: "a",
      name: "A",
      file: "./a.gguf",
      client: ["  url: http://127.0.0.1:8080/v1", "  contextSize: 131072"],
    });
    const result = syncVsCodeEndpoints(opts);
    expect(result.updated).toBe(true);
    const parsed = JSON.parse(readFileSync(configPath, "utf8"));
    expect(parsed[0].models[0].maxInputTokens).toBe(131072);
  });

  it("drops models from the generated block when their adapter loses a client block", () => {
    writeAdapter(adaptersDir, "qwen/a/a.yaml", {
      id: "a",
      name: "A",
      file: "./a.gguf",
      client: ["  url: http://127.0.0.1:8080/v1"],
    });
    writeAdapter(adaptersDir, "qwen/b/b.yaml", {
      id: "b",
      name: "B",
      file: "./b.gguf",
      client: ["  url: http://127.0.0.1:8081/v1"],
    });
    const opts = {
      adapterDir: adaptersDir,
      configPath,
      apiKeyRef: API_KEY_REF,
    };
    syncVsCodeEndpoints(opts);
    // B's client block is removed.
    writeAdapter(adaptersDir, "qwen/b/b.yaml", {
      id: "b",
      name: "B",
      file: "./b.gguf",
    });
    const result = syncVsCodeEndpoints(opts);
    expect(result.models).toEqual(["a"]);
    const parsed = JSON.parse(readFileSync(configPath, "utf8"));
    expect(parsed[0].models.map((m: { id: string }) => m.id)).toEqual(["a"]);
  });

  it("returns empty models and does not touch the file when no adapter has a client block", () => {
    writeAdapter(adaptersDir, "qwen/a/a.yaml", {
      id: "a",
      name: "A",
      file: "./a.gguf",
    });
    const result = syncVsCodeEndpoints({
      adapterDir: adaptersDir,
      configPath,
      apiKeyRef: API_KEY_REF,
    });
    expect(result.models).toEqual([]);
    expect(result.created).toBe(false);
    expect(result.updated).toBe(false);
    expect(existsSync(configPath)).toBe(false);
  });

  it("returns empty models for a missing adapter dir", () => {
    const result = syncVsCodeEndpoints({
      adapterDir: join(root, "does-not-exist"),
      configPath,
      apiKeyRef: API_KEY_REF,
    });
    expect(result.models).toEqual([]);
    expect(existsSync(configPath)).toBe(false);
  });
});

describe("Option C: contextSize fallback to resolved server recipe", () => {
  it("buildEndpointBlock uses the resolver when the client block omits contextSize", () => {
    const block = buildEndpointBlock(
      [{ id: "a", name: "A", client: { url: "http://127.0.0.1:8080/v1" } }],
      API_KEY_REF,
      () => 100_000,
    );
    expect(block.models).toEqual([
      {
        id: "a",
        name: "A",
        url: "http://127.0.0.1:8080/v1",
        toolCalling: true,
        vision: true,
        maxInputTokens: 100_000,
        maxOutputTokens: 16_384,
      },
    ]);
  });

  it("buildEndpointBlock lets a YAML contextSize win over the resolver", () => {
    const block = buildEndpointBlock(
      [
        {
          id: "a",
          name: "A",
          client: { url: "http://127.0.0.1:8080/v1", contextSize: 131_072 },
        },
      ],
      API_KEY_REF,
      () => 100_000,
    );
    expect(block.models).toEqual([
      {
        id: "a",
        name: "A",
        url: "http://127.0.0.1:8080/v1",
        toolCalling: true,
        vision: true,
        maxInputTokens: 131_072,
        maxOutputTokens: 16_384,
      },
    ]);
  });

  it("buildEndpointBlock falls back to the default when the resolver returns undefined", () => {
    const block = buildEndpointBlock(
      [{ id: "a", name: "A", client: { url: "http://127.0.0.1:8080/v1" } }],
      API_KEY_REF,
      () => undefined,
    );
    expect(block.models).toEqual([
      {
        id: "a",
        name: "A",
        url: "http://127.0.0.1:8080/v1",
        toolCalling: true,
        vision: true,
        maxInputTokens: 128_000,
        maxOutputTokens: 16_384,
      },
    ]);
  });

  it("buildEndpointBlock keeps the default when no resolver is supplied", () => {
    const block = buildEndpointBlock(
      [{ id: "a", name: "A", client: { url: "http://127.0.0.1:8080/v1" } }],
      API_KEY_REF,
    );
    expect(block.models).toEqual([
      {
        id: "a",
        name: "A",
        url: "http://127.0.0.1:8080/v1",
        toolCalling: true,
        vision: true,
        maxInputTokens: 128_000,
        maxOutputTokens: 16_384,
      },
    ]);
  });

  it("buildEndpointBlock lets a YAML maxOutputTokens win over the default", () => {
    const block = buildEndpointBlock(
      [
        {
          id: "a",
          name: "A",
          client: { url: "http://127.0.0.1:8080/v1", maxOutputTokens: 32_768 },
        },
      ],
      API_KEY_REF,
    );
    expect(block.models).toEqual([
      {
        id: "a",
        name: "A",
        url: "http://127.0.0.1:8080/v1",
        toolCalling: true,
        vision: true,
        maxInputTokens: 128_000,
        maxOutputTokens: 32_768,
      },
    ]);
  });

  it("syncVsCodeEndpoints applies the resolver fallback end-to-end", () => {
    const root = mkdtempSync(join(tmpdir(), "mba-endpoint-sync-"));
    const adaptersDir = join(root, "adapters");
    const configPath = join(root, "chatLanguageModels.json");
    try {
      writeAdapter(adaptersDir, "qwen/a/a.yaml", {
        id: "a",
        name: "A",
        file: "./a.gguf",
        client: ["  url: http://127.0.0.1:8080/v1"],
      });
      const result = syncVsCodeEndpoints({
        adapterDir: adaptersDir,
        configPath,
        apiKeyRef: API_KEY_REF,
        resolveCtxSize: () => 100_000,
      });
      expect(result.created).toBe(true);
      const parsed = JSON.parse(readFileSync(configPath, "utf8"));
      expect(parsed[0].models[0].maxInputTokens).toBe(100_000);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
