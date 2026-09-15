# AMPI

**AMPI** (automated multi-process intervention) is MBA stepping into the
live conversation when a breaker trips.

BCB is the watch. It notices a known failure and the ladder can still
hint, mask, or kill — tell the model to stop. AMPI is the other option:
actually do something about it.

It isn’t a second model. It’s a named recipe the daemon runs. It takes
the next turn, or a few, does that job, and gets out. It always finishes.
That is the whole point — a response that owns the moment, then hands the
thread back.

## What is live

**Sanitize** is the job that ships. The window picked up dirt from a trip
or a closed stretch of work. Clean it up, stay on this thread, and don’t
put new truth in the model’s mouth. Loop first-trip is
`sanitize/duplicates`.

For now, AMPI **is** Sanitize. Hint, mask, kill, and clamp already live
on the ladder and TCB. A second function waits on a *different* kind of
do — not mop, not tell, not hide-or-kill. Until that job shows up, do
not implement Assist, Sanction, or Recover.

AMPI is that response engine: a named recipe, a finish, a hand-back. It
is not a four-item product menu.

## What is not a menu

ADR-0105 named three more jobs as a starting inventory: **Assist**
(supply what’s missing), **Sanction** (a consequence the ladder’s
hint/mask/kill is not), **Recover** (undo a stretch). Those names are a
hypothesis, not recipes on the ladder, and not the next build queue.

What we already know not to build under those names:

- Help that re-opens a file the client refused is a confused deputy.
  Clamp already lives on TCB. Do not add an MBA file allowlist.
- A “real” punish is likely still mask/kill, not a fourth runner.
- Undo is likely CM mark + sweep, which Sanitize already names (`pin`,
  `scratch`, `phase`).

A second AMPI function waits on a *different* “do” that does not open
files or add operator lists. Until then the engine is Sanitize (settled
for now — see [What is live](#what-is-live)).

## What AMPI is not

- **Not TCB / BCB.** Those watch and trip. AMPI is what may run after.
- **Not CM.** AMPI does not splice `messages[]`. It names a recipe and
  asks Context Management to cut.
- **Not SM.** State Management is which sandbox the model is in. AMPI
  does not pick the room.
- **Not the escalation ladder.** The ladder only *names* a recipe. It
  never names a CM cut or an SM state.

## How it runs

```text
TCB / BCB trip
        │
        ▼
escalation ladder  →  action: ampi, recipe: <name>
        │
        ▼
AMPI  (parse string → look up recipe → run until it terminates)
        │
        ▼
CM    (closed cut on messages[])
```

**Wrong** — the ladder pretends a CM cut is a recipe:

```yaml
escalation:
  tiers:
    - { tier: kill, afterIgnoredTrips: 1, action: ampi, recipe: context-gc }
```

**Right** — the ladder names AMPI; the recipe body asks CM:

```yaml
escalation:
  tiers:
    - { tier: kill, afterIgnoredTrips: 1, action: ampi, recipe: sanitize/duplicates }
```

```text
recipe: sanitize          # AMPI function — the only kind of name on the ladder
  what: duplicates        # mode
    └── cm.sweep          # CM cut — never listed on the ladder
```

`sweep-duplicates` is an alias for `sanitize` + `duplicates`. `context-gc`
is retired: it collapsed runner and cut into one string.

The MBA daemon is the proxy, so AMPI sits on the live request path. It
reads trip context and the current chat; it does not live in a sidecar
the client consults. Policy (which tools, which thresholds, which recipe
name) stays in the adapter / catalog. AMPI is the *how*.

### Termination

AMPI is a ratchet with a floor, not an open conversation. Every recipe
must finish regardless of what the model does:

1. **Finite progress** — each turn strictly decreases a declared measure.
   At 0 the loop stops. A recipe that cannot express that does not load.
2. **Hard turn cap** — `maxTurns` if the measure is wrong. On breach,
   AMPI force-stops and falls back to kill/nudge.
3. **Defined end** — the model’s yes/no picks *which* exit, never
   *whether* to exit.

### Power

The action surface (`act`) is a closed enum — that line does not move.
Logic between steps is Notch-1: a small side-effect-free expression
language (compute yes, act no). Free-form `eval` on the hot path is
rejected. User-authored recipe files and a worker-thread isolation path
are specified; they are not what the built-ins use today.

## Functions, modes, and CM

Same shape on both planes, different words, so a CM cut is never an AMPI
function. The four-row map below is the ADR-0105 inventory. Only
**Sanitize** is a loadable recipe today.

```text
AMPI (why)              CM (how)
Sanitize   ---------->  Sweep, Compact     ← live
Assist     ---------->  Write              ← not on the ladder
Sanction   ---------->  Write (hard residue, no handoff)
Recover    ---------->  Mark + Sweep (rollback to pin)
```

| AMPI function | Job | Status | CM it usually asks |
| --- | --- | --- | --- |
| Sanitize | Mop dirt, stay on this thread. No new truth. | Live | Sweep, Compact |
| Assist | Help forward: supply what’s missing. | Hypothesis | Write |
| Sanction | Consequence after bad behavior. No handoff. | Hypothesis | Write |
| Recover | Undo the bad stretch, or reset the chapter. | Hypothesis | Mark + Sweep |

### AMPI modes

A mode is how a function is carried out, not a fifth function.

- **`sanitize`** — `{ what: duplicates | scratch | reasoning | phase | pin, pin?: true }` — live
- **`assist`** — `{ how: supply | redirect | lost }` — named in ADR-0105, not registered
- **`sanction`** — `{ how: revoke }` — named, not registered
- **`recover`** — `{ how: rollback | reset }` — named, not registered; needs `pin` first

### Ladder strings

Policy names AMPI only ([ADR-0102](adr/0102-catalog-and-policy-assembly.md)).
The daemon parses the string, then `runAmpi`.

Live strings: `sanitize`, `sanitize/duplicates`, `sanitize/scratch`,
`sanitize/reasoning`, `sanitize/phase`, `sanitize/pin`, plus optional
`+pin` (e.g. `sanitize/phase+pin`). Alias: `sweep-duplicates`.

Compact still needs a trip that names one of those recipes. The reasoning
dial is read from the adapter at request time; off → no compact.

### CM cuts (what AMPI asks)

CM is its own plane. Its v1 menu is five knives in four boxes. AMPI
recipes name an intent; they do not return a spliced `messages[]`.

| Category | Cuts |
| --- | --- |
| **Write** | `replace`, `insert` |
| **Mark** | `set-mark` (`scratch` \| `pin` \| `clear`) |
| **Sweep** | `sweep` (`duplicates` \| `scratch` \| `budget`; later `rollback`) |
| **Compact** | `compact` (`reasoning`) |

- **`replace`** — overwrite one message. Targets: `tool-result`, `system`,
  `residue`. Out of bounds: the user’s original ask, assistant `tool_calls`.
- **`insert`** — add a message. Roles: `system`, `user`. Out of bounds:
  forging a tool call.
- **`set-mark`** — tag only; does not delete.
- **`sweep`** — drop by policy; always leave residue.
- **`compact`** — rewrite a span to a short residue (not a drop).

Do not merge Sweep into Compact. Do not merge Mark into Sweep. Write stays
two cuts (replace vs insert). CM can also run without AMPI (window-full
compaction). Budget compaction is a CM job even if no breaker fired.

The plane split, CGC-as-family, and closed-edit rationale are
[ADR-0105](adr/0105-context-management-and-ampi.md).

## In the tree

Code: `packages/core/src/ampi/` (`engine.ts`, `parse-recipe.ts`,
`registry.ts`, `recipes/`). The daemon calls `parseAmpiRecipe` then
`runAmpi` from the intervention path.

Built-in registry today: `sanitize` and the `sweep-duplicates` alias.
Both ask CM `sweep` / `duplicates`. Loop classes and the global
`repeatRun` seed name `sanitize/duplicates` on the first trip. TCB
stop-text and hints already go through CM Write.

What a given npm release actually shipped is
[`packages/core/CHANGELOG.md`](../packages/core/CHANGELOG.md), not this
page.

## Decisions

| ADR | Why it exists |
| --- | --- |
| [0088](adr/0088-ampi-automated-multi-process-intervention.md) | Why intervene at all (Notch-1, terminate). Boundary later replaced. |
| [0101](adr/0101-ampi-daemon-as-proxy-and-intervention-subsystem.md) | Runner lives in the daemon-as-proxy. Termination restated. |
| [0102](adr/0102-catalog-and-policy-assembly.md) | Policy names AMPI recipes, never CM cuts. |
| [0105](adr/0105-context-management-and-ampi.md) | AMPI vs CM vs CGC. Ladder never names a cut. |
| [0104](adr/0104-uncertainty-and-inner-state-bcb.md) | Uncertainty breaker (detector). `assist/lost` waits on it. |
| [0106](adr/0106-state-management.md) | Sandbox / door. Not a fifth runner. |

## Related

- [README](../README.md) — short pitch (BCB and AMPI)
- [ADR-0097](adr/0097-mba-owned-server-lifecycle.md) — llama.cpp slot save /
  restore / erase after a real splice (Phase 4)
