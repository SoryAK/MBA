/**
 * Tests for the GGUF-fields → draft-profile mapping (ADR-0098, Q2).
 *
 * Fixtures are grounded in real header dumps (qwen3.8-27b Q6_K,
 * nomic-embed-text-v1.5 Q4_K_M) — see ADR-0098.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { deriveGgufProfile, quantFromFilename } from "./gguf-profile.js";
import type { GgufMetadata } from "./gguf-metadata.js";

const digest = (s: string): string =>
  createHash("sha256").update(s).digest("hex").slice(0, 16);

const qwenFields: Record<string, unknown> = {
  "general.architecture": "qwen35",
  "general.name": "Qwen3.8 27B",
  "general.size_label": "27B",
  "general.license": "apache-2.0",
  "general.file_type": 18,
  "qwen35.block_count": 65,
  "qwen35.context_length": 262144,
  "qwen35.embedding_length": 5120,
  "qwen35.feed_forward_length": 17408,
  "qwen35.attention.head_count": 24,
  "qwen35.attention.head_count_kv": 4,
  "qwen35.attention.key_length": 256,
  "qwen35.attention.value_length": 256,
  "qwen35.rope.freq_base": 10000000,
  "tokenizer.ggml.model": "gpt2",
  "tokenizer.ggml.pre": "qwen35",
  "tokenizer.ggml.eos_token_id": 248046,
  "tokenizer.ggml.padding_token_id": 248044,
  "tokenizer.ggml.add_bos_token": false,
  "tokenizer.chat_template": "{%- if not messages %}...{%- endif %}",
};

const qwenMeta: GgufMetadata = {
  version: 3,
  tensorCount: 866n,
  kvCount: 45n,
  fields: qwenFields,
};

describe("quantFromFilename", () => {
  it("extracts the quant label from a standard GGUF filename", () => {
    expect(quantFromFilename("Qwen3.8-27B-Q6_K.gguf")).toBe("Q6_K");
    expect(quantFromFilename("nomic-embed-text-v1.5.Q4_K_M.gguf")).toBe("Q4_K_M");
    expect(quantFromFilename("model-f16.gguf")).toBe("F16");
    expect(quantFromFilename("model-bf16.gguf")).toBe("BF16");
    expect(quantFromFilename("model-Q8_0.gguf")).toBe("Q8_0");
  });

  it("returns undefined when no quant label is present", () => {
    expect(quantFromFilename("some-model.gguf")).toBeUndefined();
  });
});

describe("deriveGgufProfile", () => {
  it("maps a full qwen35 header to the draft profile", () => {
    const p = deriveGgufProfile(qwenMeta, "Qwen3.8-27B-Q6_K.gguf", "a".repeat(64));
    expect(p.architecture).toBe("qwen35");
    expect(p.sizeLabel).toBe("27B");
    expect(p.license).toBe("apache-2.0");
    expect(p.quant).toBe("Q6_K");
    expect(p.params).toEqual({
      blockCount: 65,
      maxContextLength: 262144,
      embeddingLength: 5120,
      feedForwardLength: 17408,
      headCount: 24,
      headCountKv: 4,
      keyLength: 256,
      valueLength: 256,
      ropeFreqBase: 10000000,
    });
    expect(p.tokenizer).toEqual({
      model: "gpt2",
      pre: "qwen35",
      eosTokenId: 248046,
      paddingTokenId: 248044,
      addBosToken: false,
      chatTemplateDigest: digest("{%- if not messages %}...{%- endif %}"),
    });
    expect(p.gguf).toEqual({
      version: 3,
      tensorCount: 866,
      kvCount: 45,
      fileFingerprint: "a".repeat(64),
    });
    // Not derivable from the header — must stay absent (draft adds TODOs).
    expect(p.baseModel).toBeUndefined();
    expect(p.gguf?.imatrix).toBeUndefined();
  });

  it("maps a sparse embedding-model header (nomic-bert)", () => {
    const meta: GgufMetadata = {
      version: 3,
      tensorCount: 350n,
      kvCount: 20n,
      fields: {
        "general.architecture": "nomic-bert",
        "general.name": "nomic-embed-text-v1.5",
        "general.file_type": 15,
        "nomic-bert.block_count": 12,
        "nomic-bert.embedding_length": 768,
        "nomic-bert.context_length": 8192,
        "tokenizer.ggml.model": "llama",
        "tokenizer.ggml.eos_token_id": 3,
      },
    };
    const p = deriveGgufProfile(meta, "nomic-embed-text-v1.5.Q4_K_M.gguf", "b".repeat(64));
    expect(p.architecture).toBe("nomic-bert");
    expect(p.quant).toBe("Q4_K_M");
    expect(p.sizeLabel).toBeUndefined();
    expect(p.license).toBeUndefined();
    expect(p.params).toEqual({
      blockCount: 12,
      maxContextLength: 8192,
      embeddingLength: 768,
    });
    expect(p.tokenizer).toEqual({
      model: "llama",
      eosTokenId: 3,
    });
    expect(p.gguf).toEqual({
      version: 3,
      tensorCount: 350,
      kvCount: 20,
      fileFingerprint: "b".repeat(64),
    });
  });

  it("omits the tokenizer block when no tokenizer fields are present", () => {
    const meta: GgufMetadata = {
      version: 3,
      tensorCount: 1n,
      kvCount: 2n,
      fields: { "general.architecture": "llama" },
    };
    const p = deriveGgufProfile(meta, "x.gguf", "c".repeat(64));
    expect(p.tokenizer).toBeUndefined();
    expect(p.params).toBeUndefined();
  });

  it("omits the chat template digest when the template is absent", () => {
    const fields = { ...qwenFields };
    delete fields["tokenizer.chat_template"];
    const meta: GgufMetadata = { ...qwenMeta, fields };
    const p = deriveGgufProfile(meta, "Qwen3.8-27B-Q6_K.gguf", "a".repeat(64));
    expect(p.tokenizer?.chatTemplateDigest).toBeUndefined();
  });

  it("leaves quant undefined when the filename carries no label", () => {
    const p = deriveGgufProfile(qwenMeta, "mystery-model.gguf", "a".repeat(64));
    expect(p.quant).toBeUndefined();
  });

  it("ignores imatrix header fields (build-machine absolute paths)", () => {
    const fields = {
      ...qwenFields,
      "quantize.imatrix.file": "/models_out/Qwen3.8-27B-imatrix.gguf",
      "quantize.imatrix.dataset": "/models_out/calibration.txt",
    };
    const meta: GgufMetadata = { ...qwenMeta, fields };
    const p = deriveGgufProfile(meta, "Qwen3.8-27B-Q6_K.gguf", "a".repeat(64));
    expect(p.gguf?.imatrix).toBeUndefined();
  });
});
