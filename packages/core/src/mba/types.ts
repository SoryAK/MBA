/**
 * Model Behavioral Adapter (MBA) types.
 *
 * These shapes implement ADR-0084. They are intentionally consumer-agnostic:
 * c-yard maps rule IDs and sink names to its own implementations.
 */

export interface MbaModelDna {
  /** Opaque weights-file digest — authoritative when known. */
  readonly digest?: string;
  /** Quantization label, e.g. "Q4_K_M". */
  readonly quant?: string;
  /** Server-reported build, e.g. "llama-b3659". */
  readonly build?: string;
}

/**
 * Immutable model facts extracted from the GGUF header (ADR-0091).
 *
 * This is the model's spec sheet: baked into the weights, unchangeable without
 * re-downloading. It is NOT configuration — boot-time dials live in
 * `server_setup` and are validated against these facts (e.g. a running
 * `ctxSize` must not exceed `params.maxContextLength`).
 *
 * `profile` is model-level and read-only at every rung: family adapters carry
 * no profile (a family may have many weights files), and environment override
 * folders may only contain binding files, never a profile.
 */
export interface MbaModelProfile {
  /** GGUF `general.architecture`, e.g. "qwen3moe". */
  readonly architecture?: string;
  /** GGUF `general.finetune`, e.g. "Instruct". */
  readonly finetune?: string;
  /** GGUF `general.size_label`, e.g. "30B-A3B". */
  readonly sizeLabel?: string;
  /** Quantization label, e.g. "Q4_K_M" (from `general.file_type`). */
  readonly quant?: string;
  /** GGUF `general.quantized_by`, e.g. "Unsloth". */
  readonly quantizedBy?: string;
  /** GGUF `general.license`, e.g. "apache-2.0". */
  readonly license?: string;
  /** Upstream base model, e.g. "Qwen/Qwen3-Coder-30B-A3B-Instruct". */
  readonly baseModel?: string;
  /** Architecture parameters (the `<arch>.*` GGUF fields). */
  readonly params?: MbaModelProfileParams;
  /** Tokenizer facts (the `tokenizer.ggml.*` GGUF fields). */
  readonly tokenizer?: MbaModelProfileTokenizer;
  /** GGUF container facts. */
  readonly gguf?: MbaModelProfileGguf;
}

/** Architecture parameters. `maxContextLength` is the CEILING, not a setting. */
export interface MbaModelProfileParams {
  /** `<arch>.block_count`. */
  readonly blockCount?: number;
  /**
   * `<arch>.context_length` — the maximum context the weights support.
   * Renamed from the GGUF field so the ceiling is never mistaken for the
   * running `ctxSize` dial (ADR-0091).
   */
  readonly maxContextLength?: number;
  /** `<arch>.embedding_length`. */
  readonly embeddingLength?: number;
  /** `<arch>.feed_forward_length`. */
  readonly feedForwardLength?: number;
  /** `<arch>.attention.head_count`. */
  readonly headCount?: number;
  /** `<arch>.attention.head_count_kv`. */
  readonly headCountKv?: number;
  /** `<arch>.attention.key_length`. */
  readonly keyLength?: number;
  /** `<arch>.attention.value_length`. */
  readonly valueLength?: number;
  /** `<arch>.rope.freq_base`. */
  readonly ropeFreqBase?: number;
  /** `<arch>.expert_count` (MoE). */
  readonly expertCount?: number;
  /** `<arch>.expert_used_count` (MoE). */
  readonly expertUsedCount?: number;
  /** `<arch>.expert_feed_forward_length` (MoE). */
  readonly expertFeedForwardLength?: number;
}

/** Tokenizer facts. The chat template is bulky, so only its digest is kept. */
export interface MbaModelProfileTokenizer {
  /** `tokenizer.ggml.model`, e.g. "gpt2". */
  readonly model?: string;
  /** `tokenizer.ggml.pre`, e.g. "qwen2". */
  readonly pre?: string;
  /** `tokenizer.ggml.eos_token_id`. */
  readonly eosTokenId?: number;
  /** `tokenizer.ggml.padding_token_id`. */
  readonly paddingTokenId?: number;
  /** `tokenizer.ggml.add_bos_token`. */
  readonly addBosToken?: boolean;
  /** sha256 (first 16 hex) of `tokenizer.chat_template`. */
  readonly chatTemplateDigest?: string;
}

/** GGUF container facts. */
export interface MbaModelProfileGguf {
  /** GGUF format version. */
  readonly version?: number;
  /** Number of tensors in the file. */
  readonly tensorCount?: number;
  /** Number of metadata key/value pairs. */
  readonly kvCount?: number;
  /**
   * Fingerprint of the weights file (sha256 of path+size+mtime, as used by
   * the gguf-metadata cache). Makes profile-vs-weights drift detectable.
   */
  readonly fileFingerprint?: string;
  /** `quantize.imatrix.*` facts when the quantization used an imatrix. */
  readonly imatrix?: {
    readonly file?: string;
    readonly dataset?: string;
  };
}

export interface MbaModelIdentity {
  readonly dna?: MbaModelDna;
  /** Normalized request model name. */
  readonly name?: string;
  /** Broad model family, e.g. "qwen3-coder". */
  readonly family?: string;
  /**
   * Declared lineage, root → leaf, e.g. `[qwen, qwen3-coder]`. The folder
   * path under `adapters/` is the source of truth; this field is a label the
   * resolver cross-checks against the path (ADR-0090).
   */
  readonly lineage?: readonly string[];
  /**
   * Absolute path to the weights file on disk (ADR-0091). Lives with
   * `profile` — one fact: "these weights, at this path, with this spec
   * sheet." Consumed by the MBA MCP server for GGUF metadata extraction.
   * Model-level only: family adapters must not set it.
   */
  readonly file?: string;
  /** Immutable model facts from the GGUF header (ADR-0091). */
  readonly profile?: MbaModelProfile;
}

export interface MbaEnvironmentIdentity {
  /** Client harness, e.g. "copilot". `null` = wildcard. */
  readonly harness?: string | null;
  /** IDE/editor, e.g. "vscode". `null` = wildcard. */
  readonly ide?: string | null;
}

export interface MbaServerIdentity {
  /** Inference runtime, e.g. "llama.cpp", "vllm", "ollama". `null` = wildcard. */
  readonly runtime?: string | null;
  /** Optional version range, e.g. ">=b3659". */
  readonly version?: string | null;
}

export interface MbaIdentity {
  readonly model: MbaModelIdentity;
  readonly environment?: MbaEnvironmentIdentity;
  readonly server?: MbaServerIdentity;
}

export interface MbaMetadata {
  readonly id: string;
  readonly name?: string;
  readonly family?: string;
}

export interface MbaBindings {
  readonly bcb?: string;
  readonly tcb?: string;
  readonly structural?: string;
  /** Optional per-adapter rule-class definitions file (JSON), layered over built-ins. */
  readonly ruleClasses?: string;
  /**
   * Optional per-adapter server boot flags file (JSON), merged like structural.
   * Named `server_setup` in YAML to avoid colliding with `identity.server`
   * (which describes the runtime, not the flags).
   */
  readonly server_setup?: string;
}

export interface MbaAlert {
  readonly events: readonly string[];
  readonly sink: string;
  readonly params: Readonly<Record<string, unknown>>;
}

export interface MbaAdapter {
  readonly apiVersion: string;
  readonly kind: "ModelBehavioralAdapter";
  readonly metadata: MbaMetadata;
  readonly identity: MbaIdentity;
  readonly bindings: MbaBindings;
  readonly alerts?: readonly MbaAlert[];
}

export interface MbaGrammarConfig {
  readonly mode?: "native-tools" | "forced-grammar" | "negotiated-tools";
  readonly fallback?: "native-tools" | "forced-grammar" | "negotiated-tools" | "error";
}

export interface MbaSignalsConfig {
  readonly ready?: string;
  readonly done?: string;
  readonly cancel?: string;
}

export interface MbaToolCallFormatConfig {
  readonly preferred?: string;
  readonly accepts?: readonly string[];
}

export interface MbaStreamingConfig {
  readonly deltaFormat?: string;
  readonly heartbeatMs?: number;
}

export interface MbaStructuralConfig {
  readonly grammar?: MbaGrammarConfig;
  readonly signals?: MbaSignalsConfig;
  readonly toolCallFormat?: MbaToolCallFormatConfig;
  readonly streaming?: MbaStreamingConfig;
}

/**
 * Per-runtime server boot flags carried by an MBA adapter (bound via
 * `bindings.server`, merged like `structural`). Keyed by inference runtime so
 * a single adapter can later carry both llama.cpp and vLLM recipes without
 * collision.
 *
 * These are MODEL-TUNING knobs only. Deployment parameters (model path,
 * port, host, binary path, fork) are passed separately to the boot function
 * and are deliberately NOT part of the recipe.
 */
export interface MbaServerConfig {
  readonly "llama.cpp"?: LlamaCppServerFlags;
  readonly "vllm"?: VllmServerFlags;
}

/**
 * llama.cpp boot tuning knobs. Every field is optional; omitted fields fall
 * back to `LLAMA_CPP_DEFAULTS` (which mirror scripts/llama-server-up.sh).
 * Values are validated against `LLAMA_CPP_RANGES` before use.
 */
export interface LlamaCppServerFlags {
  /** --ctx-size. Context window in tokens. */
  readonly ctxSize?: number;
  /** -ngl. GPU layers to offload. */
  readonly gpuLayers?: number;
  /** --threads. CPU threads. */
  readonly threads?: number;
  /** --parallel. KV slots. */
  readonly parallel?: number;
  /** --cache-reuse. KV cache reuse granularity (tokens). */
  readonly cacheReuse?: number;
  /** --cache-ram. KV cache RAM in MiB. */
  readonly cacheRam?: number;
  /** --reasoning-budget. Reasoning token cap. */
  readonly reasoningBudget?: number;
  /** --reasoning-preserve. Preserve thinking trace in context history. Boot script default is on. */
  readonly reasoningPreserve?: boolean;
  /** --flash-attn. FlashAttention on/off. */
  readonly flashAttn?: "on" | "off";
  /** Post-boot warm-up generation length (tokens). */
  readonly warmupTokens?: number;
  /** --spec-type. Speculative decoding mode (e.g. "draft-mtp", "none"). */
  readonly specType?: string;
  /** --spec-draft-n-max. Max speculative decode draft tokens when specType is not "none". */
  readonly specDraftMax?: number;
  /**
   * Open-ended llama.cpp flags MBA does not manage (ADR-0100). Key = flag name
   * WITHOUT the leading `--` (e.g. `"n-cpu-moe"`, `"no-mmap"`); value = its
   * value. A boolean `true` emits a bare flag (`--no-mmap`); `false` omits it;
   * a string/number emits `--key value`. Keys that collide with a flag MBA
   * already manages are rejected at boot (use the typed field instead).
   */
  readonly extraArgs?: Record<string, string | number | boolean>;
}

/**
 * vLLM boot tuning knobs. Reserved for a future runtime; placeholder shape so
 * the `MbaServerConfig` union is stable. Not consumed by the v1 boot path.
 */
export interface VllmServerFlags {
  /** --max-model-len. Context window in tokens. */
  readonly maxModelLen?: number;
  /** --gpu-memory-utilization. Fraction of GPU memory (0..1). */
  readonly gpuMemoryUtilization?: number;
  /** --tensor-parallel-size. Tensor-parallel degree. */
  readonly tensorParallelSize?: number;
}

export interface MbaResolutionContext {
  /** Request model name from the inbound body. */
  readonly modelName: string;
  /** Optional family hint when the consumer already knows it. */
  readonly modelFamily?: string;
  /**
   * Optional lineage hint, root → leaf, e.g. `[qwen, qwen3-coder]`. When
   * absent, the resolver derives it from the family hint (single segment).
   */
  readonly modelLineage?: readonly string[];
  /** Optional upstream DNA when already discovered. */
  readonly modelDna?: MbaModelDna;
  /** Harness derived from system prompt + user-agent fingerprint. */
  readonly harness: string;
  /** IDE when known; defaults to a wildcard if absent. */
  readonly ide?: string;
  /** Inference runtime when known; defaults to "generic". */
  readonly serverRuntime?: string;
  /** Runtime version when known. */
  readonly serverVersion?: string;
}

export interface MbaResolvedConfig {
  /** Effective BCB/TCB config merged from all matching layers. */
  readonly bcbConfig: import("../bcb/types.js").ToolCircuitBreakerConfig;
  /** Effective structural config merged from all matching layers. */
  readonly structural: MbaStructuralConfig;
  /** Effective server boot flags recipe merged from all matching layers. */
  readonly server: MbaServerConfig;
  /** Alert routes merged from all matching layers. */
  readonly alerts: readonly MbaAlert[];
  /** Adapter ids selected, most-specific last. */
  readonly selectedIds: readonly string[];
  /**
   * The matched model adapter's immutable profile (ADR-0091), when the most
   * specific selected adapter declares one. Never merged — read straight off
   * the model. Consumers use it to validate dials (e.g. ctxSize ceiling).
   */
  readonly profile?: MbaModelProfile;
  /** Optional resolution diagnostics events for consumers to emit. */
  readonly diagnostics: readonly MbaResolutionDiagnostic[];
}

export interface MbaResolutionDiagnostic {
  readonly kind:
    | "ambiguous-resolution"
    | "adapter-upgrade-deferred"
    | "load-error"
    | "lineage-mismatch"
    | "rule-class-override"
    | "unknown-rule-class"
    /** A server_setup dial exceeds the model profile's ceiling (ADR-0091). */
    | "ceiling-violation"
    /** An old-style environment adapter YAML was used (ADR-0091 migration). */
    | "env-adapter-deprecated";
  readonly message: string;
  readonly adapterIds?: readonly string[];
}

/** One line inside a BCB/TCB JSONL binding file. */
export interface MbaRuleBindingLine {
  readonly tool: string;
  /** Single-rule binding. Exactly one of `rule` / `ruleClass` is set. */
  readonly rule?: string;
  /** Rule-class binding: one class name, or several applied in order. */
  readonly ruleClass?: string | readonly string[];
  readonly enabled: boolean;
  readonly params?: Readonly<Record<string, unknown>>;
  /** Rule-class only: per-member param overrides, keyed by member rule id. */
  readonly overrides?: Readonly<Record<string, Record<string, unknown>>>;
}
