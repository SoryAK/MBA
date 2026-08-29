import { describe, expect, it } from "vitest";
import YAML from "yaml";
import type { MbaModelProfile } from "../mba/types.js";
import { draftAdapterYaml, draftFamilyYaml } from "./draft-adapter.js";

const profile: MbaModelProfile = {
  architecture: "qwen35",
  sizeLabel: "27B",
  quant: "Q6_K",
  license: "apache-2.0",
  params: {
    blockCount: 65,
    maxContextLength: 262144,
    embeddingLength: 5120,
    feedForwardLength: 17408,
    headCount: 24,
    headCountKv: 4,
    keyLength: 256,
    valueLength: 256,
    ropeFreqBase: 10000000,
  },
  tokenizer: {
    model: "gpt2",
    pre: "qwen35",
    eosTokenId: 248046,
    paddingTokenId: 248044,
    addBosToken: false,
    chatTemplateDigest: "c3cf9e34abf4f9e3",
  },
  gguf: {
    version: 3,
    tensorCount: 866,
    kvCount: 45,
    fileFingerprint: "a753855db270898040e44a15661e22248142f614e5221daf172e59868c9a4034",
  },
};

describe("draftAdapterYaml", () => {
  const input = {
    id: "qwen3.8-27b",
    family: "qwen",
    fileName: "Qwen3.8-27B-Q6_K.gguf",
    sha256: "a753855db270898040e44a15661e22248142f614e5221daf172e59868c9a4034",
    profile,
  };

  it("produces valid YAML with the adapter envelope", () => {
    const text = draftAdapterYaml(input);
    const doc = YAML.parse(text) as Record<string, any>;
    expect(doc.apiVersion).toBe("mba.c-yard.dev/v1alpha1");
    expect(doc.kind).toBe("ModelBehavioralAdapter");
    expect(doc.metadata).toEqual({ id: "qwen3.8-27b", name: "qwen3.8-27b", family: "qwen" });
  });

  it("wires identity.model with lineage, file, and the derived profile", () => {
    const doc = YAML.parse(draftAdapterYaml(input)) as Record<string, any>;
    const model = doc.identity.model;
    expect(model.lineage).toEqual(["qwen", "qwen3.8-27b"]);
    expect(model.file).toBe("./Qwen3.8-27B-Q6_K.gguf");
    expect(model.profile).toEqual({
      ...profile,
      baseModel: "[ input base models here once determined ]",
    });
    expect(model.name).toBe("qwen3.8-27b");
  });

  it("uses baseModel for profile.baseModel when provided", () => {
    const doc = YAML.parse(
      draftAdapterYaml({ ...input, baseModel: "unsloth/Qwen3.8-27B-GGUF" }),
    ) as Record<string, any>;
    expect(doc.identity.model.profile.baseModel).toBe("unsloth/Qwen3.8-27B-GGUF");
  });

  it("notes the baseModel derivation in a trailing comment", () => {
    const text = draftAdapterYaml({ ...input, baseModel: "unsloth/Qwen3.8-27B-GGUF" });
    expect(text).toMatch(/derived from the download source/);
  });

  it("omits the baseModel derivation comment when baseModel is absent", () => {
    const text = draftAdapterYaml(input);
    expect(text).not.toMatch(/derived from the download source/);
  });

  it("uses ggufName for metadata.name and identity.model.name when provided", () => {
    const doc = YAML.parse(draftAdapterYaml({ ...input, ggufName: "Qwen3.8 27B" })) as Record<string, any>;
    expect(doc.metadata.name).toBe("Qwen3.8 27B");
    expect(doc.identity.model.name).toBe("Qwen3.8 27B");
    // id stays the id — only the display name changes
    expect(doc.metadata.id).toBe("qwen3.8-27b");
  });

  it("notes the ggufName derivation in a trailing comment", () => {
    const text = draftAdapterYaml({ ...input, ggufName: "Qwen3.8 27B" });
    expect(text).toMatch(/derived from the GGUF header/);
  });

  it("omits the derivation comment when ggufName is absent", () => {
    const text = draftAdapterYaml(input);
    expect(text).not.toMatch(/derived from the GGUF header/);
  });

  it("marks imatrix as TODO (not derivable from the download)", () => {
    const text = draftAdapterYaml(input);
    expect(text).toMatch(/imatrix/);
    expect(text).toMatch(/TODO/);
    const doc = YAML.parse(text) as Record<string, any>;
    // imatrix must not be a populated object in the draft
    expect(doc.identity.model.profile.imatrix).toBeUndefined();
  });

  it("defaults client to localhost:8080 with toolCalling on, vision off", () => {
    const doc = YAML.parse(draftAdapterYaml(input)) as Record<string, any>;
    expect(doc.client).toEqual({
      url: "http://127.0.0.1:8080/v1",
      toolCalling: true,
      vision: false,
    });
  });

  it("points bindings at the scaffolded sibling files", () => {
    const doc = YAML.parse(draftAdapterYaml(input)) as Record<string, any>;
    expect(doc.bindings).toEqual({
      bcb: "./bcb.jsonl",
      tcb: "./tcb.jsonl",
      server_setup: "./server_setup.json",
    });
  });

  it("keeps the draft sparse when the profile has no tokenizer", () => {
    const sparse = { ...profile, tokenizer: undefined };
    const doc = YAML.parse(draftAdapterYaml({ ...input, profile: sparse })) as Record<string, any>;
    expect(doc.identity.model.profile.tokenizer).toBeUndefined();
  });
});

describe("draftFamilyYaml", () => {
  it("produces the family-tier adapter (no file, no profile)", () => {
    const text = draftFamilyYaml({ family: "qwen" });
    const doc = YAML.parse(text) as Record<string, any>;
    expect(doc.apiVersion).toBe("mba.c-yard.dev/v1alpha1");
    expect(doc.kind).toBe("ModelBehavioralAdapter");
    expect(doc.metadata).toEqual({ id: "qwen-family", name: "Qwen", family: "qwen" });
    expect(doc.identity.model).toEqual({ family: "qwen", lineage: ["qwen"] });
    expect(doc.bindings).toEqual({
      bcb: "./bcb.jsonl",
      tcb: "./tcb.jsonl",
      structural: "./structural.json",
      server_setup: "./server_setup.json",
    });
  });

  it("title-cases hyphenated family slugs", () => {
    const doc = YAML.parse(draftFamilyYaml({ family: "llama-3" })) as Record<string, any>;
    expect(doc.metadata.name).toBe("Llama 3");
  });
});
