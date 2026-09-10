# Workflow: CLI development

**Workflow Type:** `cli-development` — changing the `mba` command (TTY, JSON, or both)

**Stack Context:** TypeScript, `packages/core/src/cli/`, Vitest, no Ink/fzf/blessed

**Last Updated:** 2026-09-10

**Related:** [ADR-0096](../adr/0096-mba-config-cli.md) (CLI is a thin door over the service). Interactive prompt primitives: [add-interactive-cli-prompt.md](./add-interactive-cli-prompt.md). Whole-surface restyle is parked (`docs/backlog/parked-ideas.md`, CLI polish) — follow this file when that cut starts.

Industry notes (Claude Code architecture review + git/gh/kubectl): steal TTY-vs-JSON, one paint kit, fast `--help`, streaming with cancel, status as doctor. Do **not** adopt Ink, Commander, or a forked renderer. `mba` is a door, not a REPL product.

---

## What `mba` is

A **thin client** of the MBA daemon. It does not own adapter files, sessions, or llama-server. Reads and writes go through the service (`GET` / `POST`). Local exceptions (no daemon): `migrate-paths`, `estimate-memory`, `completion`, `--help`.

Nouns: `models` (`m`), `servers` (`s`), `clients` (`c`), `machine`, `status`. Old flat verbs stay as aliases.

TTY and `--json` are two skins of the same route. JSON field names are the contract. TTY labels can change in a polish; JSON must not.

---

## Layout

| File | Owns |
| --- | --- |
| `mba.ts` | argv → command; service URL; fail |
| `route.ts` | parse argv (`parseMbaArgv`) |
| `help.ts` | `--help` text |
| `client.ts` | `fail`, `serviceGet` / `servicePost`, `resolveServiceUrl` |
| `style.ts` | paint, `brand`, `kv`, `heading`, `shortenHome` |
| `interactive.ts` | raw-mode pickers and one-line prompts |
| `status.ts` / `clients.ts` / `models.ts` / `servers.ts` / `machine.ts` | one noun each |
| `slot-print.ts` | TTY grouping for paired sessions (status + clients) |
| `list-print.ts` | TTY rows for servers, models, registered clients |
| `harness-choices.ts` | built-in + operator envelopes for pickers |

Paint lives in `style.ts`. Do not add a second color kit. Honors `NO_COLOR` / `FORCE_COLOR` / TTY.

---

## Successful sequence (any CLI change)

1. **Decide TTY vs JSON vs both.** If the operator needs a new fact, add it to the service payload first, then print it. Do not scrape files from the CLI.
2. **Route.** New subcommand → `route.ts` + `mba.ts` switch + `help.ts`. Test `parseMbaArgv` in `route.test.ts`.
3. **Print with `style.ts`.** `brand("status")`, `kv`, `heading`, `dim`, `paint(..., BOLD)`. New chrome copies an existing screen; it does not invent one.
4. **Interactive?** Use `interactive.ts` (`pickLabeledInteractive`, `askValueInteractive`, …). New prompt kinds follow [add-interactive-cli-prompt.md](./add-interactive-cli-prompt.md).
5. **Tests.** Route/parse always. Interactive against a fake stdin. Display helpers (`formatClientLabel`, envelope paths) as unit tests — do not snapshot whole TTY dumps unless the polish cut says so.
6. **Build the binary the operator runs.** `mba` on PATH is `packages/core/dist/cli/mba.js` (`npm link`). The daemon is `tsx src/service/main.ts` and does not need this build.
   ```sh
   npm run build -w @mba-ai/core
   mba status
   ```

---

## Identity on screen (pairing)

Pairing is **many keys** (several models on one Cursor project). The envelope is **one playbook per (harness, project)**.

- Built-in filename is the slot the harness already injects (`.cursor/rules/mba.mdc`, `CLAUDE.local.md`, …). Model id lives **inside** the card (`<!-- mba-model: … -->`), not in the filename.
- TTY names **the app** and **the file**, then lists models under that slot: `card` (this model owns the playbook) vs `pair` (token only). Kind is `ide` or `cli` (`harnessKind`). A non-default ide prints as `· cursor` on the header, not `copilot+cursor`.
- `formatClientLabel` is the short harness tag (`cursor`, not `cursor+cursor`). Do not use it as the only identity on status/clients — it hid the file.
- JSON keeps `harness`, `ide`, `card`, `projectRoot`. `envelope` is additive on `GET /status` sessions. Do not rename those fields.

Shipped on status + `mba clients` list (`formatPairedSlotLines`):

```text
  clients
    cursor  ide   .cursor/rules/mba.mdc
      deepseek_test           card   ~/Dev_Projects/MBA
      nomic-embed-text-v1.5   pair   ~/Dev_Projects/MBA
```

Still parked (CLI polish card): picker chrome (`interactive.ts` / `previewBox`). Same paint kit — do not invent a second look.

## Cuts

1. **Done.** Status / clients group by harness + kind + envelope. Service adds `envelope` on each session.
2. **Done.** Compact boot preview: one header (model, port, GPU), dense dials, hide usual `--jinja` / kv q8_0, one `BOOTED` line. Process unchanged.
3. **Done.** Remaining list/show/help screens share that vocabulary: `mba models` / `show`, `mba servers`, registered clients, connect slot line, compact `mba servers --help`, one `PULLED` line. Pickers unchanged.
4. **Done.** Boot is bare (`env not set`). Pairing does not pick an overlay. `BOOTED` next is `mba connect <id>` (restart still points at logs). JSON adds `envAttached: false`; `env.harness` is `none`.

---

## First-attempt failures

- **Stale `mba status` after a merge.** PATH still has yesterday’s `dist`. Rebuild `@mba-ai/core`. Confirm with `which mba` → `…/packages/core` via npm link.
- **Typecheck `Cannot find name 'fail'` / `serviceGet`.** Command files must import from `./client.js`. Dropping that import while adding a display helper fails CI (`tsc --noEmit` in the test job).
- **CodeQL ReDoS / bad HTML-filter regexp** on envelope markers. Parse `mba-model` / file stems with string walks (`envelope.ts`), not `[-.]+` or `-->` regexes. Same rule as `version.ts`.
- **Interactive menu does nothing.** `mba` is `dist/`, not `tsx`. Rebuild. See [add-interactive-cli-prompt.md](./add-interactive-cli-prompt.md).
- **Daemon on a new port, CLI talking to the old one.** `resolveServiceUrl` reads the discovery file the service just wrote. After `systemctl --user restart mba.service`, run `mba status` again — do not export a stale `MBA_SERVICE_URL`.

---

## Gotchas

- **Service vs CLI rebuild.** systemd unit runs `tsx …/src/service/main.ts` (source). Operator `mba` is `dist`. Rebuild CLI after UI changes; restart the unit after service-path changes.
- **Raw mode.** Restore `setRawMode(false)` in `finally`. Interactive only when `process.stdin.isTTY`.
- **`--json` stability.** Scripts and tests key on field names. A polish may regroup TTY rows; it must not rename JSON. Additive fields (`envAttached`) are ok; `env.harness` values may change when the product does (`none` on boot).
- **Boot then connect.** Boot never applies `environments/` from a leftover pairing or the Copilot default. Family + model dials only. `mba connect` attaches the client (card + token). Env overlays still apply when a caller passes an explicit harness (stage, proxy, `resolve-server-recipe --harness`).
- **No second writer.** Staging, connect, revoke, ensure, boot flags — service owns the write. CLI prints the result.
- **Envelope extras.** Operator clients (`mba clients add`) are name + path. Do not scan `$PATH` for IDEs. Built-in slots stay the harness filenames; `{model}` is only for extras.
- **Help is part of the CLI.** If a flag or noun changes, `help.ts` changes in the same commit.

---

## Reference

- Door: `packages/core/src/cli/mba.ts`
- Paint: `packages/core/src/cli/style.ts`
- Pairing label helper: `packages/core/src/service/env-context.ts` (`formatClientLabel`, `defaultIdeForHarness`)
- Envelope slots: `packages/core/src/mba/envelope.ts`
- Product decision: ADR-0096
- Industry review: [lai3d/claude-code-architecture](https://github.com/lai3d/claude-code-architecture) — patterns above, not their UI stack
