# `mba` Config CLI

## Feature Name

`mba` — interactive config CLI for per-model dials (server_setup + client block).

## Functional Description

`mba` is a global terminal command that lets the user view and edit a model's
configuration dials without hunting for files or hand-editing JSON/YAML. It
walks the user through:

1. **Pick a model** — interactive fuzzy menu (arrow keys + type-to-filter) or
   plain `mba models` list.
2. **See its dials** — `mba config <model>` prints every known dial with its
   current value, grouped by file (`server_setup` vs `client`), with a
   `[restart]` marker on dials that require a server reboot to take effect.
3. **Edit a dial** — `mba set <model> <field> <value>` writes the value with
   per-field validation (integers, booleans, enums, `gpuLayers ≤ blockCount`).
4. **Restart when needed** — if the edited dial requires a reboot and the
   model is currently loaded, `mba` asks whether to reboot the **same** model
   in-daemon (stop the model's current server, then `POST /servers/boot`).
5. **Escape hatch** — `mba open <model> [server_setup|yaml]` prints the file
   path for raw editing.

The CLI is a **thin client** over the MBA service — it never touches adapter
files directly. The service validates, writes atomically, and reports whether
a restart is required.

## Internal Workflow

1. **Service discovery** — `resolveServiceUrl()` checks, in order: explicit
   `baseUrl` (not exposed in v1), `MBA_SERVICE_URL` env (deprecated alias
   `CYARD_MBA_SERVICE_URL`), then `~/.mba/mba/service.json` (written by the
   service on startup). No discovery → exit 2 with a hint.
2. **`mba models`** — `GET /models` → interactive menu (TTY) or plain list
   (non-TTY / piped). Menu: up/down arrows, type-to-filter on id+name, Enter
   selects, Backspace edits filter, Ctrl-C cancels.
3. **`mba config <id>`** — `GET /models/config?id=<id>` → prints the YAML and
   `server_setup.json` paths, the profile `blockCount`, and every dial grouped
   by file with current value and `[restart]` marker. Absent dials show as
   `null` (not set — inherited from defaults at boot).
4. **`mba set <id> <field> <value>`** — GET-first: fetches the dials, finds
   the field's spec to resolve which file it belongs to (`server_setup` or
   `client`), then `POST /models/config` with `{ id, file, field, value }`.
   Unknown field → error listing the known fields for that model.
5. **Service-side write** (`model-config.ts` capability block) — validates the
   value against the field spec (positiveInt / int / bool / enum / string;
   `gpuLayers` capped at the profile's `blockCount`), writes the file
   atomically (tmp + rename), and returns `{ file, field, before, after,
   restartRequired, modelLoaded }`. `modelLoaded` comes from probing the
   running llama.cpp server.
6. **Restart prompt** (CLI-side decision):
   - `restartRequired: false` → "saved — synced live, no restart needed"
     (the service's watcher picks up `client.*` changes live).
   - `restartRequired: true`, model not loaded → "takes effect on next boot."
   - `restartRequired: true`, model loaded → y/N prompt → **in-daemon
     restart**: stop every server running this model, then `POST
     /servers/boot` on the switch port (`MBA_SWITCH_PORT` env, default 8080).
     The daemon owns the server lifecycle (ADR-0092/0097); the retired
     C-Yard boot script is no longer used.
   - `--yes` (or non-TTY stdin) **never restarts** — it skips the prompt and
     prints the manual hint `mba servers boot <id> <port>` instead.
7. **`mba open <id> [server_setup|yaml]`** — `GET /models/config?id=<id>` →
   prints the `server_setup.json` path (default) or the adapter YAML path.

## Configuration/Params

| Param | Source | Default |
| --- | --- | --- |
| Service URL | `MBA_SERVICE_URL` env → `~/.mba/mba/service.json` | — |
| Restart/boot port | `MBA_SWITCH_PORT` env | 8080 |
| Skip restart prompt | `--yes` flag (never restarts; prints the hint) | off (prompt) |

**Editable dials** (defined in `packages/core/src/service/model-config.ts`):

- `server_setup` (all `[restart]`): `ctxSize`, `gpuLayers` (≤ blockCount),
  `threads`, `parallel`, `cacheReuse`, `cacheRam`, `specType`,
  `specDraftMax`, `reasoningBudget`, `flashAttn` (on/off), `warmupTokens`.
- `client` (live-synced, no restart): `url`, `contextSize`,
  `maxOutputTokens`, `toolCalling`, `vision`.

**Commands:**

```text
mba models                          # pick a model (menu) / list
mba config <model>                  # show all dials + current values
mba set <model> <field> <value>     # edit one dial (validated)
mba set <model> <field> <value> --yes   # + auto-reboot if required
mba open <model> [server_setup|yaml]    # print file path (escape hatch)
mba help
```

## Known Constraints

- **v1 is view + edit only.** No model create/delete (v2 — touches catalog,
  lineage tree, and watcher).
- **The live service must be running and current.** The CLI is a pure client:
  if the service is down, every command fails with a discovery hint. A service
  process started before the `GET /models/config` route was added returns 404
  for `mba config` / `mba set` until it is restarted.
- **`npm link` staleness.** The global `mba` points at `dist/cli/mba.js`.
  After changing CLI code: `npm run build && npm link` (in `packages/core`).
- **The CLI never restarts a model silently.** Reboot only happens on an
  explicit y (or `--yes`). MCP tool and `curl` callers get the
  `restartRequired` report but no reboot — the decision stays with the human
  at the terminal.
- **`gpuLayers` is capped at the profile's `blockCount`** — the service
  rejects values above it (the profile is the immutable source of truth for
  how many layers the GPU can hold).
- **No fzf.** The menu is a readline raw-mode implementation; it supports
  arrow keys + type-to-filter but not fzf's full fuzzy ranking or preview
  panes.
