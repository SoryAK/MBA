# Model Behavioral Adapter (MBA) specification

- **Status:** Accepted
- **Date:** 2026-08-09
- **Deciders:** SoryAK, GitHub Copilot
- **Tags:** proxy, bcb, tcb, mba, adapter, config, model-identity

## Context and Problem Statement

Model behavior varies by weights, quantization, inference server, client harness, and IDE. The same `read_file` loop breaker that helps a weak local model may be unnecessary or counter-productive for a strong cloud model, and a grammar that works under llama.cpp may fail under vLLM. Today these differences are either hard-coded in c-yard or inferred at request time from the harness/model catalog key, not from a first-class model description.

We need a portable, consumer-agnostic way to say: *"For this model (or family), when running in this environment on this server, here are the behavioral rules and output-shape preferences."* c-yard should consume this specification, not own it.

## Decision Drivers

- Keep behavioral config close to the thing that actually changes (the model and its runtime), not the consumer pipeline.
- Allow operators to tune rules per model, environment, and inference server without duplicating files.
- Provide a family fallback so similar models share defaults.
- Make the format reusable by tools other than c-yard.
- Preserve live-editable JSONL rule bindings that map to "if this happens, do/say that."

## Considered Options

- **Option A — c-yard-native config extension:** extend the existing `.cyard-store/bcb/tool-circuit-breakers.json` with per-model sections. Fast to implement, but couples the format to c-yard internals and does not solve environment/server granularity.
- **Option B — Standalone MBA spec with YAML index + JSONL bindings:** define an independent Model Behavioral Adapter format. c-yard reads and maps it to its own rule implementations. Slightly more design work up front, but portable and cleanly layered.
- **Option C — Database-backed adapter registry:** store adapters in the corpus/memory DB with a web UI. Rich querying and sharing, but requires a running DB and hurts portability for standalone deployments.

## Decision Outcome

**Chosen option: "Option B"**, because a standalone file-based spec gives us portability, clear layering, and the live-editability we need without coupling to a particular storage backend.

### Positive Consequences

- The MBA spec can be consumed by c-yard and by other tools that need model-behavioral configuration.
- Rule bindings remain append-only JSONL files, easy to audit and edit live.
- Family fallback reduces duplication when many quantizations or server builds of the same model behave identically.
- Environment and server selectors let one model file cover multiple harness/IDE/server combinations by wildcarding fields.
- Alerts are sink-agnostic; the consumer decides which sink names it supports.

### Negative Consequences

- Consumers must implement adapter resolution, file loading, and rule-ID mapping.
- Per-runtime version comparators (llama.cpp build-tag numeric vs. semver subset) require a small custom parser per runtime.
- YAML + JSONL + JSON means three file parsers in the consumer.
- One-time migration of the existing global BCB config from `.cyard-store/bcb/` to `.MBA/bcb/`, with a temporary legacy-path fallback in the consumer until the move completes.

## Detailed Design

### Adapter identity and resolution

An adapter is selected by matching a request context against four identity dimensions:

1. **Model** — highest priority, matched in order:
   - `identity.model.dna.digest` (opaque weights hash) — authoritative when known.
   - `identity.model.name` — normalized request model name.
   - `identity.model.family` — broad family fallback.
2. **Environment** — `identity.environment.harness` and `identity.environment.ide`. A missing or `null` field is a wildcard.
3. **Server** — `identity.server.runtime` (e.g. `llama.cpp`, `vllm`, `ollama`) and optional `identity.server.version` range. Version comparators are per-runtime: `llama.cpp` build tags compare numerically (`b3659` → 3659; `>=` and `<` only), while `vllm` and `ollama` use a semver subset (`>=`, `<`, `~`). An unparseable range is treated as a wildcard and logged as a warning.

Resolution is a **layered merge**, not winner-takes-all: all matching adapters are collected, sorted by specificity ascending, and deep-merged so more-specific adapters override more-general ones per key. This is what lets a family adapter carry shared defaults while a dna-pinned adapter overrides only the knobs that differ. Specificity is scored per adapter:

| Dimension | Match | Score |
| --- | --- | --- |
| `model.dna.digest` | exact | 100 |
| `model.name` | exact | 50 |
| `model.family` | exact | 25 |
| `environment.harness` | exact / wildcard | 8 / 0 |
| `environment.ide` | exact / wildcard | 4 / 0 |
| `server.runtime` | exact / wildcard | 2 / 0 |
| `server.version` | in-range / absent | 1 / 0 |

An adapter binds at exactly one model identity level (`dna`, `name`, or `family`), so the model scores are mutually exclusive within one file. Equal-score ties are broken deterministically by `metadata.id` lexicographic order, and the consumer emits an `mba:ambiguous-resolution` alert event so the collision is visible rather than silent. For JSONL bindings, merge granularity is the `(tool, rule)` pair — a more-specific adapter's line replaces the more-general adapter's line wholesale; there is no param-level splicing. If no adapter matches, the consumer falls back to its global defaults.

### Cold-start identity

`model.dna.digest` is discovered from the upstream server (see `packages/proxy/src/kv/block-cache.ts`), but adapter resolution must happen before the request is dispatched. Therefore:

- On a cold first request, resolution uses `name`/`family` only.
- The consumer caches the digest keyed on `(upstream base URL, model name)` once discovered; subsequent requests re-resolve with the digest available.
- If mid-session re-resolution would change the `structural` config (grammar mode, tool-call dialect), the consumer pins the turn-1 adapter for the remainder of the session and emits `mba:adapter-upgrade-deferred` — swapping tool-call dialect between turns of one conversation is a correctness hazard.
- Cloud/harness-only models never expose a digest and resolve at `name`/`family` level permanently.

### YAML adapter index

Each adapter lives in its own YAML file. A file can represent an exact model, a model name, or a family; the `identity` block determines how it participates in resolution.

```yaml
apiVersion: mba.c-yard.dev/v1alpha1
kind: ModelBehavioralAdapter

metadata:
  id: qwen3-coder-30b-awq
  name: "Qwen3 Coder 30B AWQ"
  family: qwen3-coder

identity:
  model:
    dna:
      digest: "abc123..."
      quant: "Q4_K_M"
      build: "llama-b3659"
    name: "qwen3-coder-30b-awq"
  environment:
    harness: copilot      # null = wildcard
    ide: vscode           # null = wildcard
  server:
    runtime: llama.cpp    # llama.cpp | vllm | ollama | generic
    version: ">=b3659"    # optional range

bindings:
  bcb: "./qwen3-coder/copilot-vscode/llamacpp/bcb.jsonl"
  tcb: "./qwen3-coder/copilot-vscode/llamacpp/tcb.jsonl"
  structural: "./qwen3-coder/copilot-vscode/llamacpp/structural.json"

alerts:
  - events: ["tcb:tripped", "tcb:killed"]
    sink: stderr
    params:
      level: warn
  - events: ["tcb:killed"]
    sink: webhook
    params:
      url: "${CYARD_ALERT_WEBHOOK}"
```

### JSONL rule bindings

Both BCB and TCB bindings use the same line-oriented schema. Each line is a consumer-interpretable rule binding:

```jsonl
{"tool": "read_file", "rule": "readClamp", "enabled": true, "params": {}}
{"tool": "read_file", "rule": "repeatRun", "enabled": true, "params": {"threshold": 2, "kill": {"enabled": true, "ignoredTrips": 1, "action": "return-error"}}}
{"tool": "read_file", "rule": "eofOverflow", "enabled": true, "params": {"kill": {"enabled": true, "ignoredTrips": 1, "action": "return-error"}, "hint": {"enabled": true, "message": "[[c-yard: {filePath} has {actualLines} line(s). Do not call read_file beyond line {actualLines}; use the range you already have or ask a follow-up question.]]"}}}
```

- `rule` is a well-known identifier (e.g. `readClamp`, `repeatRun`, `eofOverflow`). The consumer maps rule IDs to its implementations.
- `params` is a per-rule bag of knobs. Consumers validate params and supply defaults when a field is absent.
- Optional message templates inside `params` let an adapter override the consumer's default wording; placeholders are rule-specific and documented by the rule implementation.

### Structural config

The structural binding controls output shape and negotiation behavior:

```json
{
  "grammar": {
    "mode": "forced-grammar",
    "fallback": "native-tools"
  },
  "signals": {
    "ready": "[[READY]]",
    "done": "[[DONE]]",
    "cancel": "[[CANCEL]]"
  },
  "toolCallFormat": {
    "preferred": "openai-tools",
    "accepts": ["openai-tools", "legacy-functions"]
  },
  "streaming": {
    "deltaFormat": "openai",
    "heartbeatMs": 5000
  }
}
```

- `grammar.mode`: `native-tools`, `forced-grammar`, or `negotiated-tools`.
- `grammar.fallback`: action when the preferred grammar mode cannot be applied.
- `signals`: optional dialog-box/state-machine tokens.
- `toolCallFormat`: preferred and accepted tool-call dialects.
- `streaming`: dialect-specific stream behavior such as delta format and keepalive cadence.

### Alert routing

Alerts route matched events to named sinks. The MBA spec defines the shape; the consumer defines which sinks are supported and how params are interpreted.

```yaml
alerts:
  - events: ["tcb:killed"]
    sink: webhook
    params:
      url: "${CYARD_ALERT_WEBHOOK}"
```

Event names are dot-separated and consumer-defined. Examples in c-yard today include `tcb:tripped`, `tcb:clamped`, `tcb:hint`, and `tcb:killed`. The spec additionally reserves `mba:*` events emitted by the resolution/loading machinery itself: `mba:ambiguous-resolution`, `mba:adapter-upgrade-deferred`, and `mba:load-error`.

`${VAR}` environment interpolation is expanded by the consumer at load time, and only in string values under `alerts[].params`. An undefined variable disables that alert entry and logs a warning — never empty-string substitution, which would post to a garbage URL. Expansion is non-recursive and never applies inside `bindings` paths (path-traversal surface).

### Loading, caching, and torn-read protection

- Consumers cache each parsed file keyed on mtime and re-parse only on change; live-editability is preserved without per-request parse cost.
- Writers SHOULD update adapter files atomically (write to a temp file, then rename into place).
- **Last-good semantics:** if any bound file fails to parse or resolve, the consumer keeps the previous successfully-loaded config for that adapter and emits `mba:load-error`. A torn read must fail closed (rules stay active), never open (rules silently disabled).
- Unknown `rule` IDs and unknown `params` keys are warn-and-ignore for forward compatibility; they never hard-fail the binding file.
- Consumers MUST reject adapters with an unrecognized `apiVersion` rather than best-effort parsing them.

### Consumer contract (c-yard)

At request time c-yard will:

1. Resolve all matching MBA adapters for the request context and merge them by ascending specificity.
2. Load the bound BCB, TCB, and structural config files relative to each adapter YAML.
3. Compose the effective config as layers: built-in defaults ← global `.MBA/bcb/tool-circuit-breakers.json` ← family adapter ← specific adapter — merged into the request-scoped `ToolCircuitBreakerConfig` shape. The global file is the legacy `ToolCircuitBreakerConfig` format, not an MBA adapter YAML; it provides a base layer before MBA resolution begins.
4. Map structural config to existing proxy behavior (grammar injection, tool dialect negotiation, SSE heartbeat). Merge is deep for objects and last-specific-wins for scalars and arrays.
5. Dispatch matched events to configured alert sinks in addition to the existing `onEvent` stream.

### File layout

All model-behavioral configuration — adapters and the global BCB/TCB config — consolidates under a single `.MBA/` root, replacing the current split across `.cyard-store/`:

```text
.MBA/
├── bcb/
│   └── tool-circuit-breakers.json   # global fallback layer (moved from .cyard-store/bcb/)
└── adapters/
    ├── qwen3-coder-30b-awq.yaml
    └── qwen3-coder/
        ├── family.yaml
        ├── copilot-vscode/
        │   └── llamacpp/
        │       ├── bcb.jsonl
        │       ├── tcb.jsonl
        │       └── structural.json
        └── cline-vscode/
            └── ...
```

Migration: the consumer looks in `.MBA/` first and falls back to the legacy `.cyard-store/bcb/` path until the move lands; the fallback is removed once migration completes. Exact layout is a consumer convention; the MBA spec only requires that bindings are resolvable relative paths.

## Pros and Cons of the Options

### Option A — c-yard-native config extension

- ✅ Fewer new abstractions; can reuse existing `ToolCircuitBreakerConfig` types directly.
- ❌ Ties the format to c-yard internals; not reusable by other tools.
- ❌ Per-model/environment/server granularity is awkward inside a single JSON file.

### Option B — Standalone MBA spec with YAML index + JSONL bindings

- ✅ Portable across consumers; clean separation between spec and implementation.
- ✅ Family fallback and wildcard selectors reduce duplication.
- ✅ JSONL bindings keep the "if this, do that" rule style editable and auditable.
- ❌ More design and parser surface up front (YAML, JSONL, JSON, version ranges).
- ❌ Consumers must map rule IDs to implementations and validate params.

### Option C — Database-backed adapter registry

- ✅ Shared state; easy to query and update across machines.
- ✅ Can enforce schemas and foreign keys.
- ❌ Requires a running DB for basic operation.
- ❌ Hurts portability and local experimentation.
- ❌ Overkill for a format whose primary use is file-based config.

## Links / References

- Current TCB subsystem: [ADR-0083 Tool Circuit Breaker subsystem for deterministic read-style tools](./0083-tool-circuit-breaker-subsystem.md)
- Read-clamp metadata policy: [ADR-0082 Read-clamp metadata always travels with read_file results; post-rewrite upstream body captured separately](./0082-read-clamp-metadata-and-upstream-body-capture.md)
- Core TCB orchestrator: `packages/core/src/bcb/tool-circuit-breaker.ts`
- Core TCB types: `packages/core/src/bcb/types.ts`
- Proxy BCB config lifecycle: `packages/proxy/src/bcb-config.ts`
- Proxy kill-state DB: `packages/proxy/src/db/bcb-kill-state.ts`
- Proxy integration seam: `packages/proxy/src/server.ts`
- Upstream model identity: `packages/proxy/src/kv/block-cache.ts`
