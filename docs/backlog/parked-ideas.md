# MBA Backlog — Parked Ideas

> Parked ideas with enough context to resume without re-deriving the design.
> Each card: **Idea** · **Why** · **Design state** · **Open questions** · **Re-entry trigger**.

---

## 🔵 `mba` interactive config CLI (fzf-style guided flow)

**Parked:** 2026-08-22

**Idea:** A terminal command (`mba run` / `mba open` / `mba config`) that walks the user
through a guided menu instead of hunting for files:

1. Search / pick a model (fzf fuzzy search + preview, like `llama-server-up.sh`)
2. See the full lineage (adapter tree: family → model → env overrides)
3. CRUD on models (create / delete — scope TBD)
4. Pick a model → list all its config files (`server_setup.json`, `<model>.yaml`, …)
5. Pick a config → list editable fields with current values
6. Edit a field (validated) → save → the running service's watcher auto-syncs VS Code

**Why:** The only human-facing write doors today are (a) ask the agent in chat, (b) `curl`
`POST /set_rules` (global TCB rules only — full-replace, read→tweak→write-back dance),
(c) open the file in an editor. Per-model dials (`server_setup.json` ctxSize/gpuLayers,
YAML `client:` block) have **no write path at all**. The user found the curl flow
"very complicated" and pointed at the boot script's interactive picker as the UX to copy.

**Design state (decided in discussion):**

- **Option A (recommended): TypeScript CLI in `packages/core`** — new `src/cli/`,
  `bin: mba` in package.json. Reuses `model-catalog.ts` (search/lineage),
  `resolve-server-recipe.ts` (4-rung merge), existing YAML/JSON parsing, and the same
  validators the service uses → menu reflects provably the same data the service syncs.
  Cost: `bin` entry + tsx startup (~1s).
- **Option B (rejected for now): bash script** — zero deps but re-derives the adapter
  tree with `find`+`jq` and hand-maintains the editable-field list → two sources of truth.
- The CLI is a **writer only**; the persistent systemd service (`~/.config/systemd/user/mba.service`)
  stays the sync engine. No new sync mechanism.
- Related unbuilt piece: `mba_set_model_config` MCP tool + `POST /models/config` route
  (per-model write knob with validation + atomic write). The CLI and this route can share
  the same capability block in `src/lib`-style (explicit params, structured output).

**Open questions (The Griller — unanswered at park time):**

1. **CRUD scope:** v1 = view + edit only (80% of actual use), model create/delete as v2?
   (Create/delete touches catalog + lineage tree + watcher — much bigger blast radius.)
2. **Edit granularity:** field-by-field menu with per-field validation (ctxSize is a number,
   gpuLayers ≤ GPU layer count) vs. "open raw file in editor" escape hatch?
   Leaning: (a) for known dials + (b) as escape hatch.
3. **PATH placement:** global `mba` symlink (works anywhere, must maintain) vs.
   `npm run mba -w @mba-ai/core` (repo-scoped, no pollution)?

**Re-entry trigger:** Next time per-model dial editing is painful (changing ctxSize /
gpuLayers / client block without opening the file), or when the `mba_set_model_config`
route gets built — the CLI is the natural front door for it.
