# 0094 — Proxy DNA gate dropped: KV identity scoping already enforces the invariant

- **Status:** Proposed
- **Date:** 2026-08-20
- **Deciders:** user + agent
- **Supersedes:** [ADR-0093](0093-model-plane-ownership-and-dna-gate.md) Phase 3 only (proxy DNA gate / 409 on mismatch). Phases 1, 2, and 4 of ADR-0093 are retained.
- **Tags:** infra, proxy, local-llm, mba, model-management, kv

## Context and Problem Statement

ADR-0093 (Proposed, 2026-08-20) chose Option B: MBA owns the model plane,
the user triggers switches, and the proxy acts as a *gatekeeper* — a
per-request DNA check that returns **409** when the requested model id does
not match the loaded model's identity tuple `(digest, quant, build)`.

Before building Phase 3, the user challenged its necessity: the proxy already
has a built-in mechanism to check the model before doing KV work, plus
fallbacks such as rewarming the KV store. A source-level audit of
`packages/proxy/src` (C-Yard repo) verified the claim. The audit found that
the safety invariant the DNA gate was meant to enforce — *"a request must
never be silently served by the wrong model"* — is already enforced
structurally, and that a 409 gate would introduce a hard-failure mode into a
subsystem whose explicit design decision is to degrade, never reject.

## The Existing Chain (verified in source, 2026-08-20)

1. **Identity discovery** — `main.ts` `fetchModelIdentity()` probes
   `/cyard/dna` (one GET → `{digest, quant, build}`), falling back to
   `/v1/models` + `/props` scrape. The result lives in the `modelIdentity`
   holder, shared with MBA resolution.
2. **KV keys are structurally model-scoped** — `kv/block-cache.ts`
   `blockKey(prefix, identity)` = `hash(hash(digest, quant, build) + prefix)`.
   A block saved under model A can never match a key computed under model B.
   Cross-model KV restore is impossible *by key math*, not by a runtime check
   (ADR-0036 decision 2).
3. **Per-request KV gate** — `server.ts` `isKvSafeUpstream` requires
   `kv.enabled && kv.identity && kv.provenUpstreamUrl && request URL ===
   proven URL` before any KV work, on both the tools and no-tools paths.
   Any missing piece → cold passthrough.
4. **Behavioral precondition probe** — `kv/precondition.ts` runs a
   save/erase/restore round-trip; failure leaves `enabled = false` → cold
   passthrough. ADR-0036 decision 4: *never hard rejection*.
5. **Region files are model-stamped** — `kv/region-store.ts` filenames encode
   `{model, kvDtype, tokenizer}`; a different model computes a different
   filename → cache miss → fallback to text (ADR-0037 Q2 invalidation).
6. **Rewarming exists** — `db/warming.ts` `warmMissingBlocks` /
   `warmTargetedBlocks` re-freeze blocks after a turn, so a model change
   self-heals the KV store on demand.
7. **MBA client is fail-open** — `mba-client.ts` falls back to the last
   cached config or built-in defaults when the service is down; the proxy
   never blocks on MBA.

## Why the 409 Gate Adds Nothing

- **The proxy forwards to one fixed upstream URL.** It does not route between
  models. The `model` string in the request body is validated by the upstream
  itself (llama-server rejects a name that doesn't match its loaded model).
- **Even in a mismatch, the KV layer is safe.** Keys are scoped to the
  *actual* loaded identity (from DNA), so no cross-model KV contamination is
  possible. Worst case is a cold forward — exactly what the upstream would do
  anyway.
- **It would invert an established design decision.** ADR-0036 decision 4
  mandates degrade-to-cold-passthrough on any KV uncertainty. A per-request
  409 is a *new* hard-failure mode in a subsystem that deliberately has none.
- **The gate's one theoretical benefit (a friendlier error than the
  upstream's) is a UX nicety, not a safety property.** The safety property is
  already guaranteed by items 2–5 above.

## Decision

**Drop ADR-0093 Phase 3.** The proxy DNA gate (409 on requested-vs-loaded
model mismatch) will not be built. The "wrong-model serving" invariant is
enforced by the existing KV identity scoping (ADR-0036 d2), the proven-URL
per-request gate, the behavioral precondition probe (ADR-0036 d4), and the
model-stamped region filenames (ADR-0037 Q2). The proxy's role under
ADR-0093 Option B narrows from "gatekeeper" to "identity-aware tenant": it
*reads* the loaded identity for KV keying and MBA resolution, and degrades to
cold passthrough when identity is unknown — but it does not *reject* requests.

ADR-0093 Phases 1 (MBA model manager), 2 (MCP side door), and 4 (VS Code
config ids → adapter-tree ids) are unaffected and remain the plan.

## Consequences

### Pros

- **No new hard-failure mode.** The proxy keeps its degrade-never-reject
  character; a model mismatch costs a cold forward, not a broken request.
- **Less code, less surface.** No per-request identity-resolution path, no
  409 error-shape contract, no "excellent rejection message" UX requirement.
- **The invariant is enforced where the data lives** (the KV key math), not
  at a distant checkpoint that could drift from it.

### Cons / Trade-offs

- **A mismatched request gets the upstream's error, not a curated one.** If
  the user picks model X while Y is loaded, the error text is whatever
  llama-server emits. Accepted: the two-step switch flow (ADR-0093) means the
  user is expected to run the switch before chatting, and `mba_list_models`
  shows the loaded state at a glance.
- **The "gatekeeper" language in ADR-0093 is now stale.** Mitigated by the
  Status-line amendment on ADR-0093 and this ADR's cross-reference.
