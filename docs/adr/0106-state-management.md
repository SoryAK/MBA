# ADR 0106: State Management (SM)

- **Status:** Proposed — parked in the local backlog after erase-after-mop. Catch-up before building SM v1 (see [ADR-0105](0105-context-management-and-ampi.md) order)
- **Date:** 2026-09-08
- **Deciders:** project maintainer + agent
- **Tags:** architecture, mba, sm, ampi, cm, sandbox, phase
- **Relates to:** ADR-0105 (CM / AMPI catalog), ADR-0101 (AMPI runner), ADR-0102 (policy names recipes), ADR-0104 (uncertainty, deferred)

## Context and Problem Statement

ADR-0105 left **phase boundary** open: how MBA knows a search or reasoning chapter ended. Without that signal, `sanitize` / `phase` is a name and the ISM/SM door has nothing honest to call.

Watching tools alone is still a guess (a write *might* mean search is over, or the model is cheating). A named **state** is a contract with a door: in this sandbox these tools are allowed; leaving the sandbox is the scheduled mop point.

This ADR records State Management so the idea is not lost while we build compact first.

## Decision Drivers

- **Clean mop, not a slap.** TCB trips are abrupt and stay that way. Chapter end is a door: compact / sweep, then open the next sandbox.
- **Contract, not a vibe.** A write in discovery is a rule break, not “maybe we flipped to action.”
- **Not a fifth runner.** SM observes and gates. AMPI picks the recipe. CM splices `messages[]`.
- **Not a coding-agent product.** Two sandboxes first (query/discovery vs action). Planning / verification wait.
- **Intent is a factor, not the plane.** Same move as CGC under CM. Do not name the plane ISM.

## Considered Options

- **Option A — Infer phase only from tools.** Rejected as the *only* trigger. Useful as evidence inside a sandbox; not a contract.
- **Option B — Four universal states (Discovery / Planning / Action / Verification).** Rejected as v1. SWE-shaped; MBA is per-model behavior. Extra states can wait.
- **Option C — SM as a sibling orchestrator.** Rejected. Same reason CGC is not a peer to AMPI.
- **Option D — Two sandboxes + a door; intent folded later.** Accepted.

## Decision

Add **State Management (SM)** as the sandbox plane.

```text
SM (which sandbox, door open/shut)
        │
        ▼
AMPI (sanitize | assist | sanction | recover)
        │
        ▼
CM (write | mark | sweep | compact)
```

SM never splices `messages[]`. Escalation YAML never names an SM state or a CM cut.

**Intent** is not in the name and not a sibling. Later it folds under SM (declared goal, transition ask, user “do it”) the way CGC folded under CM (Sweep + Compact). A transition request is a hint. The system decides.

### Two states (v1)

| State | Allowed | Not allowed |
| --- | --- | --- |
| **Query / discovery** | Look: search, list, read | Writes, patches |
| **Action** | Change things | (later: only **pinned** files from discovery) |

- Start in discovery, unless the user already named the file (start in action).
- Adapter tags tools: look vs change. Unknown = closed in discovery.
- Write in discovery = **refuse** (the tool never ran). That is not a TCB trip. TCB is for abuse of tools that *were* allowed (duplicate reads).
- Action may still read; new reads are scratch. Going back to discovery is a door, not a sneak.
- Tell the model the sandbox (CM `insert` / `system`).
- Default **off** (per-model dial), same as AMPI.

### The door

Who may ask: the model, the user (“okay, implement it”), or the system. SM allows or refuses.

On a real transition:

1. Call AMPI `sanitize` / `phase` (sweep scratch + `compact` / `reasoning`, keep pins) **only if the room is dirty**
2. Open the next sandbox

Refuse an empty door: leaving discovery with nothing pinned means action has no keeper list, unless the user named the file.

One chapter, not one session. The next user question may start discovery again.

### What v1 does *not* include

- INTENT.MD
- Planning / verification as required states
- File allowlists before pin is used for real
- Intent as its own plane or ladder name

## Rollout

Lives in the ADR-0105 sequence. Do not skip:

1. **Done.** CM `compact` / `reasoning`
2. **Done.** Pin is a keeper list (`listKeepers`)
3. **Done.** AMPI `sanitize` / `reasoning` then `sanitize` / `phase` (and `pin`)
4. **Done.** llama.cpp slot save / restore / erase (ADR-0097 Phase 4). Sanitize erase-after-mop is wired.
5. **Parked.** SM v1 (two sandboxes + door) — local backlog, catch-up.
6. Assist → Recover → Sanction → ADR-0104

## Consequences

### Pros

- Names the phase-boundary trigger ADR-0105 needed.
- Per-model record: how this weights file behaves in discovery vs action.
- Scheduled mop instead of only mid-turn TCB slaps.

### Cons / Trade-offs

- Another named plane to keep distinct from AMPI and CM.
- Tool look-vs-change tags are adapter facts; unknown MCP names fail closed in discovery.
- False ceremony if every turn is forced through discovery (mitigation: start in action when the user named the file).

## Open questions (nail when SM is built, not during compact)

1. Exact adapter schema for look vs change tool tags.
2. How the current sandbox is persisted (session key vs in-message `mba` meta).
3. Intent-factor shape when it folds in (request message vs structured field).

## Relationship to other ADRs

- **ADR-0105:** SM answers open question 1 (phase boundary). `spent` is retired; the AMPI mode is `reasoning`.
- **ADR-0101 / 0102:** Ladder still names AMPI recipes only.
- **ADR-0104:** Uncertainty trips may later ask SM or AMPI; not before the mop and the door exist.
