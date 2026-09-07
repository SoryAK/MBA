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
- **CGC is Sweep + Compact, not a recipe name.** Cleanup is how CM edits, not an AMPI job name.
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
| Sweep / Compact | Cleanup **how** under CM | Being listed on the ladder |

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
recipe: sanitize          # AMPI function — the only kind of name on the ladder
  what: duplicates        # mode
  └── cm.sweep            # CM cut — never listed on the ladder
```

Today’s alias `sweep-duplicates` is `sanitize` + `duplicates`. `context-gc` is retired: it collapsed runner and cut into one string.

### Catalog — four and four

Same shape on both planes. Different words so a CM cut is never an AMPI function.

**AMPI — why we run** (ladder names one of these, plus a mode):

| Function | Job |
| --- | --- |
| **Sanitize** | Mop dirt, stay on this thread. No new truth. |
| **Assist** | Help forward: give what is missing, or steer. Not a penalty. |
| **Sanction** | Punish or prevent after bad behavior. Consequence, not a handoff. |
| **Recover** | Undo the bad stretch (rollback to a pin) or reset the chapter. |

**CM — how the chat changes** (closed cuts):

| Category | Cuts | AMPI usually asks it for |
| --- | --- | --- |
| **Write** | `replace`, `insert` | Assist, Sanction |
| **Mark** | `set-mark` (`scratch` \| `pin` \| `clear`) | Recover; Sanitize with `pin` |
| **Sweep** | `sweep` (`duplicates` \| `scratch` \| `budget`; later `rollback`) | Sanitize, Recover |
| **Compact** | `compact` (`reasoning`) | Sanitize spent / phase |

```text
AMPI (why)              CM (how)
Assist     ---------->  Write
Sanction   ---------->  Write (hard residue, no handoff)
Sanitize   ---------->  Sweep, Compact
Recover    ---------->  Mark + Sweep (rollback to pin)
```

A new AMPI card is a **mode** of one of the four functions, or we are adding a fifth function on purpose. A new *kind* of CM target is an MBA change; a new use of an existing selector is just a mode.

#### AMPI modes

- **`sanitize`** — `{ what: duplicates | scratch | spent | phase, pin?: true }`
- **`assist`** — `{ how: feed | clamp | redirect | lost }` (`lost` waits on ADR-0104)
- **`sanction`** — `{ how: revoke }` — later; after Assist is real. Ladder mask/kill can stay the cheap form.
- **`recover`** — `{ how: rollback | reset }` — needs `pin` first. v1 is context-only. Session/KV reset is the same function, later mode (model plane).

Shipped `sweep-duplicates` is `sanitize` + `duplicates`. Keep the alias.

#### CM cuts (five knives, four boxes)

- **`replace`** — overwrite one message. Targets: `tool-result`, `system`, `residue`. Today’s `replace-tool-result` is `replace` + `tool-result`. Out of bounds: the user’s original ask, assistant `tool_calls`.
- **`insert`** — add a message. Roles: `system`, `user`. Today’s `insert-system` is `insert` + `system`. Out of bounds: forging a tool call.
- **`set-mark`** — tag only; does not delete.
- **`sweep`** — drop by policy; always leave residue. Today’s `prune-duplicates` is `sweep` + `duplicates`.
- **`compact`** — rewrite a span to a short residue (not a drop).

Do not merge Sweep into Compact. Do not merge Mark into Sweep. Write stays two cuts (replace vs insert).

### Ownership

```text
TCB / uncertainty BCB (detect)
        │
        ▼
AMPI (sanitize | assist | sanction | recover)
        │
        ▼
CM (write | mark | sweep | compact)
```

- **AMPI engine (`runAmpi`)** — looks up a function/mode, asks CM to apply each intent, enforces `maxTurns` and a decreasing progress measure. Notch-1 expressions and worker isolation remain as in ADR-0088 / ADR-0101.
- **CM engine (`applyCm` / `runCm`)** — the only door that splices `messages[]`. Closed `CmIntent` menu. `runCm` applies a sequence with a hard cut cap.
- **Sweep + Compact** — cleanup *under* CM. Not a second runner. Not recipe names.

The shipped built-in path is `sanitize` / `duplicates` (alias `sweep-duplicates`) → `sweep` / `duplicates`. Recipes name a CM intent. They do not return a spliced `messages[]`.

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

CM’s cut menu stays closed, same spirit as AMPI’s function set. The five cuts above are the v1 menu. TCB still decides *what* the stop text or hint says; it calls `applyCm` (`replace` / `tool-result` or `insert` / `system`). No free-form rewrite. No silent deletion without residue.

### What this ADR does *not* change

- TCB detection and the escalation ladder stay in BCB.
- Default-config kill behavior is unchanged (no AMPI tier unless a user writes one).
- Uncertainty / inner-state breakers (ADR-0104) stay proposed and unimplemented until this CM/AMPI split is implemented far enough that trips have a clean landing place.

## Consequences

### Pros

- AMPI stays small: run and terminate.
- Escalation YAML cannot pretend a CGC cut is a recipe.
- Sweep and Compact can grow as modes without inventing a third orchestrator.
- Four AMPI functions cover help, mop, punish, and undo without a long card list.
- Budget compaction can happen without pretending a breaker fired.

### Cons / Trade-offs

- Another named plane (CM) to keep distinct from AMPI in code and docs.
- Two names for the first slice (`sweep-duplicates` alias vs `sanitize` + `sweep` / `duplicates`).
- Phase-boundary detection is unspecified and easy to get wrong.
- Model-nominated marks can delete the useful file; system marks must win on conflict until we have evidence otherwise.

## Open questions (to nail as part of AMPI + CM work)

1. **Phase boundary** — how MBA knows a search or reasoning phase ended (explicit recipe end, next user turn, model token, or all three).
2. **Mark representation** — in-message tag, side table keyed by `tool_call_id` / span, or both.
3. **Who may mark** — system-only for v1 vs model nomination with system veto.
4. **Recipe file format** — still deferred from ADR-0088 / 0101; when it lands, recipes name a CM cut, they do not embed ad hoc splices.

## Implementation order (this before ADR-0104)

1. **Done.** First slice: `sanitize` / `duplicates` (alias `sweep-duplicates`) → `sweep` / `duplicates`. Engines exist (`runAmpi`, `applyCm` / `runCm`). TCB stop-text and hints go through CM Write.
2. Specify mark representation, then `set-mark` and `sweep` modes `scratch` / `budget`.
3. `compact` / `reasoning`; `sanitize` modes `spent` / `phase` / `pin`.
4. `assist` / `clamp` then `feed`.
5. `recover` / `rollback` (needs `pin` first).
6. `sanction` after Assist is real.
7. `assist` / `lost` with ADR-0104, not before.

## Relationship to other ADRs

- **ADR-0088 / 0101:** AMPI’s Notch-1, termination, and daemon-as-proxy runner are unchanged. This ADR splits *context editing* out of “AMPI is the whole intervention product.”
- **ADR-0101 Step 4:** The first shipped path is `sanitize` / `duplicates` (alias `sweep-duplicates` → `sweep` / `duplicates`). Neither name is `context-gc`.
- **ADR-0102:** Policy names an AMPI function (or the `sweep-duplicates` alias), never a CM cut.
- **ADR-0104:** Uncertainty BCB is a detector family. It must not be built until this plane exists far enough to receive a sweep.
