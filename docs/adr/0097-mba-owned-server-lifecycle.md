# 0097 — MBA-owned model server lifecycle: the daemon boots, tracks, and kills its own servers

- **Status:** Proposed
- **Date:** 2026-08-23
- **Deciders:** user + agent
- **Tags:** mba, server-lifecycle, process-management, daemon, cli

## Context and Problem Statement

Before this change, **starting and stopping a model server was owned by a
C-Yard shell script** (`scripts/llama-server-up.sh`). The MBA daemon could
*switch* the loaded model (via the boot script, invoked through an
`MBA_BOOT_SCRIPT` env var) but could not *own* the server process. Consequences:

- The daemon had no idea which server processes it had spawned, so it could
  not clean them up on shutdown — orphaned `llama-server` processes leaked.
- The boot script was a C-Yard artifact; MBA's "standalone framework" goal
  (ADR-0092) was not met because the lifecycle lived outside the package.
- There was no registry of running servers, so the daemon could not answer
  "which model is loaded where, and is it healthy?" without probing blindly.

The goal: **move the entire server lifecycle into the MBA daemon** so it can
boot, track, health-check, and kill any model server it owns, and retire the
C-Yard boot script.

Five decisions were locked before implementation (user: *"yes lets go with A,
G1: group-kill handler, G2: allow new port, G3: adopt the model specific kv
folder, perf #2 waits for warmup"*):

1. **A — in-daemon switch.** The model-switch path boots the new server
   *inside the daemon* (a `defaultSwitchExecutor`) instead of shelling out to
   an external script. The `MBA_BOOT_SCRIPT` env var is retired in favor of
   `MBA_SWITCH_PORT` (the port the in-daemon switch boots on, default 8080).
2. **G1 — process-group ownership + group-kill.** Each spawned server is
   launched `detached: true` so it becomes its own process-group leader. The
   daemon records the group and kills the *whole group* (negative pid) on
   stop and on daemon shutdown — no orphaned children.
3. **G2 — allow a new port.** `bootServer` refuses to boot onto a port that is
   already in use by a registered server (port-busy 409), but a *different*
   port is always allowed, enabling multiple concurrent servers.
4. **G3 — model-specific KV folder.** The slot-save path is derived from the
   model file: `<dirname(modelFile)>/kv/<fork>/slots`, so each model's KV
   cache lives next to its weights.
5. **Perf #2 — boot blocks until warm.** `POST /servers/boot` does not return
   until the server is both healthy *and* has completed a warmup request, so a
   successful boot means "ready to serve," not "process started."

## Decision

**Two-phase lifecycle, all inside `@mba-ai/core`:**

**Phase 1 — registry + detection.** A JSON upstream registry
(`~/.mba/mba/upstreams.json`, `upstream-registry.ts`) records every known
server: `{ id, serverType, modelFile, port, pid }`. `GET /servers` reads the
registry, probes each entry's `/health`, and reports per-entry `healthy` plus
a `resolved` marker (which entry `resolveUpstream` would pick for a given
model). This gives the daemon a live, queryable view of what is running.

**Phase 2 — boot/stop with ownership.** `server-boot.ts` + the repaired
`mba/server-lifecycle.ts` provide:

- `bootLlamaServer` — spawns `llama-server` `detached: true` (G1), builds flags
  via `server-flags.ts`, waits for health then warmup (perf #2), and records
  the owned process group.
- `stopLlamaServer` / `killProcessGroup` — SIGTERM the group, probe up to
  10×200ms, then SIGKILL (G1).
- `bootServer` — the service-level orchestrator: G2 port-busy check → resolve
  the boot recipe (catalog / adapter YAML → flags → CLI args) → `bootLlamaServer`
  → register the entry.
- `killAllOwnedGroups` — on daemon shutdown, `main.ts` kills every owned group
  before closing the HTTP server (G1).
- `slotSavePath(modelPath, fork)` — G3 KV path.

**Service routes** (`server.ts`): `GET /servers` (list + health + resolved),
`POST /servers/boot` (201 on success, 409 port-busy, 404 unknown model, 500
boot-failed), `POST /servers/stop` (stops by pid, removes the entry).

**CLI** (`cli/mba.ts`): `mba servers list|boot|stop`. The restart flow is
rewired to the in-daemon path (`restartServer` stops the current server by
modelFile, then `POST /servers/boot` on the same port) — the external boot
script is no longer invoked.

**C-Yard boot script retirement.** The now-dead `mba/` cluster
(`bouncer.ts`, `server-state.ts`, `boot-error-response.ts` + tests) is deleted;
the barrel (`mba/index.ts`) is trimmed to the surviving lifecycle exports.

## Consequences

**Pros:**

- **The daemon owns its processes.** Every server the daemon boots is tracked
  in an owned-group registry and is guaranteed to be killed on stop and on
  shutdown. No more orphaned `llama-server` processes.
- **Standalone framework goal met (ADR-0092).** The lifecycle no longer depends
  on a C-Yard shell script; MBA can boot/stop servers with nothing but the
  binary path and the model file.
- **Boot means ready.** Because boot blocks until warmup (perf #2), callers
  (CLI, switch executor, MCP) can treat a 201 as "safe to send traffic."
- **Multiple concurrent servers.** G2's per-port policy (refuse busy, allow new)
  sets up Phase 3's multi-instance story without conflating "same port" with
  "same model."

**Cons / Trade-offs:**

- **`resolved` is still a single-winner view.** Phase 1's `resolveUpstream`
  picks one entry per model; with multiple concurrent servers for the same
  model the marker is ambiguous. Hardening this (duplicate-model resolution +
  a deterministic winner) is deferred to Phase 3.
- **Only one server type is implemented.** `serverType` is a free string but
  only `"llama.cpp"` is ever written. The type table (boot/stop/health per
  type) is the Phase 3 "proof of the abstraction."
- **`detached: true` changes process semantics.** Servers no longer share the
  daemon's process group; a kill that targets only the daemon pid would leak
  them. This is *why* G1's group-kill exists — but it means the owned-group
  registry is load-bearing: if it is lost (e.g. registry file deleted while
  servers run), the daemon can no longer clean those groups up.
- **Live service must be restarted to pick up the routes.** A service process
  started before this change has no `/servers` routes; `mba servers *` against
  it returns 404 until `systemctl --user restart mba.service`.
