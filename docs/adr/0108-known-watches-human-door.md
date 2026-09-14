# ADR 0108: Known watches as a human door

- **Status:** Accepted
- **Date:** 2026-09-13
- **Deciders:** project maintainer + agent
- **Tags:** mba, cli, tcb, bcb, watches, policy
- **Relates to:** ADR-0093 (daemon owns the model plane), ADR-0096 (CLI is a thin door), ADR-0102 (catalog vs policy assembly), ADR-0105 (loop mop is Sanitize)

## Context and Problem Statement

`read_file` is already watched: overshoot clamp, past-EOF stop, read-loop mop.
Empty house `tcb.jsonl` (`{}` or no rule lines) means **inherit** that seed —
not off. Operators had no honest door for that.

What existed:

- Dials have `mba models set`. Watches lived in JSONL.
- `mba_set_rules` (MCP) mutates the **global expanded** TCB. That is not a
  per-model house door, and it is not inherit/off/on.
- ADR-0102’s project policy file (assembly of class names) is still the future
  source of truth. It is not shipped as the operator UX.

Without a door, people either edit JSONL (violates the thin client) or think
an empty file turned the watch off.

Commands take a **model id** (left column of `mba models list`). Family is the
parent house, not the argument.

## Decision Drivers

- **Show, then inherit / off / on.** Not a policy IDE. Not a class editor.
- **Empty means inherit.** Family `tcb.jsonl`, then the global seed. All three
  known watches default on.
- **Daemon writes the file.** Same as dials (ADR-0096 / 0093). `mba` never
  patches JSONL.
- **Known set is small.** v1 is the three `read_file` watches the product
  already ships. Do not invent a general rule browser.
- **Loop off is the whole detector.** Taking Sanitize off the loop while
  leaving `repeatRun` on is a later mode, not v1.

## Considered Options

- **Option A — Tell people to edit `tcb.jsonl`.** Rejected. CLI would become a
  second writer; empty-file meaning would stay ambiguous.
- **Option B — Wrap `POST /set_rules`.** Rejected. That store is global
  expanded TCB. A model house is not a full-replace of HQ.
- **Option C — Ship ADR-0102 project policy as the first door.** Rejected as
  v1. Assembly is the right end state; it is not what you type after
  `mba start`.
- **Option D — Three named watches, inherit / off / on, model file only.**
  Accepted.

## Decision

**Known watches are a per-model overlay on the seed, with a CLI that matches
dials.**

### The three

| id | tool | rule | Job |
| --- | --- | --- | --- |
| `clamp` | `read_file` | `readClamp` | overshoot clamp |
| `eof` | `read_file` | `eofOverflow` | past-EOF stop |
| `loop` | `read_file` | `repeatRun` | read-loop mop (Sanitize on first trip) |

### Modes

- **on** — this model’s `tcb.jsonl` has `{ tool, rule, enabled: true }`
- **off** — same line, `enabled: false` (loop off = no loop watch, including mop)
- **inherit** — drop that rule line; fall back to family, then the global seed

Effective: **model line > family `tcb.jsonl` (parent of the model dir) > global
seed.** Seed defaults are all on.

### Doors

- `GET /models/watches?id=` — omit id for seed defaults
- `POST /models/watches` `{ id, watch, mode }` — writes **model** `tcb.jsonl` only
- `mba models watch <id>` — show
- `mba models watch <id> loop off` — set (`inherit` / `off` / `on`)
- `mba models show` and `mba status` include the three

`<id>` is a model id. A family name 404s.

Does **not** wrap `POST /set_rules`. Does not edit the AMPI recipe on the loop.
Code: `packages/core/src/service/model-watches.ts`.

## Consequences

### Positive

- Empty house stays inherit, and the operator can see it.
- Thin client holds: one capability block, CLI and HTTP.
- Room left for ADR-0102 assembly without teaching JSONL first.

### Negative / deferred

- No “loop on, Sanitize off” (detector without mop).
- No family-level `mba models watch qwen` (family is not an id).
- No MCP twin of POST yet. `mba_set_rules` remains the global expanded path.
- ADR-0102 project policy is still not the authoring file.

## Relationship to other ADRs

- **ADR-0096 / 0093:** Same “daemon writes, CLI asks” as dials.
- **ADR-0102:** Catalog and project assembly stay the future policy language.
  This ADR is the v1 human door for three shipped watches.
- **ADR-0105:** Loop’s first trip names `sanitize/duplicates`. Watch `off`
  removes that trip; it does not rename the recipe.
