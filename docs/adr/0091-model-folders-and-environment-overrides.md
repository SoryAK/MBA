# Model folders and environment override folders

- **Status:** Accepted
- **Date:** 2026-08-18
- **Deciders:** skaba + agent
- **Tags:** mba, proxy, configuration

## Context and Problem Statement

The MBA adapter layout (ADR-0084, ADR-0090) encodes *both* model lineage and
environment in the folder tree:
`adapters/qwen/qwen3-coder/copilot-vscode/llamacpp/qwen3-coder-30b.yaml`. Each
environment is a separate adapter YAML that re-declares the model identity and
is scored independently (harness 8 / ide 4 / runtime 2). This has three
problems:

1. **Identity duplication.** Every environment YAML repeats the model's
   `name`/`lineage`. The weights do not change when the harness does, so the
   identity block is pure duplication that can drift.
2. **No place for model facts.** The GGUF header carries the information that
   makes a model unique (architecture, MoE expert counts, max context length,
   tokenizer, quant, license). The schema has no field for it:
   `identity.model` only accepts `dna`/`name`/`family`/`lineage`, and the
   MCP server's `identity.model.file` pointer (which feeds the GGUF metadata
   cache) is not part of the proxy's type at all.
3. **Facts and dials are conflated.** Some metadata is immutable (the spec
   sheet baked into the weights: 262144 max context, 128 experts / 8 used)
   while some is a boot-time dial the operator chooses (run at 100000 ctx,
   8 threads). Today both live in `server_setup.json` with nothing
   distinguishing a ceiling from a setting, and nothing validates that a dial
   stays under the model's ceiling.

Meanwhile the environment dimension is genuinely override-heavy: an
environment may want to override *any* of the four binding surfaces (bcb,
tcb, structural, server_setup), and some overrides are family-wide ("copilot
always gets forced-grammar") while others are model-specific ("this 30B runs
at 100k ctx on this box").

## Decision Drivers

- **One mental model** — family, model, and environment should all be the same
  shape: a scope folder containing a YAML (identity), binding files (dials),
  and optional sub-scopes.
- **Facts vs dials** — immutable model facts must be structurally
  distinguishable from mutable boot dials, and dials must be checkable against
  facts (e.g. `ctxSize ≤ maxContextLength`).
- **Write-once environment policies** — a family-wide environment override
  must be expressible once and inherited by every model in the branch.
- **Discoverability** — the tree must stay self-documenting in the file
  explorer (ADR-0090's core property).
- **Backward compatibility** — existing environment adapter YAMLs must keep
  resolving during migration.
- **MCP server continuity** — `tools/mba-mcp-server` reads
  `identity.model.file` to extract GGUF metadata; that contract must survive.

## Considered Options

- **Option A — Environments as a YAML section.** One YAML per model with a
  nested `environments:` map; environment overrides inline or by path.
- **Option B — Model = folder, environments = subfolders of binding files.**
  The model becomes a folder mirroring the family shape (YAML + bcb/tcb/
  structural/server_setup). `environments/` subfolders — at both family and
  model level — contain *only* the binding files they override. Folder name
  is the match key: `harness[+ide[+runtime]]` (`+`-separated — hyphens are
  legal inside segment values and inside the model folder names that host
  these), partial names act as wildcards, most-specific wins.
- **Option C — Status quo.** Keep one adapter YAML per (model × environment)
  pair with independent scoring.

## Decision Outcome

**Chosen option: "Option B"**, because it is the *same* pattern the family
already uses, recursed: a scope folder with a YAML plus binding files. The
facts/dials split falls out of folder structure rather than validation rules —
an environment folder can only ever contain the four binding file types, so
it is structurally impossible for an environment to touch the model's
`profile`.

### The shape

```text
.MBA/adapters/qwen/qwen3-coder/
├── family.yaml                        # family identity + bindings
├── bcb.jsonl                          # family default dials
├── tcb.jsonl
├── structural.json
├── server_setup.json
├── environments/                      # family-wide environment policies
│   └── copilot+vscode+llamacpp/
│       └── server_setup.json          # only files that override
└── qwen3-coder-30b/                   # THE MODEL = a folder
    ├── qwen3-coder-30b.yaml           # identity + profile (facts) + bindings
    ├── bcb.jsonl                      # model default dials
    ├── tcb.jsonl
    ├── structural.json
    ├── server_setup.json
    └── environments/                  # model-specific environment overrides
        └── copilot+vscode+llamacpp/
            └── server_setup.json
```

### The model YAML

```yaml
apiVersion: mba.c-yard.dev/v1alpha1
kind: ModelBehavioralAdapter
metadata:
  id: qwen3-coder-30b
  name: "Qwen3 Coder 30B"
  family: qwen3-coder
identity:
  model:
    name: "Qwen3-Coder-30B-A3B-Instruct"
    lineage: [qwen, qwen3-coder]
    file: "/mnt/nas/AI_Models/qwen3/Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf"
    profile:                        # FACTS — immutable, from the GGUF header
      architecture: qwen3moe
      finetune: Instruct
      sizeLabel: "30B-A3B"
      quant: "Q4_K_M"
      quantizedBy: Unsloth
      license: apache-2.0
      baseModel: "Qwen/Qwen3-Coder-30B-A3B-Instruct"
      params:
        blockCount: 48
        maxContextLength: 262144    # the CEILING, not a setting
        embeddingLength: 2048
        feedForwardLength: 5472
        headCount: 32
        headCountKv: 4
        keyLength: 128
        valueLength: 128
        ropeFreqBase: 10000000
        expertCount: 128
        expertUsedCount: 8
        expertFeedForwardLength: 768
      tokenizer:
        model: gpt2
        pre: qwen2
        eosTokenId: 151645
        paddingTokenId: 151654
        addBosToken: false
        chatTemplateDigest: "sha256:<16 hex>"
      gguf:
        version: 3
        tensorCount: 579
        kvCount: 44
        fileFingerprint: "<sha256 of path+size+mtime>"
        imatrix:
          file: "Qwen3-Coder-30B-A3B-Instruct-GGUF/imatrix_unsloth.gguf"
          dataset: "unsloth_calibration_Qwen3-Coder-30B-A3B-Instruct.txt"
bindings:
  bcb: "./bcb.jsonl"
  tcb: "./tcb.jsonl"
  structural: "./structural.json"
  server_setup: "./server_setup.json"
```

### Invariants

1. **`profile` is model-level and read-only at every rung.** The family
   adapter carries no `file`/`profile` (a family may have many weights
   files); environments may not touch it. The GGUF `context_length` field is
   renamed `maxContextLength` in the profile so the ceiling is never
   mistaken for the running `ctxSize`.
2. **Environment folders contain only binding files** (`bcb.jsonl`,
   `tcb.jsonl`, `structural.json`, `server_setup.json`). Absent file =
   inherit. The loader looks for exactly these four names inside
   `environments/<name>/`, so a `profile` there is simply not read.
3. **Environment folder name = match key.** Segments are
   `harness[+ide[+runtime]]` (e.g. `copilot+vscode+llamacpp`), joined with
   `+` rather than `-` because model folder names are hyphenated
   (`qwen3-coder-30b`) and a hyphen split would misparse them. Segments are
   compared normalized (lowercased, non-alphanumerics stripped), so the slug
   `llamacpp` matches the runtime `llama.cpp`. Partial names are wildcards:
   `environments/copilot/` matches any IDE/runtime. When
   multiple environment folders match, the most-specific (most segments)
   wins; ties are broken by the existing deterministic rules and surfaced as
   diagnostics.
4. **`file` lives with `profile`** — one fact: "these weights, at this path,
   with this spec sheet." The MCP server's existing
   `identity.model.file` contract is unchanged.

### Merge ladder

Four rungs, least → most specific, same deep-merge / last-wins semantics as
today:

```text
1. family bindings            qwen3-coder/bcb.jsonl, ...
2. family environment         qwen3-coder/environments/<env>/...
3. model bindings             qwen3-coder/qwen3-coder-30b/bcb.jsonl, ...
4. model environment          qwen3-coder/qwen3-coder-30b/environments/<env>/...
```

A family-wide environment policy (rung 2) is overridable by the model's own
defaults (rung 3), which are overridable by the model's own environment
folder (rung 4). `profile` is never merged — it is read straight off the
matched model.

### Validation

At merge time the resolver checks dial ceilings against facts and emits an
`mba:diagnostic` (warn) on violation — first rule:
`server_setup["llama.cpp"].ctxSize > profile.params.maxContextLength`.

### Positive Consequences

- One uniform mental model: scope folder = YAML + binding files + sub-scopes.
  Adding a model is `mkdir` + one YAML; adding an environment override is
  dropping one small file in a folder.
- Identity is declared exactly once per model; environments cannot drift it.
- The unique model facts (GGUF metadata) have a canonical home, co-located
  with the `file` pointer that produced them.
- Facts/dials separation is enforced by folder structure, not by runtime
  validation — the impossible case (environment editing facts) cannot be
  expressed.
- Family-wide environment policies are writable once.
- Ceiling checks (dials vs facts) become possible and cheap.

### Negative Consequences

- The resolver's environment handling changes from "score a separate adapter
  YAML" to "select a folder by name segments" — a real code change in
  `packages/proxy/src/mba/resolver.ts`, with a backward-compat path for old
  environment YAMLs (deprecation diagnostic until migration completes).
- More folders = deeper paths; the tree grows vertically as environments
  accumulate.
- The 4-rung merge order (rung 2 below rung 3) is a policy choice: a model
  *can* break a family-wide environment policy. If that ever proves too
  permissive, the ladder order is a one-line change but a behavior break.
- `profile` is hand-maintained in the YAML (transcribed from the GGUF
  metadata cache). Drift between the weights file and the profile is possible;
  the `gguf.fileFingerprint` field makes drift detectable but does not
  auto-refresh the profile.

## Pros and Cons of the Options

### Option A — Environments as a YAML section

- ✅ One file per model; no extra folders.
- ❌ Special-case schema (`environments:` map) bolted onto the adapter shape —
  breaks the uniform scope-folder pattern.
- ❌ Inline overrides bloat the model YAML; path-based overrides recreate the
  folder structure one level deeper anyway.
- ❌ "Only override dials" must be enforced by validation, not structure.

### Option B — Model = folder, environments = subfolders (chosen)

- ✅ Uniform with the existing family shape; one mental model.
- ✅ Override granularity is per-file: drop only the files that differ.
- ✅ Facts/dials invariant enforced by folder structure.
- ✅ Family-wide environment policies expressible once.
- ❌ Resolver rewrite for environment selection + backward-compat path.
- ❌ Deeper tree.

### Option C — Status quo (one YAML per model × environment)

- ✅ No code change.
- ❌ Identity duplication per environment; drift risk.
- ❌ Still no home for model facts.
- ❌ No family-wide environment policy without duplicating across models.

## Implementation Notes

- `packages/proxy/src/mba/types.ts` — add `MbaModelProfile`; add
  `file?: string` and `profile?: MbaModelProfile` to `MbaModelIdentity`.
- `packages/proxy/src/mba/resolver.ts` — environment folder selection by name
  segments against `(harness, ide, runtime)` with wildcard fallback; 4-rung
  deep-merge for bcb/tcb/structural/server_setup; ceiling diagnostic;
  old-style environment adapter YAMLs still load and emit a deprecation
  diagnostic.
- `tools/mba-mcp-server/src/adapter/loader.ts` — add `file`/`profile` to its
  `MbaAdapter` interface (it already reads `file`; `profile` is pass-through).
- Migration: `.MBA/adapters/qwen/qwen3-coder/copilot-vscode/llamacpp/`
  contents move to `qwen3-coder-30b/environments/copilot+vscode+llamacpp/`;
  the model YAML moves into its own folder with `file` + `profile` populated
  from the GGUF metadata cache; `family.yaml` drops its `file:` line (it
  moves to the model, where it belongs with `profile`) and gains
  `lineage: [qwen, qwen3-coder]`; `.MBA/README.md` layout section updated.
- Tests: env folder selection (exact + wildcard), 4-rung merge order, ceiling
  diagnostic, old-style YAML deprecation path.

## Related

- [ADR-0084](./0084-model-behavioral-adapter-specification.md) — MBA
  specification. This ADR supersedes its environment-as-adapter-file scoring
  (harness/ide/runtime rows) with environment-folder selection; the model
  identity ladder (dna > name > family) is unchanged.
- [ADR-0085](./0085-mba-as-mcp-server.md) — MBA as MCP server; the
  `identity.model.file` → GGUF metadata cache contract it relies on is
  preserved.
- [ADR-0089](./0089-per-model-server-auto-reboot.md) — per-model server
  auto-reboot; consumes the merged `server_setup` recipe this ladder
  produces.
- [ADR-0090](./0090-adapter-lineage-tree.md) — folder tree = lineage; stays
  intact. This ADR demotes environment from "folder rung" to "subfolder of a
  scope" and keeps lineage folders as the ancestry rungs.
