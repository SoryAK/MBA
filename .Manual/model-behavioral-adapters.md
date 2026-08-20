# Model Behavioral Adapters (MBA)

## Feature Name

Model Behavioral Adapter (MBA) configuration system.

## Functional Description

MBA lets operators describe how a specific model (or model family) should behave across different client environments and inference servers. Instead of one global circuit-breaker config, you can say:

- *"Qwen3-Coder 30B AWQ running under Copilot in VS Code via llama.cpp uses these BCB rules and this grammar mode."*
- *"The same model under Cline uses a different grammar fallback."*

The proxy resolves the right adapter per request and applies the merged configuration.

## Internal Workflow

1. **Startup** — `main.ts` computes `MBA_DIR` from `CYARD_MBA_DIR` or defaults to the repository root `.MBA/` next to `.Manual/`. `server.ts` uses the same default unless an explicit `mbaDir` is passed in tests.
2. **Model identity discovery** — The proxy already probes the upstream server (`/cyard/dna`, or `/v1/models` + `/props`) for the `{digest, quant, build}` tuple used by KV block caching. That same tuple is now shared with MBA resolution via a mutable holder, so DNA-pinned adapters match once the probe completes.
3. **Request arrives** — `server.ts` extracts `model`, `harness`, and optionally `ide` / `serverRuntime` / `serverVersion`. If the request model name does not carry an explicit family hint, the resolver heuristically maps common names (e.g. `Qwen3-Coder-30B`, `qwen3`, or a full GGUF path) to the `qwen3-coder` family.
4. **Resolution** — `packages/proxy/src/mba/resolver.ts` scans `MBA_DIR/adapters/**/*.yaml`, scores each adapter by specificity (`dna > name > family > lineage prefix`, plus environment/server selectors), and deep-merges the selected adapters least-specific first. The adapter tree is a **lineage tree** (ADR-0090): folders encode ancestry (`adapters/qwen/qwen3-coder/...`), family adapters mark lineage rungs, and a model's folder path reveals the request's full lineage so trunk/branch ancestors prefix-match. A model's declared `identity.model.lineage` is cross-checked against its folder path; disagreement emits a non-fatal `lineage-mismatch` diagnostic.
5. **Binding load (4-rung ladder, ADR-0091)** — For each selected scope (family, then model), the resolver loads two rungs: the scope's own binding files (`bcb.jsonl`, `tcb.jsonl`, `structural.json`, `server_setup.json`), then the scope's matching `environments/<name>/` override folder (only the files present there). `rule_class` bindings are expanded into their member rules against a merged rule-class registry (built-in ← global `rule-classes.json` ← per-adapter `rule-classes.json`); class-override and unknown-class faults surface as `mba:diagnostic` telemetry.
6. **Config composition** — The final config is built from: built-in defaults → `.MBA/bcb/tool-circuit-breakers.json` (if present) → family bindings → family environment → model bindings → model environment. The matched model's `profile` (immutable GGUF facts) is read straight off the model YAML — never merged — and exposed on the resolved config. A `server_setup` dial that exceeds a profile ceiling (e.g. `ctxSize > params.maxContextLength`) emits a non-fatal `ceiling-violation` diagnostic.
7. **Pipeline use** — The merged config feeds the existing `applyToolCircuitBreakers` call in `server.ts`. Structural config is applied immediately before the warm path:
   - `grammar.mode` overrides grammar injection:
     - `native-tools` keeps `tools[]` and never injects a grammar.
     - `forced-grammar` injects a grammar even when the master switch is off or category flow narrowed.
     - `negotiated-tools` (or absent) preserves the existing default behavior.
   - `streaming.heartbeatMs` overrides the proxy default SSE keepalive interval for buffered tool turns.
   - `signals` and `toolCallFormat` are emitted as `mba:structural-applied` telemetry for observability; they are not yet interpreted by the proxy.
8. **Fallback** — If `.MBA/adapters` does not exist, the proxy falls back to the legacy `.cyard-store/bcb/tool-circuit-breakers.json` path.

## Configuration/Params

### Directory layout (ADR-0091)

```text
.MBA/
├── bcb/
│   └── tool-circuit-breakers.json   # optional global fallback layer
├── rule-classes.json                # optional global user rule-class definitions
├── cache/
│   └── gguf-metadata/               # disk cache for GGUF metadata (MCP server)
└── adapters/
    └── qwen/                          # trunk: applies to ALL Qwen models
        ├── family.yaml                # (optional — not created yet; the walk supports it)
        └── qwen3-coder/               # branch: applies to all qwen3-coder variants
            ├── family.yaml            # family-level adapter (identity.model.family)
            ├── bcb.jsonl              # family default dials
            ├── tcb.jsonl
            ├── structural.json
            ├── server_setup.json
            ├── rule-classes.json      # optional per-adapter rule-class definitions
            ├── environments/          # family-wide environment policies
            │   └── copilot+vscode+llamacpp/
            │       └── server_setup.json   # only the files that override
            └── qwen3-coder-30b/       # THE MODEL = a folder
                ├── qwen3-coder-30b.yaml    # identity + file + profile + bindings
                ├── bcb.jsonl
                ├── tcb.jsonl
                ├── server_setup.json
                └── environments/      # model-specific environment overrides
                    └── copilot+vscode+llamacpp/
                        └── server_setup.json
```

The folder tree **is** the lineage tree (ADR-0090): each folder above a
model is a lineage rung. `qwen/` is the trunk (all Qwen models),
`qwen/qwen3-coder/` is the branch (all qwen3-coder variants), and the model
is a folder (`qwen3-coder-30b/`) mirroring the family shape. A `family.yaml`
at any rung applies to everything below it; deeper layers override shallower
ones per key.

**Environment override folders** (ADR-0091) live in `environments/` at the
family and/or model level and contain *only* the four binding file types
(`bcb.jsonl`, `tcb.jsonl`, `structural.json`, `server_setup.json`) — absent
file = inherit from lower rungs. The folder name is the match key:
`harness[+ide[+runtime]]`, joined with `+` (hyphens are legal inside segment
values, and model folders are hyphenated). Segments compare normalized
(`llamacpp` matches `llama.cpp`); partial names are wildcards
(`environments/copilot/` matches any IDE/runtime); the most-specific match
wins.

**`profile` is model-level and read-only at every rung.** The model YAML
carries `identity.model.file` (the weights path) plus `identity.model.profile`
(immutable GGUF facts: architecture, quant, `params.maxContextLength`
ceiling, tokenizer, container). The family carries no `file`/`profile` (a
family may have many weights files); environment folders may not touch it.

Adapter filenames follow a discoverability convention: `family.yaml` at the
family level, `{model-name}.yaml` inside the model folder (the slug of
`identity.model.name`). The resolver scans for any `.yaml`/`.yml` file and
scores by identity, so the filename is not load-bearing — it exists so the
right adapter is easy to find in a file explorer.

Old-style per-environment adapter YAMLs (separate YAML per model ×
environment, carrying `identity.environment`/`identity.server`) still resolve
for backward compatibility but emit an `env-adapter-deprecated` diagnostic —
migrate them to `environments/` override folders.

### Adapter YAML

Model adapter (the model is a folder; `file` + `profile` live here, not in
the family):

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
    lineage: [qwen, qwen3-coder]   # root → leaf; cross-checked against the folder path
    file: "/mnt/nas/AI_Models/qwen3/Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf"
    profile:                       # immutable GGUF facts (read-only at every rung)
      architecture: qwen3moe
      quant: Q4_K_M
      params:
        maxContextLength: 262144   # CEILING — ctxSize dials above this emit ceiling-violation
        expertCount: 128
        expertUsedCount: 8
      tokenizer:
        eosTokenId: 151645
        chatTemplateDigest: "87710339d25b4e78"
      gguf:
        fileFingerprint: "c8806f02e7d080acaf00373147585a6e40b66db5ab327b2580b4e43de5e3814b"
bindings:
  bcb: "./bcb.jsonl"
  tcb: "./tcb.jsonl"
  server_setup: "./server_setup.json"
alerts:
  - events: ["tcb:killed"]
    sink: stderr
    params:
      level: warn
```

Family adapters carry `identity.model.family` (plus `lineage`) and their
default binding files — no `file`, no `profile`. Environment-specific dials
go in `environments/<harness[+ide[+runtime]]>/` override folders, not in a
separate adapter YAML. (The old per-environment YAML shape with
`identity.environment`/`identity.server` still resolves but is deprecated.)

### JSONL rule binding

Each line binds one tool to either a single `rule` or a `rule_class` (a named
bundle of rules — see **Rule classes** below).

```jsonl
{"tool": "read_file", "rule": "readClamp", "enabled": true, "params": {}}
{"tool": "read_file", "rule": "repeatRun", "enabled": true, "params": {"threshold": 2}}
{"tool": "read_file", "rule": "eofOverflow", "enabled": true, "params": {"kill": {"enabled": true, "ignoredTrips": 1, "action": "return-error"}}}
```

### TCB rule catalog

All rules consume one universal ordered tool-call list (ADR-0086), so they fire
on **any** tool, not just `read_file`. Read-specific rules read a `.read` bridge
(filePath + line range); the rest key off an argument hash.

| Rule | Fires when | Params |
| --- | --- | --- |
| `readClamp` | A read overshoots the file's real length | — (annotates + clamps) |
| `eofOverflow` | A read requests lines past EOF | `hint`, `kill`/`escalation` |
| `repeatRun` | The trailing run of byte-identical **reads** hits `threshold` | `threshold`, `kill`/`escalation` |
| `directDuplication` | The trailing run of identical `tool:argHash` calls (ANY tool) hits `threshold` | `threshold`, `kill`/`escalation` |
| `binaryBlock` | A read targets a path ending in a blocked extension | `extensions`, `message`, `kill`/`escalation` |

`directDuplication` is the tool-agnostic loop breaker — it guards no-line-range
tools like `mba_file_metadata` that the older read-shaped detector could not see.
It is stateless (the run is counted from the transcript), so a masked tool
auto-revives the moment the model does something else.

### Escalation ladder (Nudge → Mask → Kill)

Every rule always **nudges** (rewrites the offending tool result into a stop
message). What happens when the model *ignores* the nudge is governed by an
escalation ladder (ADR-0086 Part 3). A binding declares it two ways:

- **Legacy `kill`** — `{"kill": {"enabled": true, "ignoredTrips": 3, "action": "return-error"}}`
  is sugar for a `nudge → kill` ladder.
- **Explicit `escalation`** — a full ladder with a middle **mask** rung:

```jsonl
{"tool": "mcp_mba-mcp-serve_mba_file_metadata", "rule": "directDuplication", "enabled": true,
 "params": {"threshold": 3,
   "escalation": {"tiers": [{"tier": "mask", "afterIgnoredTrips": 0, "revivalCalls": 3}],
                  "counterMode": "monotonic"}}}
```

Tiers:

- **`nudge`** — inject the stop message (always happens on a trip).
- **`mask`** — remove the offending tool from the next request's `tools[]` so the
  model physically cannot call it; `revivalCalls` is the intended cooldown.
- **`kill`** — hard stop via `action`: `return-error`, `close-stream`,
  `drop-tools`, or `block-tool`.

`afterIgnoredTrips` is how many ignored trips (beyond the first) are needed to
reach a tier. `counterMode` is `monotonic` (one running total; default) or
`reset-per-tier` (the counter resets each time a tier fires).

### Rule classes

A **rule class** is a named bundle of rules with a shared default ladder, so a
common group attaches in one line (ADR-0087). A binding uses `rule_class` (one
name or an array applied in order) instead of `rule`:

```jsonl
{"tool": "read_file", "rule_class": ["readSafety", "readLoop"], "enabled": true,
 "overrides": {"binaryBlock": {"message": "…custom…"}}}
```

`overrides` tunes individual members by rule id, layered as
`class defaults ← class escalation ← per-member overrides`.

**Built-in classes** (code, `packages/core/src/bcb/rule-classes.ts`):

| Class | Members | Ladder |
| --- | --- | --- |
| `readSafety` | `readClamp`, `eofOverflow` (kill@2), `binaryBlock` (kill@3) | per-member kills |
| `loopBreaker` | `repeatRun`, `directDuplication` | nudge → mask@2 → kill@4 |
| `readLoop` | `repeatRun` only | nudge → mask@2 → kill@4 |

`readLoop` exists so `read_file` gets loop-breaking **without** the redundant
`directDuplication` (which would double-guard reads and overwrite the
read-specific message).

**User-defined classes** layer over the built-ins, least-specific first:

```text
BUILTIN_RULE_CLASSES  ←  <MBA_DIR>/rule-classes.json (global)  ←  <adapter>/rule-classes.json (per-adapter)
```

A user class of the same name **overrides** a built-in (surfaced as a
`rule-class-override` diagnostic); an unknown class name silently drops the
binding and emits an `unknown-rule-class` diagnostic. Both are logged via
`mba:diagnostic` (warn for unknown/override faults). File shape:

```json
{ "classes": { "myClass": { "members": { "directDuplication": { "threshold": 5 } },
                            "escalation": { "tiers": [{ "tier": "mask", "afterIgnoredTrips": 0 }] } } } }
```

Point at a per-adapter file from `family.yaml`:

```yaml
bindings:
  ruleClasses: "./rule-classes.json"
```

### Structural JSON

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

## Global MBA Service (ADR-0092)

The global TCB layer and rule-class registry live in one **global service
process** (not per-project). Files are truth under `~/.cyard/`:

```text
~/.cyard/
├── bcb/tool-circuit-breakers.json   # global TCB rules
├── mba/rule-classes.json            # global rule-class registry
├── mba/version.json                 # monotonic version counter
└── mba/service.json                 # discovery: { port, pid, startedAt }
```

- **Run it:** `npm run start:service` from the MBA repo root. Binds
  `127.0.0.1:0` (OS-assigned port) and writes `service.json` for discovery.
  Env: `CYARD_MBA_BASE_DIR` (default `~/.cyard`), `CYARD_MBA_LEGACY_TCB`
  (explicit legacy file for first-boot migration).
- **Endpoints:** `GET /resolve_config?model=` → `{ version, model, tcb,
  ruleClasses }`; `POST /set_rules` (validates shapes, atomic write, version
  bump) → `{ version, tcb }`; `GET /status` → `{ version, uptimeMs, paths }`.
- **First-boot migration (Option A):** if the global TCB file is missing but a
  legacy per-project `.cyard-store/bcb/tool-circuit-breakers.json` exists, it
  is copied in once.
- **Writes are atomic** (temp file → rename); every mutation bumps
  `version.json`.
- **Consumers fail open:** the proxy's `MbaClient` caches the last good
  snapshot. Warm outage → serves cache silently; cold start → built-in
  defaults with one `mba:service-unreachable` warning; the warning clears on
  recovery.

## MCP Server

MBA also ships a standalone MCP (Model Context Protocol) server at
`tools/mba-mcp-server/`. It exposes MBA tools to any MCP host (VS Code
Copilot, Cline, Claude Desktop, etc.) so adapter behavior is not locked
inside the c-yard proxy. It is the **control plane** for the global service:
the service tools are thin HTTP wrappers — the MCP server never edits the
`~/.cyard/` JSON files directly, so the service stays the single writer.

### Registering in VS Code

Add to your `mcp.json`:

```json
"mba": {
  "type": "stdio",
  "command": "npx",
  "args": ["tsx", "/home/skaba/Dev_Projects/C-Yard/tools/mba-mcp-server/src/server.ts"],
  "env": {
    "MBA_DIR": "/home/skaba/Dev_Projects/C-Yard/.MBA",
    "MBA_WORKSPACE_ROOT": "/home/skaba/Dev_Projects/C-Yard"
  }
}
```

### Tools

The server exposes five tools. Two are **offline** (no service needed); three
talk to the global MBA service over HTTP.

| Tool | Offline? | Purpose |
| --- | --- | --- |
| `mba_file_metadata` | yes | Probe a workspace file (exists, totalLines, sizeBytes, isDirectory, lastModified, isBinary) before `read_file` |
| `mba_model_registry` | yes | Light listing of adapters loaded from `.MBA/adapters` at boot: id, name, family, model family/name/file, which binding sections are present |
| `mba_resolve_config` | no | Effective global config from the service: `{ version, model, tcb, ruleClasses }`. Optional `model` for per-model context |
| `mba_set_rules` | no | Update global TCB rules (`tcb`, required) and optionally `ruleClasses` via the service |
| `mba_server_status` | no | Service health probe: `{ version, uptimeMs, paths }` |

**`mba_file_metadata`** eliminates `read_file` range guessing that triggers
`readClamp` / `eofOverflow` / `repeatRun`.

Input:

```json
{ "filePath": "docs/adr/0084-model-behavioral-adapter-specification.md" }
```

Output:

```json
{
  "exists": true,
  "totalLines": 220,
  "sizeBytes": 8543,
  "isDirectory": false,
  "lastModified": "2026-08-10T14:30:00.000Z"
}
```

Recommended workflow: the model calls `mba_file_metadata` before `read_file`,
then uses `totalLines` to request a valid range.

**`mba_model_registry`** is intentionally *light* — it lists what adapters
exist and which binding sections they carry. For a per-model full report
(resolved config, structural rules, server flags) call
`mba_resolve_config` with the model id; the registry does not duplicate that.

**Service tools** discover the service in this order: explicit `baseUrl` →
`CYARD_MBA_SERVICE_URL` env → `~/.cyard/mba/service.json` discovery file.
Each call has a 1500 ms timeout. When the service is down, the tool returns a
clear `service unreachable: …` error (with `isError: true`) instead of
crashing — the MCP server itself keeps running for the offline tools.

### GGUF metadata loading

Adapters can point at a local GGUF model file so the MBA server extracts static
model metadata at startup instead of probing the running server.

**YAML:**

```yaml
identity:
  model:
    family: qwen3-coder
    file: "/mnt/nas/AI_Models/qwen3/Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf"
```

**Behavior:**

- At startup, `loader.ts` resolves the path, parses the GGUF header, and attaches
  the result to `LoadedAdapter.modelMetadata`.
- A disk cache in `.MBA/cache/gguf-metadata/<sha256>.json` avoids re-parsing.
- The cache invalidates when the model file mtime changes.

**Known GGUF fields used:**

- `general.name`
- `general.architecture`
- `general.file_type` (quantization, e.g. `Q4_K_M`)
- Architecture-specific fields like `qwen3.context_length`

This metadata is **not yet used for adapter resolution**; it is loaded for
observability and future rule tuning.

## Known Constraints

- Structural config wires `grammar.mode` and `streaming.heartbeatMs` only. `signals` and `toolCallFormat` are logged for observability but are not yet interpreted by the proxy.
- Server runtime/version detection is not automatic; the proxy defaults to `generic` unless the caller provides it.
- Version comparison supports `>=` and `<` ranges. Tilde/caret (`~`, `^`) are treated as wildcards in v1.
- Adapter YAML files must use `apiVersion: mba.c-yard.dev/v1alpha1`. Older or unknown versions are rejected.
- A missing `.MBA/adapters` directory disables MBA entirely and keeps the legacy BCB path active.
- Rule-class escalation ladders are per-class defaults, not per-member; a member needing a different ladder must set it via `overrides` or a standalone `rule` line. `reset-per-tier` counter mode is honoured by the engine but the proxy currently persists only `monotonic` state; strict multi-call mask revival (`revivalCalls > 1`) is approximated by the stateless trailing-run detector.
- The MCP server's service tools (`mba_resolve_config`, `mba_set_rules`, `mba_server_status`) require the global MBA service to be running; without it they return a `service unreachable` error. The offline tools (`mba_file_metadata`, `mba_model_registry`) work regardless. DNA verification, environment attestation, and adapter-defined custom tools are planned in ADR-0085.
