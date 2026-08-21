# 0093 — Model plane ownership: MBA owns the model, the proxy is a DNA-gated tenant

- **Status:** Proposed
- **Date:** 2026-08-20
- **Deciders:** user + agent
- **Tags:** infra, proxy, local-llm, mba, model-management, layering

## Context and Problem Statement

The local stack has three layers: the MBA service (1st layer, global, owns the
adapter catalog in `~/models/adapters`), the C-Yard proxy (2nd layer, per
project, does KV reuse + BCB/TCB), and the llama.cpp server (dumb, serves
whatever model it was booted with).

Two facts forced this decision:

1. **The proxy already *assumes* the right model is loaded.** KV reuse is keyed
   to the model-identity tuple `(digest, quant, build)` (ADR-0036) — a request
   served by the wrong model produces a silently useless cache and, worse, a
   silently wrong answer. Today nothing enforces that assumption; it is
   implicit.
2. **The VS Code custom-endpoint picker is static.** The model list shown to
   the user is the `models` array in the user's VS Code config JSON — not a
   dynamic `/v1/models` fetch. There is no "model selected" webhook; the only
   wire signal of a user's choice is the first chat request carrying the new
   `model` id.

The question: who owns the *model plane* — the catalog of what exists, the
state of what is loaded, and the act of switching? An earlier proposal had the
proxy call `ensureModel` on its request path (Ollama-style auto-switch). The
user rejected it: that keeps the switch dependent on the proxy running, which
inverts the intended dependency direction (proxy → MBA → server). The user's
click in the picker is the only legitimate switch trigger, and the path from
that click to the switch must not include the proxy.

## Decision Drivers

- **Dependency direction.** Strictly downward: proxy depends on MBA, MBA
  depends on the server. The proxy must never be a prerequisite for switching
  models.
- **Safety invariant.** A request must never be silently served by the wrong
  model. The proxy's existing model-identity extraction (for KV keying) is the
  natural enforcement point.
- **Single source of truth for names.** Model ids in the user's VS Code config
  must match the adapter-tree ids, so the picker and the requests always agree.
- **User authority.** Switching is a deliberate user action, not an
  infrastructure side effect. The accepted UX cost is a two-step flow
  (switch, then chat).

## Considered Options

- **Option A — Proxy owns switching.** Proxy calls `ensureModel(id)` on the
  request path; if the model isn't loaded, the proxy triggers the switch and
  waits. Ollama-style seamless UX.
- **Option B — MBA owns the model plane; user triggers; proxy is a gatekeeper.**
  MBA service gains `listModels()` + `ensureModel(id)`. The user triggers a
  switch through a door that bypasses the proxy (MCP tool / CLI). The proxy
  performs a DNA check per request and rejects (409) on mismatch.
- **Option C — Dynamic picker via proxy `/v1/models`.** Proxy serves the union
  catalog so the client's picker is dynamic. Rejected on discovery: the
  custom-endpoint picker is static config, so this solves a problem the client
  doesn't have.

## Decision Outcome

**Chosen option: "Option B"**, because it is the only option where the switch
trigger reaches MBA by a path that does not include the proxy, preserving the
layering the user requires: MBA (1st) → proxy (2nd) → llama.cpp server.

**Default-off switch (user mandate, 2026-08-20):** the switching capability is
**disabled by default**. The model manager's read side (`listModels`: catalog +
loaded state) is always available; the write side (`ensureModel`) is gated
behind an explicit opt-in (service flag / env, e.g. `MBA_MODEL_SWITCH=on`).
While off, `ensureModel` returns a clear "model switching is disabled" error
rather than acting. Nothing in the stack may call `ensureModel` implicitly —
the only callers are the user (MCP tool / CLI) with the flag on.

### The shape

```text
User opens picker → clicks a model (picker list = static VS Code config)
        │
        ▼
User (or agent) runs the switch — MCP tool `mba_ensure_model` or CLI
        │  (path: user → MBA service → llama.cpp; proxy NOT involved)
        ▼
MBA SERVICE (1st layer) — model manager
        │  listModels():  adapter-tree catalog + live loaded state
        │                 (probe llama-server /v1/models)
        │  ensureModel(id): idempotent — loaded? done.
        │                   not loaded? detect mechanism (in-place
        │                   model-set endpoint if the fork exposes it,
        │                   else stop + llama-server-up.sh -Model <id>)
        │                   → poll /health → done
        ▼
llama.cpp server (dumb; serves whatever it was booted with)

PROXY (2nd layer) — pure gatekeeper
        │  per request: DNA check — does the running model's identity
        │  (digest/quant/build from /v1/models + /props) match the
        │  requested model id (resolved via the adapter tree)?
        │    match  → serve (KV reuse active)
        │    no     → 409, message names the loaded model + the exact
        │              switch command
        │  MBA down → proxy runs as today (passthrough); the DNA gate
        │             still protects against wrong-model serving
```

### Positive Consequences

- **Dependency arrow points down.** Proxy down → models can still be listed
  and switched (MCP/CLI). MBA down → proxy degrades to today's passthrough
  behavior; the DNA gate still rejects wrong-model requests.
- **The implicit assumption becomes an enforced invariant.** The proxy already
  extracts model identity for KV keying (ADR-0036); the DNA gate reuses that
  extraction as a safety check. Wrong-model serving becomes impossible, not
  just unlikely.
- **Names come from one source.** Adapter-tree ids are canonical; the VS Code
  config's `id` values are set to match. No more unresolvable model names.
- **MBA's catalog is already built.** `mba_model_registry` reads the adapter
  tree offline; the model manager extends the existing service with two
  endpoints, not new infrastructure.

### Negative Consequences

- **Two-step UX.** Switching a model is a deliberate action (run the switch,
  then chat). Clicking a model in the picker and immediately chatting 409s
  until the switch runs. Accepted explicitly by the user in exchange for the
  proxy having zero authority over the model plane.
- **Default-off adds a third step until opted in.** Until
  `MBA_MODEL_SWITCH=on` is set, even the deliberate switch is unavailable —
  the user must enable the flag first. Accepted: the capability exists but
  must be consciously armed.
- **The 409 must be excellent.** The rejection message must name the loaded
  model and the exact switch command, or the user is left staring at an
  opaque error. This is a UX requirement, not a nicety.
- **Switch latency is on the user.** An 18 GB model re-boot takes tens of
  seconds; the user waits with no request in flight to carry progress.
  (Mitigation: the MCP tool / CLI can stream progress.)
- **Two front doors to the same capability** (MBA HTTP endpoints + MCP tools)
  must stay in sync; the MCP tools are thin wrappers over the service, so
  drift is bounded but real.

## Pros and Cons of the Options

### Option A — Proxy owns switching

- ✅ Seamless UX: click model, first reply is slow, done.
- ❌ Switch depends on the proxy running — inverts the required layering.
- ❌ Switch logic (a 1st-layer concern) leaks into the 2nd layer.
- ❌ A proxy bug can trigger an 18 GB reload mid-session.

### Option B — MBA owns the model plane (chosen)

- ✅ Dependency direction preserved; proxy has zero switch authority.
- ✅ DNA gate makes wrong-model serving impossible.
- ✅ Reuses the existing MBA service + adapter catalog + proxy identity probe.
- ❌ Two-step UX; 409 on forgotten switch.
- ❌ Switch latency is user-visible with no request in flight.

### Option C — Dynamic picker via proxy `/v1/models`

- ✅ Would make the picker self-maintaining *if* the client used it.
- ❌ The custom-endpoint picker is static config — solves a non-problem.
- ❌ Still leaves the switch-authority question unanswered.

## Phased Implementation (one-caller-at-a-time)

1. **MBA service: model manager.** `GET /models` (catalog + loaded state,
   always on) and `POST /models/ensure` (idempotent switch, **off by default**
   — gated behind `MBA_MODEL_SWITCH=on`; returns a "disabled" error while off)
   on the existing hono app. Switch-mechanism detection: probe the fork's
   in-place model-set endpoint; fall back to stop +
   `llama-server-up.sh -Model <id>`.
2. **MCP side door.** `mba_list_models` + `mba_ensure_model` tools as thin
   wrappers over the service endpoints (for user/agent use from the IDE).
3. **Proxy DNA gate.** Per-request identity check reusing the existing
   model-identity extraction; 409 with loaded-model name + switch command on
   mismatch. MBA-down = passthrough as today, gate still active.
4. **VS Code config update.** `id` values become canonical adapter-tree ids.

Each phase gets `get_errors` + targeted tests before the next.
