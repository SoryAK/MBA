# 0096 — `mba` interactive config CLI: service-only front door for per-model dials

- **Status:** Proposed
- **Date:** 2026-08-23
- **Deciders:** user + agent
- **Tags:** mba, cli, model-management, config, ux

## Context and Problem Statement

Per-model dials (`server_setup.json` ctxSize/gpuLayers/threads/…, YAML `client:`
block) had **no human-facing write path**. The only doors were: ask the agent in
chat, `curl POST /set_rules` (global TCB rules only — full-replace dance), or open
the file in an editor. The user found the curl flow "very complicated" and pointed
at the boot script's interactive picker (`llama-server-up.sh`) as the UX to copy.

The parked card (`docs/backlog/parked-ideas.md`, 2026-08-22) proposed an
fzf-style guided CLI. Three Griller questions were answered before implementation:

1. **CRUD scope:** v1 = view + edit only. Model create/delete is v2 (touches
   catalog + lineage tree + watcher — much bigger blast radius).
2. **Edit granularity:** field-by-field menu with per-field validation for known
   dials, plus a raw-file escape hatch (`mba open`).
3. **PATH placement:** global `mba` command via `npm link` (works anywhere;
   re-run after rebuilds).

A fourth requirement was added mid-discussion: when a restart-required dial is
changed on a model that is currently loaded, the CLI must offer to reboot the
**same** model via the boot script (not just print a hint).

## Decision

**Service-only CLI in `packages/core`** (`src/cli/mba.ts`, `bin: mba`):

- The CLI is a **thin client** over the MBA service. It never reads or writes
  adapter files directly. All reads go through `GET /models/config?id=<id>`,
  all writes through `POST /models/config`. The service remains the single
  writer and single source of truth (ADR-0093 model-plane ownership).
- **New service route:** `GET /models/config?id=<id>` returns every known dial
  with its current value, file grouping, and `restartRequired` flag. Reuses
  `readModelDials` from the same capability block as the POST route.
- **New MCP tool:** `mba_set_model_config` — thin wrapper over
  `fetchSetModelConfig`, same fail-soft `{ok, data|error}` pattern as existing
  tools.
- **Interactive menu:** readline raw-mode keypress handler (up/down arrows,
  type-to-filter, Enter to select). No fzf dependency — the menu is ~60 lines of
  stdlib code and covers the actual use case (pick from ≤20 models).
- **Plain command form:** every interactive command has a non-interactive
  equivalent (`mba models` lists, `mba config <id>` prints, `mba set <id>
  <field> <value>` writes) — scriptable, CI-friendly, works over SSH.
- **Restart prompt:** after a write, the service reports `{ restartRequired,
  modelLoaded }`. The CLI owns the user decision:
  - `restartRequired: false` → "saved — synced live, no restart needed."
  - `restartRequired: true`, model not loaded → "takes effect on next boot."
  - `restartRequired: true`, model loaded → y/N prompt to run the boot script
    for the **same** model (`MBA_BOOT_SCRIPT` env override, default
    `~/Dev_Projects/C-Yard/scripts/llama-server-up.sh -Model <id>`).
    `--yes` flag skips the prompt (scriptable reboot).
- **Global install:** `npm link` in `packages/core` → `mba` on PATH.

## Consequences

**Pros:**

- **Service stays the single writer.** The CLI adds a door, not a second
  source of truth. Validation, atomic writes, and the `restartRequired`
  report all live in one place (`model-config.ts`), shared by the route, the
  MCP tool, and the CLI.
- **Zero new dependencies.** The interactive menu is readline raw-mode
  keypress handling (~60 lines). No fzf, no ink, no blessed.
- **Both interactive and scriptable.** The same capability block serves the
  arrow-key menu and the plain `mba set <id> <field> <value>` form. CI and
  SSH sessions get the plain form; local terminal users get the menu.
- **Restart is a user decision, not a side effect.** The service reports
  state; the CLI asks. A `curl` or MCP call never triggers a reboot.

**Cons / Trade-offs:**

- **`npm link` must be re-run after every rebuild.** The global `mba` points
  at `dist/cli/mba.js`; a stale build means a stale CLI. Mitigation: `npm run
  build && npm link` is the documented flow; the CLI prints its version so
  staleness is visible.
- **The live service must be restarted to pick up new routes.** The GET
  `/models/config` route does not exist in a service process started before
  this change. Until the service is restarted, `mba config` / `mba set`
  against the live service return 404. (The POST route has the same
  constraint — it was added in the same session.)
- **Service-discovery logic is duplicated.** The CLI re-implements the
  `baseUrl → MBA_SERVICE_URL → ~/.mba/mba/service.json` chain that
  `service-client.ts` already has. Acceptable for v1 (the CLI is a separate
  entry point with no import path to the mcp-server package); a shared
  `resolveServiceUrl` extraction is a v2 candidate if a third consumer
  appears.
