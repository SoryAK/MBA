# MBA as a standalone framework ("the dealership")

- **Status:** Proposed
- **Date:** 2026-08-19
- **Deciders:** skaba + agent
- **Tags:** architecture, mba, bcb, infra

## Context and Problem Statement

MBA (Model Behavior Adapters) grew inside the proxy (`packages/proxy/src/mba/`) as an accident of history: the proxy needed per-model behavior config, so the adapter system, resolution, and server lifecycle lived there. The BCB/TCB/AMPI engine — the actual differentiator, the model-specific guardrail behavior — lives separately in `packages/core/src/bcb/` and is consumed by the proxy.

The user wants MBA to become a **framework other people can use for local model management**. The positioning is "the dealership": not generic model management (Ollama/llama.cpp territory), but the model-specific behavior layer — adapters, guardrail rules (BCB/TCB/AMPI), and eventually model-tailored skills — as the product.

Key questions covered in discussion:

1. **Data plane vs control plane** — the proxy resolves config per request; that cannot go through MCP IPC. Resolution stays in-process (SDK import); MCP is control plane only (registry, lifecycle, rule management).
2. **Server lifecycle ownership** — who owns model server processes? The framework (MBA service) owns lifecycle; the proxy consumes resolved config and talks to servers.
3. **Move vs duplicate** — the BCB/TCB/AMPI engine is absorbed into the framework, not duplicated. It is core to the product, not a plugin.
4. **Repo question** — a framework for others needs a clean public API, independent versioning, and no C-Yard proxy coupling. But graduating to a separate repo before the boundary is proven in-repo is premature.
5. **Core vs plugin** — BCB/TCB/AMPI is core (the differentiator). Model-tailored skills are a second-cut surface (no existing code).

## Decision Drivers

- Reusability: other projects/platforms must be able to adopt MBA without the C-Yard proxy
- Clean public API: framework surface must be explicit and versionable
- Zero per-request overhead: proxy resolution must stay in-process
- Migration safety: the boundary must be proven in-repo before repo graduation

## Considered Options

- **Option A** — Keep MBA in the proxy; expose it via MCP only
- **Option B** — Extract `packages/mba` in-repo (absorbing the BCB/TCB/AMPI engine), proxy imports it as an SDK; graduate to a separate repo once the public API is stable
- **Option C** — Immediately create a new standalone repo for the framework

## Decision Outcome

**Chosen option: "Option B"**, because it proves the framework boundary in-repo (where the proxy still exercises it end-to-end) before committing to independent versioning and publishing, while still absorbing the BCB/TCB/AMPI engine as core.

### Positive Consequences

- Clean public API surface: `packages/mba` exports are the framework contract; the proxy becomes a thin consumer/harness
- Independent evolution: the framework can version, publish, and be adopted without proxy coupling
- The differentiator (BCB/TCB/AMPI) is co-located with the adapter system it guards — one framework, one story
- MCP becomes a pure control plane (registry, lifecycle, rule management) — no per-tool-call IPC on the data path

### Negative Consequences

- Bigger move: the BCB/TCB/AMPI engine leaves `packages/core` (~4,100+ lines of migration across two packages)
- Cross-process state sync: server lifecycle and rule versions now live in the MBA service; the proxy must stay consistent with it
- Migration risk: the proxy's request path depends on the extracted modules; a bad extraction breaks the live proxy
- Two homes during migration: `packages/mba` and `packages/core/src/bcb/` coexist until the move completes

## Pros and Cons of the Options

### Option A — Keep in proxy, MCP-only exposure

- ✅ No migration
- ❌ Framework is unreachable without the proxy; no clean public API; MCP becomes a data plane (per-request IPC)

### Option B — In-repo `packages/mba`, absorb engine, graduate later

- ✅ Boundary proven by the real proxy before publishing
- ✅ Engine and adapters co-located; one framework
- ❌ Migration is a multi-step refactor with a live consumer
- ❌ Cross-process lifecycle/rule state must be designed

### Option C — Immediate new repo

- ✅ Cleanest long-term separation
- ❌ Public API unproven; versioning/publishing before the boundary is exercised; C-Yard proxy becomes an external dependency mid-refactor

## Explicit Deferrals

- GGUF file parsing for profile extraction — deferred to a later cut
- Model-tailored skills surface — new surface, no existing code; second cut

## Migration Staging

1. **Step 1** — Extract `packages/proxy/src/mba/` → `packages/mba`; absorb the BCB/TCB/AMPI engine from `packages/core/src/bcb/` behind the framework boundary. Proxy still works end-to-end.
2. **Step 2** — Stand up the MBA service (registry + lifecycle + rules) as a real process.
3. **Step 3** — Flesh out the MCP server (`tools/mba-mcp-server`) with real tools: `resolve_config`, `model_registry`, `server_status`, `set_rules`.
4. **Step 4 (later)** — Graduate to a separate repo + npm publish once the public API is stable.

## Links / References

- [ADR-0088](./0088-ampi-automated-multi-process-intervention.md) — AMPI responder subsystem (Proposed)
- [ADR-0087](./0087-rule-class-registry.md) — rule class registry
- [ADR-0090](./0090-adapter-lineage-tree.md) — adapter lineage tree
- [ADR-0091](./0091-model-folders-and-environment-overrides.md) — model folders and environment overrides
- `packages/proxy/src/mba/` — current MBA module (23 files after resolver split)
- `packages/core/src/bcb/` — current BCB/TCB/AMPI engine
- `tools/mba-mcp-server/` — existing MCP server shell (one tool: `mba_file_metadata`)
