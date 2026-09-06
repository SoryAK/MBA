# ADR 0105: Context Management (CM), CGC, and AMPI

- **Status:** Proposed (hard line accepted; first CM cut shipped)
- **Date:** 2026-09-06
- **Deciders:** project maintainer + agent
- **Tags:** architecture, mba, ampi, cm, cgc, bcb, context
- **Relates to:** ADR-0088 (AMPI power / termination), ADR-0101 (daemon-as-proxy + AMPI runner), ADR-0102 (catalog names recipes, not cuts), ADR-0104 (uncertainty BCB, deferred)

## Context and Problem Statement

ADR-0101 made AMPI the intervention runner: TCB trips can summon a named recipe, and the recipe must terminate. The first shipped cut was written as if AMPI itself did the cleanup:

```yaml
# WRONG — names a CM cut as if it were an AMPI recipe
escalation:
  tiers:
    - { tier: nudge, afterIgnoredTrips: 0 }
    - { tier: kill, afterIgnoredTrips: 1, action: ampi, recipe: context-gc }
```

That YAML is the system claiming AMPI does context-management work. Context garbage collection is not one recipe, and it is not AMPI’s job. Long-term, MBA must be able to:

- prune trailing duplicate tool-call pairs
- drop exploration debris (wrong files / wrong reads) once a search phase ends
- compact spent reasoning chains after the model has an answer
- honor **marks** made during the work (“this result is scratch”) and **sweep** at a phase boundary

AMPI cannot own all of that. AMPI is “do something now.” The conversation the model sees is a different plane.

If CGC were a sibling subsystem to AMPI, we would have two orchestrators. The parent for cleanup is **Context Management (CM)**. CGC is a family of CM operations.

## Decision Drivers

- **One runner.** AMPI owns when a recipe fires and that it terminates. It does not become the context store.
- **One context plane.** CM owns what the model is about to see. Other subsystems ask CM to edit; they do not splice `messages[]` ad hoc.
- **CGC is a menu, not a recipe name.** Duplicate prune, drop-marked-scratch, and compact-reasoning are cuts under CGC.
- **The ladder names AMPI recipes only.** Escalation YAML never lists a CM cut.
- **CM can run without AMPI.** Window-full compaction is a CM job even if no breaker fired.
- **AMPI can run without CGC.** Sequential file-feed is an AMPI recipe that is not garbage collection.
- **Mark during work, sweep when the phase ends.** Exploration and long reasoning produce scratch that is useful *now* and poison *later*.

## Considered Options

- **Option A — Keep CGC as a single AMPI recipe (`context-gc`).** Rejected. That name and that YAML make AMPI look like it owns the splice.
- **Option B — CGC as a peer subsystem to AMPI.** Rejected. Two orchestrators. Unclear who mutates `messages[]`.
- **Option C — CM as the context plane; CGC as a CM family; AMPI as the runner.** Accepted.

## Decision

### Hard line

| Plane | Owns | Does not own |
| --- | --- | --- |
| Escalation YAML | When to fire, which **AMPI recipe** | CM cut names, `messages[]` |
| AMPI | Recipe registry, `maxTurns`, decreasing progress, asking CM | Splicing `messages[]` |
| CM | Closed edits to `messages[]` | When a trip fires |
| CGC | Cleanup **cuts** under CM (`prune-duplicates`, later others) | Being listed on the ladder |

**Wrong** (AMPI doing CM work):

```yaml
escalation:
  tiers:
    - { tier: nudge, afterIgnoredTrips: 0 }
    - { tier: kill, afterIgnoredTrips: 1, action: ampi, recipe: context-gc }
```

**Right** (ladder names the runner; the recipe body calls CM):

```yaml
escalation:
  tiers:
    - { tier: nudge, afterIgnoredTrips: 0 }
    - { tier: kill, afterIgnoredTrips: 1, action: ampi, recipe: sweep-duplicates }
```

```text
sweep-duplicates          # AMPI recipe — the only name on the ladder
  └── cm.cgc.pruneDuplicates   # CGC cut — never listed on the ladder
```

`context-gc` is retired as a recipe name. It collapsed runner and cut into one string.

### Ownership

```text
TCB / uncertainty BCB (detect)
        │
        ▼
AMPI (when / which recipe / terminate)
        │
        ▼
CM (the conversation the model sees)
   └── CGC (cleanup cuts)
         ├── prune-duplicates     (called by recipe `sweep-duplicates`)
         ├── drop-marked-scratch  (later)
         └── compact-reasoning    (later)
```

- **AMPI** — intervention runner. Recipes, `maxTurns`, decreasing progress measure, `action: ampi` on the escalation ladder. Notch-1 expressions and worker isolation remain as in ADR-0088 / ADR-0101.
- **CM** — context plane. Applies closed edits to `messages[]` (and later, marks / pins / budget). The daemon request path asks CM; callers do not hand-edit the array.
- **CGC** — the cleanup family *under* CM. Not a second runner. Not a recipe name.

The shipped built-in recipe is `sweep-duplicates`: a thin AMPI wrapper around `cm.cgc.pruneDuplicates(...)`. The recipe does not implement the splice.

### Triggers

CM edits can start from:

1. **Trip** — TCB or a future uncertainty breaker (ADR-0104) → AMPI recipe → CM cut.
2. **Phase end** — search finished, user asked the next question, or a recipe measure hit zero → AMPI sweep of marks → CGC.
3. **Budget** — context is full or dirty → CM may compact without AMPI.

“Query phase is done” is not a TCB trip. It is a phase boundary. Detecting that boundary is an open question; the ownership is not: AMPI decides *that* a sweep runs, CM/CGC decides *how* the cut is made.

### Mark and sweep (later CGC)

During exploration or long reasoning, results and reasoning blocks may be **marked scratch** (model-nominated, system-tagged, or both). When the phase ends, CGC drops or compactes marked scratch and **keeps the residue that still matters** (the file that answered the question, the decision, the user’s request).

Hard line on residue:

- Scratch can go: dead-end reads, duplicate retries, spent reasoning.
- Kept result stays.
- A sweep always terminates and leaves a marker or compact residue so the model knows dirt was removed.

System marks are the reliable default (failed reads, duplicate hashes, tool results never cited). Model-nominated marks are allowed later and are never the only source.

### Closed edit surface

CM’s cut menu stays closed, same spirit as AMPI’s `act` enum. v1 cuts:

- `prune-duplicates` (exists)
- later: `drop-marked-scratch`, `compact-reasoning`, `pin` / `keep`

No free-form rewrite of arbitrary messages. No silent deletion without residue.

### What this ADR does *not* change

- TCB detection and the escalation ladder stay in BCB.
- Default-config kill behavior is unchanged (no AMPI tier unless a user writes one).
- Uncertainty / inner-state breakers (ADR-0104) stay proposed and unimplemented until this CM/AMPI split is implemented far enough that trips have a clean landing place.

## Consequences

### Pros

- AMPI stays small: run and terminate.
- Escalation YAML cannot pretend a CGC cut is a recipe.
- CGC can grow without inventing a third orchestrator.
- Mark-and-sweep and reasoning compact have a home (CM), not a pile of one-off recipes.
- Budget compaction can happen without pretending a breaker fired.

### Cons / Trade-offs

- Another named plane (CM) to keep distinct from AMPI in code and docs.
- Two names for the first slice (`sweep-duplicates` + `prune-duplicates`) instead of one catch-all.
- Phase-boundary detection is unspecified and easy to get wrong.
- Model-nominated marks can delete the useful file; system marks must win on conflict until we have evidence otherwise.

## Open questions (to nail as part of AMPI + CM work)

1. **Phase boundary** — how MBA knows a search or reasoning phase ended (explicit recipe end, next user turn, model token, or all three).
2. **Mark representation** — in-message tag, side table keyed by `tool_call_id` / span, or both.
3. **Who may mark** — system-only for v1 vs model nomination with system veto.
4. **Recipe file format** — still deferred from ADR-0088 / 0101; when it lands, recipes name a CM cut, they do not embed ad hoc splices.

## Implementation order (this before ADR-0104)

1. **Done for this slice.** CM is the only `messages[]` mutator for AMPI context edits; `prune-duplicates` lives under CGC; the ladder recipe is `sweep-duplicates`.
2. Keep the AMPI engine as the runner (registry, `maxTurns`, progress).
3. Add the next CGC cut only after more of this plane is nailed (likely `drop-marked-scratch` or budget compact — decide when implementing).
4. **Then** implement ADR-0104 collect → describe → trip, with AMPI recipes that call CM.

## Relationship to other ADRs

- **ADR-0088 / 0101:** AMPI’s Notch-1, termination, and daemon-as-proxy runner are unchanged. This ADR splits *context editing* out of “AMPI is the whole intervention product.”
- **ADR-0101 Step 4:** The first shipped recipe is `sweep-duplicates`. The first CGC cut is `prune-duplicates`. Neither name is `context-gc`.
- **ADR-0102:** Policy / assembly files name AMPI recipes (`sweep-duplicates`), never CGC cuts.
- **ADR-0104:** Uncertainty BCB is a detector family. It must not be built until this plane exists far enough to receive a sweep.
