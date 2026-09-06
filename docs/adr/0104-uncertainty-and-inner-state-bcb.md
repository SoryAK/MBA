# ADR 0104: Uncertainty and inner-state as a BCB detector family

- **Status:** Proposed — implementation deferred until AMPI and CM are nailed down (see [ADR-0105](0105-context-management-and-ampi.md))
- **Date:** 2026-09-06
- **Deciders:** project maintainer + agent
- **Tags:** architecture, mba, bcb, entropy, uncertainty, local-llm, adapter
- **Relates to:** ADR-0086 (TCB / escalation), ADR-0101 (AMPI runner), ADR-0105 (CM / CGC)

## Context and Problem Statement

Tool Circuit Breakers watch what a local model *did*: the same `read_file`, an overshoot, a duplicate call. That is late. A large class of local-model failure starts earlier. The model is lost, overconfident, or stuck in its own head, and each model does that differently.

Two signals matter:

- **Entropy** — how spread-out the next-token belief is. High entropy looks like guessing, hedging, and spraying tools. Low entropy looks like lock-in, sometimes onto a wrong loop. A search such as “how does the MBA CLI work?” is a typical high-entropy stretch until the right file is found.
- **Inner-state / Jacobian-class trajectory** — whether the model’s internal state is actually updating or spinning in place. “Jacobian” here is the working name for sensitivity of outputs to hidden state, or more loosely the inner monologue’s motion. The formal object is not nailed down; the claim is that **inner dynamics are BCB material**, not only emitted tool calls.

These signals are **per-model**. One model’s normal search band is another model’s collapse. That belongs in the adapter dossier, next to tool rules, not as a global constant.

TCB remains the tool-loop detector. This ADR adds a **second BCB detector family**: uncertainty / state breakers. AMPI still runs the response. CM / CGC still edit context when the recipe says so.

## Decision Drivers

- **Detect weather, not only wrecks.** Tool loops are the visible failure. Entropy and inner-state are often the weather that produces them.
- **Per-model, not global.** There is no universal “lost” number. Thresholds live in the adapter and are learned by watching that model.
- **Cheap on the hot path.** A full Jacobian every token on a large local model is too expensive. First-class signals must be proxies the daemon can actually get (logprobs, top-k mass, logit gap, repetition, reasoning-token rate).
- **False trips are costly.** Killing a model that is still exploring makes it dumber. Uncertainty breakers use the existing escalation ladder, not an instant kill.
- **Do not implement yet.** AMPI and CM must be settled first (ADR-0105). This ADR records the family and the rollout order so the idea is not lost.

## Considered Options

- **Option A — Fold uncertainty into existing TCB rules.** Rejected: TCB keys off tool identity (`tool`, `argHash`, read ranges). Uncertainty is a generation signal. Mixing them hides the per-model baseline problem.
- **Option B — New BCB detector family, collect-then-trip.** Accepted. Collect traces first, describe a per-model baseline in the adapter, then attach breakers and AMPI recipes.
- **Option C — Require Jacobian / hidden-state streaming from llama.cpp before any work.** Rejected as a v1 gate. Most servers will not expose that. Treat richer state as an optional later fact in the dossier.

## Decision

Add **uncertainty / inner-state breakers** as a BCB detector family alongside TCB.

```text
generation signals (entropy, inner-state)
        │
        ▼
BCB  ── tool breakers (TCB)
     └── uncertainty / state breakers
        │
        ▼
AMPI recipes
        │
        ▼
CM / CGC
```

### What we will use first (cheap proxies)

When the upstream can provide logprobs (or equivalent), the daemon may record:

- token entropy
- top-k probability mass
- logit gap (top1 − top2)
- repetition / collapse markers
- reasoning-token rate, when the dialect exposes it

A **stretch** is the unit, not a single token. One high-entropy token is noise. A long high-entropy stretch while repeating tools is a trip candidate. A sudden collapse onto a retry is a different candidate.

### What we will not require at first

- A full Jacobian or hidden-state dump on every token
- A global entropy threshold
- Instant kill on a single uncertain token

Richer inner-state (formal Jacobian, hidden-state trajectory) is an **optional later fact** in a model’s dossier, only if cheap proxies are not enough for that model.

### Per-model dossier

The adapter (or a sibling profile file) will eventually hold this model’s **search band** and **collapse band**: what “normal exploring” vs “lost / locked” looks like for *this* weights file. Same shape as other MBA facts-plus-dials: a measured baseline, then operator-tunable trip points.

### Rollout order (do not skip)

1. **Collect** — record cheap traces on the request path when the upstream allows it. No breaker. Learn what normal looks like per model.
2. **Describe** — write the baseline into the adapter dossier.
3. **Trip** — add BCB rules (“entropy stuck high for N tokens while repeating tools,” “entropy collapsed onto a retry”). The ladder may summon AMPI (never a CM cut). AMPI may ask CM / CGC to edit.
4. **Richer state later** — only if a given model still fails in ways entropy cannot see.

Implementation of steps 1–4 waits until AMPI and CM (ADR-0105) are nailed down. Building breakers before the responder and the context plane are settled would create trips with nowhere clean to land.

## Consequences

### Pros

- Names a real local-model failure mode that TCB cannot see.
- Keeps detection in BCB and response in AMPI / CM — no third orchestrator.
- Forces per-model baselines instead of a fake global number.
- Cheap proxies can ship without new native code.

### Cons / Trade-offs

- Harder to nail than tool identity. False trips will happen until each model’s band is known.
- Depends on upstream logprobs; some servers will not provide them (fail open: no trace, no trip).
- “Jacobian / inner monologue” is still an informal name. Formalizing it is a later research step, not a v1 blocker.

## Open questions (deferred)

1. Exact trace schema and where it is stored (request-scoped ring vs adapter-sidecar profile).
2. How a collect-only phase is turned on (global dial, per-model dial, or implicit when logprobs are present).
3. Formal definition of inner-state / Jacobian measures we might add after cheap proxies.
4. How uncertainty trips share session keys with TCB kill-state (same `bcb_kill_state` vs a sibling table).

## Relationship to other ADRs

- **ADR-0086 / TCB:** TCB stays the tool-loop detector. This family sits beside it under BCB, not inside a `read_file` rule.
- **ADR-0101 (AMPI):** Uncertainty trips use the same ladder → `action: ampi` path. No new runner.
- **ADR-0105 (CM):** When a recipe says “drop dead-end reads” or “compact spent reasoning,” CM / CGC does the edit. This ADR does not own context mutation.
