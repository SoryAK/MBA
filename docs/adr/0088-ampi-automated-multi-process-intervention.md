# ADR 0088: AMPI — Automated Multi-Process Intervention

## Status

Proposed — *boundary section superseded by [ADR-0101](./0101-ampi-daemon-as-proxy-and-intervention-subsystem.md) (Proposed): the proxy-centric orchestrator assumption is replaced by the daemon-as-proxy model. The Notch-1 decision, structural-termination requirements, and recipe-power model remain authoritative.*

## Context

The TCB subsystem (ADR-0083, restructured in ADR-0086) detects model-side
doom-loops and reacts via an escalation ladder (ADR-0086 Part 3): **nudge →
mask → kill**. Rule classes (ADR-0087) bundle detectors so a common group
attaches in one line.

But every existing reaction is **"tell, don't do."** A trip rewrites a tool
result into a stop message, masks the tool, or kills the call. None of them
*fix the underlying situation* — they only push the model to stop. There is a
class of failure where the right response is to **intervene and hand the model
the correct data**, not just tell it to stop guessing.

Motivating example (this session): a model tripped an overshoot breaker on
`read_file` because it kept guessing the file's length. The useful response is
not "stop" — it is: look up the file's real `totalLines`, see the range the
model just botched, then either (a) clamp the range and hand back a valid one,
or (b) **sequentially feed** the file in bounded chunks, asking "enough?" and
stopping when the model says yes or the file runs out.

The user's framing: AMPI is **"the system's version of auto-scripting."** It is
not a rule with preset conditions, and sequential feeding is not the feature —
it is one recipe among many. AMPI is a **deterministic, reactive auto-process
that assists the model/system in response to breaker trips**, driven by
user-authored scripts.

## Decision

Introduce **AMPI (Automated Multi-Process Intervention)** as a **separate
subsystem** that TCB trips can summon. The TCB stays a pure detector; the
escalation ladder becomes a **trigger surface** that can fire AMPI at any rung.

### 1. Subsystem boundary — detector vs. responder

```text
TCB rule trips ──► escalation ladder ──► [ nudge | mask | kill | ──► AMPI ]
                                                            action: "ampi"
                                                            recipe: "<name>"
                                                                │
                          AMPI subsystem ◄────────────────────────┘
                          (recipe registry: user-authored scripts)
                          reads:  trip context, db, file metadata, recent tool_calls
                          does:   multi-turn loop, actions, message injection, state
```

- The ladder gains an `ampi` action target with a `recipe` name. AMPI can be
  fired from **any** tier — a `nudge` can summon it, not only `kill`.
- AMPI **owns the turn(s)** for the duration of a recipe. Unlike a one-shot
  result rewrite, a recipe can hold conversation state across multiple model
  round-trips (a multi-turn loop). The proxy becomes a stateful orchestrator
  during a recipe, not just a pass-through that mutates the latest result.
- Recipes are **user-authored and named**, registered like rule-classes (likely
  `.MBA/ampi/<recipe>.json`), and referenced from the ladder.

### 2. Recipe power — declarative core + expression language (Notch 1), registered pure functions deferred (Notch 3)

Recipe expressiveness is a dial, not a switch. From safest to most powerful:

- **Notch 0 — pure declarative:** a fixed menu of ops; recipe is pure data.
- **Notch 1 — declarative + an expression language:** the *actions* stay a fixed
  safe menu, but the *logic between steps* can be a small side-effect-free
  formula language (arithmetic, comparisons, string/JSON lookups — e.g.
  `while: "remainingLines > 0 and attempts < 5"`, `asked: "min(requestedEnd, meta.totalLines)"`).
  Compute yes; act no.
- **Notch 2 — declarative + a sandboxed engine:** a resource-bounded expression
  engine (CEL / Starlark class) built to run untrusted logic safely.
- **Notch 3 — declarative + registered pure functions:** enterprises register
  their own *pure* functions (input → value, no side effects) callable by name.
- **Notch 4 — free-form code (`eval`):** anything goes. **Rejected** on the hot
  path.

**We adopt Notch 1.** The **action surface (`act`) stays a closed enum** — the
line that never moves. The **computation between actions** gets a small
expression language so recipes can do real logic without touching the outside
world. **Notch 3 (registered pure functions) is the deferred enterprise
extension seam** — it keeps the sandbox shut while letting enterprises bring
custom factors. The enterprise power-level (how functions are registered —
code-vetted vs. config-loaded) is **explicitly undecided** and deferred.

### 3. Structural termination (non-negotiable)

AMPI is a **ratchet with a floor**, not an open conversation. Every recipe MUST
terminate regardless of model behaviour, enforced by the engine:

1. **Finite progress measure** — each loop iteration strictly decreases a
   declared measure (e.g. `remainingLines = totalLines − fedUpTo`). At 0 the
   loop stops no matter what the model said. A recipe that cannot express a
   decreasing measure does not load.
2. **Hard turn cap** — `maxTurns` backstop in case the measure logic is buggy;
   on breach AMPI force-stops and falls back to a kill/nudge.
3. **Defined end state** — the model's "yes/no" only chooses *which* exit ramp,
   never *whether* to exit. AMPI always exits by forcing the model: answer
   obtained, or content exhausted with a terminal "that is all — proceed"
   instruction.

Resource caps (turns + compute) ship together with the expression language —
power and the termination guarantee are never decoupled.

## Consequences

### Pros

- **Converts "blocked and stuck" into "unblocked with the right data."** The
  system actively resolves the failure instead of only warning about it.
- **Clean detector/responder separation.** TCB stays pure and deterministic;
  AMPI owns the stateful, multi-turn intervention. The ladder just names a
  recipe.
- **Safe by construction.** Notch-1 expressions + a closed `act` enum mean a
  recipe can be smart but can never reach the network/filesystem or run
  arbitrary code on live model traffic.
- **Guaranteed termination.** The finite-progress invariant + hard cap make
  AMPI itself incapable of becoming a doom-loop generator.
- **Extensible without forking.** Notch 3 lets enterprises register pure
  factors later without reopening the action surface.

### Cons / Trade-offs

- **Biggest structural commitment yet.** Multi-turn recipes make the proxy a
  stateful orchestrator across round-trips — more than the one-shot rewrites we
  have today. This is new session-state machinery (see Part 4 state work).
- **An expression language to build/maintain.** Even Notch 1 needs a small,
  safe evaluator; that's a real component (parser, evaluator, caps) with its
  own bug surface. Mitigation: start with a minimal expression grammar; the
  `act` enum stays closed.
- **DSL design risk.** A too-small op-set forces enterprise users to wait on
  core changes; a too-large one becomes a kitchen-sink language. Mitigation:
  keep the core small and route custom logic to Notch-3 pure functions.
- **Expression + loop = resource-abuse surface even without I/O.** A formula
  can spin or blow memory. Mitigation: mandatory `maxTurns` + compute caps are
  part of the definition, not optional.

## Open questions (deferred)

1. **Recipe file format & location** — JSON vs YAML, `.MBA/ampi/` layout, how
   recipes are versioned.
2. **Enterprise function registration** (Notch 3) — code-registered (vetted at
   build) vs config-declared (runtime import). Undecided by design.
3. **Expression-language choice** — minimal in-house grammar vs adopting a
   sandboxed engine (CEL/Starlark). Start minimal; revisit if Notch 1 proves
   too tight.
4. **How a recipe's multi-turn state interacts with the session-scoped
   `bcb_kill_state` store** — does AMPI get its own recipe-instance state table,
   or extend the existing one?
