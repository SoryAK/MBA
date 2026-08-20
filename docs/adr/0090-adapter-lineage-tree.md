# Adapter lineage tree — folders encode model ancestry

- **Status:** Accepted
- **Date:** 2026-08-17
- **Deciders:** skaba + agent
- **Tags:** mba, proxy, configuration

## Context and Problem Statement

The MBA resolver (ADR-0084) matches adapters against a single `identity.model.family`
string. That works for one family level, but model names in the wild encode a
hierarchy: `Qwen3-Coder-30B-A3B-Instruct` is a variant of `qwen3-coder`, which is a
branch of the `qwen` line. With a flat family field there is no place to put rules
that apply to *all* Qwen models (trunk) versus *all* qwen3-coder variants (branch)
versus one specific model (leaf).

A related operational problem: environment-level adapters were all named
`adapter.yaml`, making them indistinguishable in a file explorer. The rename to
`{model-name}.yaml` (this session) fixed discoverability but left the hierarchy
question open.

## Decision Drivers

- **Discoverability** — the tree should be visible in the file explorer without opening YAML.
- **Zero-config for common cases** — adding a model should not require hand-maintaining ancestry metadata that duplicates the folder layout.
- **Backward compatibility** — existing flat adapters (`adapters/m1/`) must keep resolving.
- **Wider scope** — the structure should cover future lines (QwQ, Qwen4, other vendors) without schema changes.

## Considered Options

- **Option A** — Directory path = hierarchy. The folder path *is* the lineage; the resolver walks it root→leaf. A declared `identity.model.lineage` field acts as a label/cross-check.
- **Option B** — Explicit `lineage` field only. Folders stay flat; each adapter declares its ancestry as a string list.

## Decision Outcome

**Chosen option: "Option A"**, because the folder tree is the only representation
where the hierarchy is visible in the file explorer — the same property that made
the `{model-name}.yaml` rename worthwhile. The declared `lineage` field is a
sanity label, not the source of truth: the resolver walks folders and emits a
non-fatal `lineage-mismatch` diagnostic when the declaration disagrees with the
path.

### V1 scope (agreed with decider)

1. Lineage is **declared** by the adapter (`identity.model.lineage: [qwen, qwen3-coder]`), root→leaf.
2. The trunk (`qwen/family.yaml`) is **not created yet** — the walk supports it; it finds nothing at that rung until the file exists.
3. The **resolver walks the tree**: a family adapter's folder-path lineage prefix-matches the request's lineage. The request's full lineage is recovered from the leaf (matched by name): its folder path supplies the segment values, its declared `lineage` supplies the depth (where lineage ends and environment segments begin).

### Positive Consequences

- Rules can be written once at the trunk or branch and inherited by every model below — no per-model duplication.
- The hierarchy is self-documenting: expanding one folder in the explorer shows the whole lineage.
- Adding a new branch is `mkdir`; no schema or resolver change.
- Flat adapters keep working unchanged (backward compat test covers this).

### Negative Consequences

- Moving a model between branches means moving folders (git history churn, though `git mv` preserves it).
- The resolver now has a two-pass resolution (leaf first, then ancestors) — slightly more complex than single-pass scoring.
- The declared `lineage` field is a second representation of the folder path; drift is possible, but only surfaces as a non-fatal diagnostic.

## Pros and Cons of the Options

### Option A — Directory path = hierarchy

- ✅ Tree visible in file explorer; layout is documentation.
- ✅ Zero-config: ancestry falls out of where the file lives.
- ❌ Moving a model = moving folders.
- ❌ Path and semantics coupled (a rename changes lineage).

### Option B — Explicit lineage field only

- ✅ Folders stay loose; a model can declare ancestry independent of location.
- ❌ Hierarchy invisible in the explorer — must open each YAML.
- ❌ Lineage list is a second source of truth that can drift from intent.

## Implementation Notes

- `packages/proxy/src/mba/types.ts` — `MbaModelIdentity.lineage?: readonly string[]`; `MbaResolutionContext.modelLineage?`; diagnostic kind `lineage-mismatch`.
- `packages/proxy/src/mba/resolver.ts` — `AdapterEntry.pathSegments` (folder path relative to adapters root); `effectiveRequestLineage()` (two-pass: leaf's path + declared depth); `familyPathLineage()` (family adapters only mark rungs); `lineagePrefix()` scoring at `25 × depth ratio` so trunk < branch < family < name < dna.
- Real tree moved: `.MBA/adapters/qwen3-coder/` → `.MBA/adapters/qwen/qwen3-coder/`; leaf declares `lineage: [qwen, qwen3-coder]`.
- Tests: `packages/proxy/src/mba/lineage.test.ts` (trunk←branch←leaf merge, prefix match, mismatch diagnostic, flat backward compat).

## Related

- [ADR-0084](./0084-model-behavioral-adapter-specification.md) — MBA specification (supersedes its single-family matching with the lineage ladder).
- [ADR-0089](./0089-per-model-server-auto-reboot.md) — per-model server auto-reboot (consumes the merged `server_setup` recipe this tree produces).
