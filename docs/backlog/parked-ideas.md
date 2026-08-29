# MBA Backlog — Parked Ideas

> Parked ideas with enough context to resume without re-deriving the design.
> Each card: **Idea** · **Why** · **Design state** · **Open questions** · **Re-entry trigger**.

---

## ✅ `mba` interactive config CLI (fzf-style guided flow) — **BUILT 2026-08-23**

**Parked:** 2026-08-22 · **Built:** 2026-08-23 — see [ADR-0096](../adr/0096-mba-config-cli.md)
and `.Manual/mba-config-cli.md`. Shipped: `mba models` / `mba config` / `mba set`
/ `mba open` (global via `npm link`), `GET` + `POST /models/config` routes,
`mba_set_model_config` MCP tool, restart prompt (reboots same model via boot
script). Griller answers: v1 = view+edit only (no CRUD); field menu + raw-file
escape hatch; global PATH via `npm link`. Not shipped: `mba run` (boot-script
wrapper — the boot script itself remains the run door).

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
- Related piece (built 2026-08-23): `mba_set_model_config` MCP tool + `POST`/`GET
  /models/config` routes (per-model write knob with validation + atomic write). The CLI
  and the routes share the same capability block (`src/service/model-config.ts`,
  explicit params, structured output).

**Open questions (The Griller — answered 2026-08-23, see ADR-0096):**

1. **CRUD scope:** v1 = view + edit only (80% of actual use), model create/delete as v2?
   (Create/delete touches catalog + lineage tree + watcher — much bigger blast radius.)
2. **Edit granularity:** field-by-field menu with per-field validation (ctxSize is a number,
   gpuLayers ≤ GPU layer count) vs. "open raw file in editor" escape hatch?
   Leaning: (a) for known dials + (b) as escape hatch.
3. **PATH placement:** global `mba` symlink (works anywhere, must maintain) vs.
   `npm run mba -w @mba-ai/core` (repo-scoped, no pollution)?

**Re-entry trigger (v2):** Model create/delete in the CLI — touches catalog +
lineage tree + watcher, deferred from v1. Also: shared `resolveServiceUrl`
extraction if a third service consumer appears (ADR-0096 trade-off).

---

## npm auto-publish stage (Jenkins)

**Parked:** 2026-08-25 — surfaced while confirming CI behavior after the
ADR-0098 push.

**Idea:** Add a publish stage to the `Jenkinsfile` so that a green build on
`main` automatically bumps the version and publishes `@mba-ai/core` (and
`@mba-ai/mcp-server` if/when it becomes public) to the npm registry. Today the
pipeline is Checkout → Install → Typecheck → Test → Build only — the npm
registry is never touched.

**Why:** The root `package.json` is `"private": true` and nothing in CI calls
`npm publish`, so every release is a manual local `npm publish` dance.
`@mba-ai/core` already has a `prepublishOnly` script (build gate) that is
currently dead weight — auto-publish would put it to work.

**Design state (not yet decided):**

- **Trigger:** publish only on `main` (or on tag push — `v*` tags are the
  cleaner signal; Poll SCM + tag detection needs a small Jenkins tweak).
- **Version bump:** `npm version patch|minor|major --no-git-tag-version`
  driven by conventional-commit analysis, or manual tag-driven (tag name IS
  the version — no bump step at all).
- **Credential:** `NPM_TOKEN` Jenkins credential (npm automation token,
  `publish:access` scope) injected as `//registry.npmjs.org/:_authToken`.
- **Scope:** publish `@mba-ai/core` only for now; `@mba-ai/mcp-server` stays
  private until it has a real external consumer.
- **Safety:** `npm publish --dry-run` as a pre-stage; publish stage fails the
  build (not just warns) so a broken publish is visible.

**Open questions (The Griller — unanswered):**

1. **Tag-driven vs commit-driven?** Tag-driven (`v1.2.3` → publish 1.2.3) is
   the standard, auditable pattern and avoids double-publish races;
   commit-driven (bump on every green main) is simpler but makes version
   numbers meaningless. Leaning: tag-driven.
2. **Who can push tags?** Only the repo owner, or anyone with push access?
   (Tag = release = public artifact; treat it as a privileged action.)
3. **Rollback story:** npm versions are immutable — a bad publish means
   `npm deprecate` + republish. Is that acceptable, or do we want a
   `next`/`beta` dist-tag lane for untested releases first?

**Re-entry trigger:** When a second machine (or a teammate) needs `@mba-ai/core`
from npm instead of a git clone — i.e. when the package has a real external
consumer. Until then, local `npm link` / git-clone is the distribution path.
