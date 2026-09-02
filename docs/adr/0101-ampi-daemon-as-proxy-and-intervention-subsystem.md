# ADR 0101: AMPI — Daemon-as-Proxy and the Intervention Subsystem

- **Status:** Proposed
- **Date:** 2026-09-02
- **Deciders:** skaba + agent
- **Tags:** architecture, mba, bcb, tcb, ampi, daemon, proxy, uds, mcp
- **Supersedes (partially):** ADR-0088 (AMPI subsystem boundary — the proxy-centric orchestrator assumption is replaced by the daemon-as-proxy model below)

## Context and Problem Statement

ADR-0088 introduced **AMPI (Automated Multi-Process Intervention)** as a subsystem that TCB trips can summon. Its core insight stands: the existing escalation ladder (nudge → mask → kill) is all **"tell, don't do"** — it rewrites a tool result into a stop message, masks a tool, or kills the call. None of them *fix the underlying situation*. There is a class of failure where the right response is to **intervene and hand the model the correct data**, not just tell it to stop.

But ADR-0088 made a structural assumption that this session's discussion overturned: it placed the stateful AMPI orchestrator **inside the C-Yard proxy**, turning the proxy into a multi-turn conversation holder. That assumption is wrong for two reasons that became clear once MBA was separated from C-Yard (ADR-0092):

1. **Ownership is inverted.** MBA is "the security company" (ADR-0092: "the dealership") — it owns the model-behavior infrastructure: detection, escalation, intervention. C-Yard is "the client" — it defines *which* rules to apply, *which* tools to watch, *which* recipes to fire. Today the actual "watching" (the orchestration loop that holds session state, applies escalation, mutates the request) lives in the C-Yard proxy (`packages/proxy/src/server.ts`), not in MBA. The client is doing the security company's job.

2. **AMPI needs to be in the conversation.** A recipe like "sequentially feed the file, asking 'enough?'" or "prune the duplicate tool calls out of the context" must operate on the live message history and, in some cases, drive additional model round-trips. The component that owns the request path and the context is the natural home for that logic. Putting it in a sidecar that the proxy consults (or a subprocess the proxy spawns) forces the multi-turn state back across a process boundary.

This ADR re-grounds AMPI on the correct ownership model and defines the daemon-as-proxy architecture that makes it possible.

### The motivating example (context garbage collection)

A loop detector trips because the model keeps calling the same tool with the same arguments. The escalation ladder breaks the model out of the loop (nudge, then mask, then kill). But the **repeated tool calls remain in the context** — and that polluted context is what makes the model loop *again*. The guardrail treats the symptom; the intervention treats the cause.

An AMPI recipe for this case — **context GC** — rewrites the conversation the model sees: prune the duplicated tool calls back to the first attempt, and leave a marker message telling the model to try a different approach. This is not "inject a message"; it is **mutating the context**. That power is what makes AMPI "the system's version of auto-scripting."

## Decision

### 1. Ownership model — MBA is the security company, C-Yard is the client

- **MBA owns the infrastructure:** the detection engine (BCB/TCB), the escalation machinery, and the intervention subsystem (AMPI). This is the "how" — how to detect loops, how to escalate, how to rewrite context, how to feed files in chunks.
- **C-Yard (and any other adopting project) provides the rules:** "watch `read_file`, trip at 3, escalate nudge→mask→kill, fire AMPI recipe `context-gc` on kill." This is the "what/when/where" — which tools, which thresholds, which recipes.
- The "watching" loop (session state, escalation application, request mutation, AMPI execution) moves **out of the C-Yard proxy and into the MBA daemon**. The C-Yard proxy no longer owns model-behavior logic.

### 2. Architecture — the MBA daemon is the proxy (Shape B)

The MBA daemon becomes the man-in-the-middle for model requests. It owns the request path, the context, and all model-behavior logic.

```text
VS Code Chat ──TCP :8080──► MBA daemon ──TCP :8081──► llama-server
MCP clients  ──UDS /tmp/mba.sock──► MBA daemon ──TCP :8081──► llama-server
```

- The daemon listens on **both** a UDS file (for MCP clients and internal consumers) and a TCP port (for VS Code's custom-endpoint feature and other HTTP clients).
- **MCP server** (`packages/mcp-server/`) is the public face for MCP clients. It translates MCP tool calls into requests to the daemon via UDS.
- **TCP front** is the public face for VS Code / HTTP clients. The daemon listens on TCP directly (no separate bridge process needed in the common case).
- The daemon forwards model requests to llama-server over TCP (llama-server's existing transport).

### 3. The C-Yard proxy's fate

The C-Yard proxy loses its TCB/escalation/AMPI role. Its remaining responsibilities (grammar injection, KV cache management, SSE streaming, and other model-serving concerns) are either:

- absorbed into the MBA daemon, or
- retained in a thin C-Yard proxy that delegates all model-behavior logic to the MBA daemon.

The exact split is a migration detail (see Migration Staging below), not an architectural commitment. The commitment is: **no model-behavior logic (TCB, escalation, AMPI) remains in the C-Yard proxy.**

### 4. AMPI subsystem — programmatic intervention

AMPI is a **deterministic, reactive auto-process that assists the model in response to breaker trips**, driven by user-authored recipes. It is not a rule with preset conditions; it is a **programmatic response that corrects the model**.

#### 4.1 Detector vs. responder boundary

```text
TCB rule trips ──► escalation ladder ──► [ nudge | mask | kill | ──► AMPI ]
                                                            action: "ampi"
                                                            recipe: "<name>"
                                                                │
                          AMPI subsystem (in the MBA daemon) ◄──┘
                          (recipe registry: user-authored recipes)
                          reads:  trip context, message history, file metadata,
                                  recent tool_calls
                          does:   context rewrite, multi-turn loop, message
                                  injection, state
```

- The escalation ladder gains an `ampi` action target with a `recipe` name. AMPI can be fired from **any** tier — a `nudge` can summon it, not only `kill`.
- AMPI **owns the turn(s)** for the duration of a recipe. Unlike a one-shot result rewrite, a recipe can hold conversation state across multiple model round-trips (a multi-turn loop). Because the daemon *is* the proxy, AMPI has direct access to the context and the model connection — no IPC, no second connection.
- Recipes are **user-authored and named**, registered per-adapter (the client's rules), and referenced from the ladder.

#### 4.2 Recipe power — declarative core + expression language (Notch 1)

Recipe expressiveness is a dial, not a switch. From safest to most powerful:

- **Notch 0 — pure declarative:** a fixed menu of ops; recipe is pure data.
- **Notch 1 — declarative + an expression language:** the *actions* stay a fixed safe menu, but the *logic between steps* can be a small side-effect-free formula language (arithmetic, comparisons, string/JSON lookups). Compute yes; act no.
- **Notch 2 — declarative + a sandboxed engine:** a resource-bounded expression engine (CEL / Starlark class).
- **Notch 3 — declarative + registered pure functions:** enterprises register their own *pure* functions callable by name.
- **Notch 4 — free-form code (`eval`):** **Rejected** on the hot path.

**We adopt Notch 1.** The **action surface (`act`) stays a closed enum** — the line that never moves. The **computation between actions** gets a small expression language so recipes can do real logic without touching the outside world. **Notch 3 (registered pure functions) is the deferred enterprise extension seam.**

#### 4.3 Structural termination (non-negotiable)

AMPI is a **ratchet with a floor**, not an open conversation. Every recipe MUST terminate regardless of model behaviour, enforced by the engine:

1. **Finite progress measure** — each loop iteration strictly decreases a declared measure (e.g. `remainingLines = totalLines − fedUpTo`). At 0 the loop stops no matter what the model said. A recipe that cannot express a decreasing measure does not load.
2. **Hard turn cap** — `maxTurns` backstop in case the measure logic is buggy; on breach AMPI force-stops and falls back to a kill/nudge.
3. **Defined end state** — the model's "yes/no" only chooses *which* exit ramp, never *whether* to exit. AMPI always exits by forcing the model: answer obtained, or content exhausted with a terminal "that is all — proceed" instruction.

Resource caps (turns + compute) ship together with the expression language — power and the termination guarantee are never decoupled.

#### 4.4 Isolation — fast path inline, slow path in a worker

- **Fast path (TCB detection + escalation):** runs inline in the daemon's request handler. It is one-shot, stateless per-request, and must not add latency.
- **Slow path (AMPI recipes):** runs in a **worker thread** (or a child process spawned by the daemon) so that a hung or buggy recipe can be killed without killing the daemon. The daemon owns the request path and the context; the worker owns the recipe's multi-turn state. The daemon decides which path based on the escalation ladder.

This gives Shape B's flexibility (the daemon is in the conversation, recipes have direct context + model access) with Shape C's isolation (a hung recipe can be killed without killing the daemon).

### 5. Transport — UDS for MCP, TCP for HTTP clients

- The daemon listens on a **UDS file** (e.g. `/tmp/mba.sock`) for MCP clients and internal consumers. UDS is faster (no TCP/IP stack), more secure (filesystem permissions, no network exposure), and trivially supports multiple daemons (one socket file per model/project).
- The daemon listens on a **TCP port** (e.g. `127.0.0.1:8080`) for VS Code's custom-endpoint feature and other HTTP clients. VS Code's `chatLanguageModels.json` `url` field points to this TCP port.
- The **endpoint-sync watcher** (which updates `chatLanguageModels.json` when a model is pulled) stays in the daemon. It is unchanged by this ADR — it already lives in the MBA service (`main.ts`), not in the C-Yard proxy. The only change is that the `url` in the generated block points to the MBA daemon's TCP port instead of the C-Yard proxy's port.

### 6. What does NOT change

- **llama-server** remains the model-serving engine. The daemon talks to it over TCP (its existing transport). Whether llama-server itself supports UDS is a separate question (deferred — see Open Questions).
- **The adapter system** (YAML, lineage tree, environment overrides) is unchanged. Adapters continue to carry the `client` block, the `bcb`/`tcb` rule bindings, and (newly) the AMPI recipe bindings.
- **The MCP server** continues to be the control-plane surface (registry, lifecycle, rule management). It gains the ability to forward model requests to the daemon via UDS.

## Consequences

### Pros

- **Correct ownership.** MBA (the security company) owns the watching loop. C-Yard (the client) just defines rules. The architectural inversion is fixed.
- **AMPI is in the conversation.** Recipes have direct access to the context and the model connection. No IPC, no second model connection, no serialization. Multiple recipes can compose and chain naturally.
- **Clean detector/responder separation.** TCB stays pure and deterministic; AMPI owns the stateful, multi-turn intervention. The ladder just names a recipe.
- **Safe by construction.** Notch-1 expressions + a closed `act` enum mean a recipe can be smart but can never reach the network/filesystem or run arbitrary code on live model traffic.
- **Guaranteed termination.** The finite-progress invariant + hard cap make AMPI itself incapable of becoming a doom-loop generator.
- **Isolation without re-architecture.** The worker-thread model gives kill-safety for individual recipes without forcing the daemon to become a god-object.
- **Extensible without forking.** Notch 3 lets enterprises register pure factors later without reopening the action surface.
- **Transport flexibility.** UDS for MCP (fast, secure), TCP for HTTP clients (compatible). Multiple daemons trivially supported.

### Cons / Trade-offs

- **Biggest structural commitment yet.** The daemon becomes the proxy. This is a re-architecture of the request path, not a feature addition. The C-Yard proxy's model-behavior logic must be migrated out.
- **Single point of failure.** The daemon is now the choke point for all model requests. If it crashes, all clients lose model access. Mitigation: the worker-thread model isolates AMPI recipes; the daemon itself is a Node.js process with standard crash-recovery (systemd restart).
- **An expression language to build/maintain.** Even Notch 1 needs a small, safe evaluator; that's a real component (parser, evaluator, caps) with its own bug surface. Mitigation: start with a minimal expression grammar; the `act` enum stays closed.
- **DSL design risk.** A too-small op-set forces enterprise users to wait on core changes; a too-large one becomes a kitchen-sink language. Mitigation: keep the core small and route custom logic to Notch-3 pure functions.
- **Expression + loop = resource-abuse surface even without I/O.** A formula can spin or blow memory. Mitigation: mandatory `maxTurns` + compute caps are part of the definition, not optional.
- **Migration risk.** The C-Yard proxy's request path depends on the TCB/escalation logic being moved. A bad migration breaks the live proxy. Mitigation: staged migration (see below), with the C-Yard proxy retaining a thin pass-through until the daemon is proven.

## Open questions (deferred)

1. **Recipe file format & location** — JSON vs YAML, per-adapter layout, how recipes are versioned.
2. **Enterprise function registration** (Notch 3) — code-registered (vetted at build) vs config-declared (runtime import). Undecided by design.
3. **Expression-language choice** — minimal in-house grammar vs adopting a sandboxed engine (CEL/Starlark). Start minimal; revisit if Notch 1 proves too tight.
4. **How a recipe's multi-turn state interacts with the session-scoped `bcb_kill_state` store** — does AMPI get its own recipe-instance state table, or extend the existing one?
5. **llama-server UDS support** — does the vendored llama.cpp build support listening on a UDS file? If not, the daemon→llama-server hop stays TCP (which is fine; the UDS is for the client→daemon hop).
6. **C-Yard proxy's remaining responsibilities** — which model-serving concerns (grammar, KV, SSE) stay in a thin C-Yard proxy vs. are absorbed into the MBA daemon? This is a migration detail, not an architectural commitment.

## Migration Staging

1. **Step 1 — Daemon-as-proxy.** The MBA daemon gains the ability to accept model requests (TCP + UDS) and forward them to llama-server. The C-Yard proxy still works end-to-end; the daemon is a parallel path.
2. **Step 2 — Migrate TCB/escalation.** Move the TCB detection + escalation application from the C-Yard proxy into the MBA daemon. The C-Yard proxy delegates model-behavior logic to the daemon (or is bypassed for model requests).
3. **Step 3 — AMPI subsystem.** Build the AMPI engine in the daemon: recipe registry, expression evaluator, worker-thread isolation, termination guarantees. Wire the `ampi` action target into the escalation ladder.
4. **Step 4 — First recipe.** Implement the context-GC recipe as the anchor example. Prove the multi-turn loop, context rewrite, and termination guarantee end-to-end.
5. **Step 5 — C-Yard proxy cleanup.** Remove the migrated TCB/escalation logic from the C-Yard proxy. The proxy either disappears or becomes a thin pass-through for non-model-behavior concerns.

## Relationship to prior ADRs

- **ADR-0088 (AMPI):** This ADR supersedes ADR-0088's subsystem-boundary assumption (the proxy-centric orchestrator). ADR-0088's Notch-1 decision, structural-termination requirements, and recipe-power model are **retained** and re-grounded on the daemon-as-proxy architecture. ADR-0088 should be marked `Superseded by ADR 0101` for its boundary section; its Notch/termination sections remain authoritative.
- **ADR-0092 (MBA as a standalone framework):** This ADR is the natural continuation of ADR-0092's "the dealership" positioning. ADR-0092 established that MBA owns the BCB/TCB/AMPI engine; this ADR establishes that MBA also owns the *execution* of that engine (the daemon-as-proxy).
- **ADR-0093/0094 (Model plane ownership / DNA gate):** Unaffected. The model plane (adapters, server lifecycle) is unchanged. This ADR is about the *behavior plane* (TCB/escalation/AMPI) and the *request path*.
