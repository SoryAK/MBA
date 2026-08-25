# 0098 — Model pull: one-command model onboarding with verified downloads and auto-generated draft adapters

- **Status:** Proposed
- **Date:** 2026-08-25
- **Deciders:** user + agent
- **Tags:** mba, model-management, cli, service, gguf, download

## Context and Problem Statement

Onboarding a new model into the MBA store today is a manual, multi-step
process:

1. Download the GGUF (18GB+ files, no resume, no integrity check).
2. Hand-write a ~50-line adapter YAML — architecture, params, tokenizer,
   gguf block — by reading the GGUF header with external tooling.
3. Create the binding files (`bcb.jsonl`, `tcb.jsonl`, `server_setup.json`)
   and, for a new family, the `family.yaml` tier.

The adapter YAML is the bottleneck: most of its content (architecture,
params, tokenizer, gguf metadata) is *already inside the GGUF header* —
MBA even parses it (mcp-server's `gguf-metadata.ts`) — but the parsing
happens at load time for display, not at onboarding time for generation.

Phase 4 of ADR-0097 (OS-aware store at
`$XDG_DATA_HOME/mba/model_hub/adapters`) was groundwork for this feature:
the pull capability needs a stable, owned store location to write into.

## Decision Drivers

- **Integrity.** An 18GB file that is silently corrupted is worse than a
  failed pull. The digest must be verified before the file is accepted.
- **Resumability.** Large downloads over unreliable links must resume, not
  restart.
- **Store shape uniformity.** A freshly pulled model must be immediately
  resolvable by the existing resolver (ADR-0084) — no special "incomplete
  model" state.
- **Standalone invariant (ADR-0092).** mcp-server must not gain a dependency
  on `@mba-ai/core`.
- **Honest drafts.** Auto-generated YAML must make clear which fields are
  derived from the header and which need human input.

## Considered Options

### Parser placement

- **Option A — Move the GGUF parser to core.** mcp-server imports it from
  core. Single source of truth, but breaks mcp-server's standalone
  invariant (ADR-0092) and requires migrating the running MCP server.
- **Option B — Duplicate the parser in core.** mcp-server keeps its copy.
  Two copies of a ~280-line stable file, matching the established
  duplication pattern (`paths.ts` is already duplicated between core and
  mcp-server by design).

**Chosen: Option B.** The GGUF header format is stable; the parser is small
and unlikely to churn. Preserving the standalone invariant is worth the
bounded duplication cost.

### Digest trust model

- **Option A — Record-but-warn** when `--sha256` is omitted.
- **Option B — Refuse** to pull without `--sha256`.

**Chosen: Option B.** A corrupted multi-GB file accepted silently defeats
the purpose of the feature. The digest is one copy-paste from the source
(HuggingFace file listing) — the friction is acceptable.

### Identity

- **Option A — Guess** `id`/`family` from `general.name`.
- **Option B — Require `--id`**; `--family` optional, defaulting to a slug
  derived from `--id`.

**Chosen: Option B.** The id is the canonical name used by the picker, the
DNA gate (ADR-0093), and the catalog. Guessing it wrong is expensive to
fix (rename = move folder + rewrite yaml + update VS Code config).

### Binding scaffolds

- **Option A — Scaffold both tiers.** Model-tier binding files always;
  family tier (`family.yaml` + binding files) when the family is new.
- **Option B — Model tier only.** Family tier created later by hand.

**Chosen: Option A.** Keeps the store shape uniform and the resolver's
merge chain (family → model, ADR-0084) always well-defined. The family
scaffolds are empty placeholders with zero behavioral effect until filled.

## Decision

**`mba pull <url> --id <id> --sha256 <digest> [--family <family>]`** (CLI)
and **`POST /models/pull`** (service route, same parameters) perform:

1. **Validate** — `--id` and `--sha256` are mandatory; refuse otherwise.
   Refuse if the target model folder already exists.
2. **Download** — stream to `<family>/<id>/<filename>.gguf.partial` in the
   store. If a `.partial` exists, resume with an HTTP `Range` request.
3. **Verify** — sha256 the completed file; on mismatch, delete the partial
   and fail. On match, `renameSync` to the final name.
4. **Parse** — read the GGUF header (core's duplicated parser).
5. **Generate** — build the draft adapter YAML:
   - derived fields (architecture, params, tokenizer, gguf block, license,
     quant) filled from the header;
   - non-derivable fields (`imatrix`, `client` flags, display `name`)
     emitted with explicit `# TODO` markers;
   - `bindings` pointing at the scaffolded model-tier files.
6. **Scaffold** — model-tier `bcb.jsonl`/`tcb.jsonl`/`server_setup.json` as
   `{}` placeholders; if `<family>/family.yaml` is absent, scaffold the
   family tier too (`family.yaml` + empty binding files).

New modules in `@mba-ai/core` (`src/model/`):

- `gguf-metadata.ts` — duplicated header parser (Option B above).
- `gguf-profile.ts` — pure function: GGUF fields → draft profile.
- `draft-adapter.ts` — pure function: profile + identity → draft YAML text
  (with TODO markers).
- `model-pull.ts` — orchestrator: download + resume + verify + scaffold +
  write.

The route returns the created model's id, yaml path, and sha256. The CLI
prints the same plus a reminder that TODO fields need review before the
model is used for real work.

## Consequences

**Pros:**

- One-command onboarding: download → verified weights → resolvable draft
  adapter, replacing a manual multi-step process.
- Integrity by construction: no file enters the store without a matching
  digest; the digest also becomes the yaml's `fileFingerprint`.
- Uniform store shape: every model (pulled or hand-made) has the same
  two-tier binding structure; the resolver never sees a special case.
- mcp-server stays standalone (ADR-0092 preserved).

**Cons / Trade-offs:**

- **Parser duplication drift.** Two copies of the GGUF parser must be kept
  in sync if the format ever changes. Mitigation: the format is stable and
  the copies are byte-identical today; a comment in each file points at the
  other.
- **Drafts still need human review.** TODO fields (imatrix, client flags,
  display name) mean a pulled model is bootable but not fully tuned until
  reviewed. This is a feature (honesty) but a step the user must not skip.
- **Resume assumes a Range-capable server.** If the source ignores `Range`,
  the resume path degrades to a full re-download (detected via the
  response status: 200 instead of 206 → restart from zero).
