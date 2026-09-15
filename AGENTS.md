# AGENTS.md

Instructions for AI agents contributing to this codebase. Humans start at
[README.md](README.md) and [CONTRIBUTING.md](CONTRIBUTING.md). Decisions live
in [`docs/adr/`](docs/adr/). Do not treat this file as a product roadmap.

---

## Project overview

MBA is a local-first, per-model behavior layer for models that run on your
machine. It is not a host (Ollama), an inference engine (llama.cpp), or a
harness (Cursor, Cline). It gathers this model’s assets into its model hub,
builds a profile, and loads that profile at inference. You configure which
behaviors to watch and how the system responds when they show up.

```text
configure adapter → BCB (system watch) → AMPI (system live response)
```

The daemon is the proxy. `mba` is a thin door over that daemon. The MCP
server is a thin stdio client over the same daemon. Nothing else writes the
house.

## Language and toolchain

- TypeScript, Node ≥ 22, ESM (`"type": "module"`).
- npm workspaces (`packages/*`). Root `package.json` is `"private": true`.
- Vitest for tests. `tsc --noEmit` for typecheck.
- Merge gate: `npm run typecheck && npm test && npm run build` ([`docs/ci.md`](docs/ci.md)).

## Architecture

```
packages/core          @mba-ai/core. Framework, daemon, BCB, AMPI, CM, mba CLI.
packages/mcp-server    @mba-ai/mcp-server. Stdio MCP client. No file writes of
                       its own. Service-backed tools HTTP to the daemon.
docs/adr/              Architecture decision records. Do not quietly reverse one.
docs/ampi.md           AMPI charter: what is live vs named.
docs/workflows/        How to change a surface (CLI: service payload, then print).
```

Source in `packages/core/src/`:

- `service/` — Daemon. `main.ts` boots it. `server.ts` is the Hono app.
  `model-proxy.ts` forwards OpenAI-compatible chat. `intervention.ts` is the
  guard on that path (TCB → escalate → maybe AMPI). `paths.ts` is OS-aware
  store/state. Catalog, sessions, boot, watches, machine overlay live here.
- `mba/` — Adapter lineage, merge, resolve, envelopes, llama.cpp flags,
  slot save/restore/erase, staging `instructions.md`.
- `bcb/` — Tool circuit breakers. `tool-circuit-breaker.ts` runs rules.
  `escalate.ts` is the ladder. `rules/` is the detectors (`read-clamp`,
  `eof-overflow`, `repeat-run`, …).
- `ampi/` — Named recipes that finish. `engine.ts` runs them.
  `parse-recipe.ts` parses ladder strings. `registry.ts` is the built-in
  map. `recipes/` today: `sanitize` and alias `sweep-duplicates`.
- `cm/` — Context Management. The only splice of `messages[]`. Closed cuts:
  `replace`, `insert`, `set-mark`, `sweep`, `compact`. `engine.ts` is the
  door. AMPI asks CM; it does not splice itself.
- `cli/` — `mba`. Thin HTTP client of the daemon. See
  [`docs/workflows/cli-development.md`](docs/workflows/cli-development.md).
- `model/` — GGUF scan/pull/id, draft adapter, family suggest.
- `chat-message.ts` — Shared `ChatMessage` view for BCB / AMPI / CM.

`packages/mcp-server/src/`: `server.ts` registers tools.
`service-client.ts` talks to the daemon. Offline tools
(`mba_file_metadata`, `mba_model_registry`) do not need the service.

## Data flow

**Chat (live path)**

1. Harness sends an OpenAI-compatible request to the MBA daemon.
2. `model-proxy.ts` authorizes the session token (`sessions.ts`).
3. `intervene()` parses the body, fingerprints the harness, builds line-count
   context, runs TCB rules, then the escalation ladder.
4. Ladder `action: ampi` → `parseAmpiRecipe` → `runAmpi`. The recipe asks CM
   for a closed cut. CM returns a new `messages[]`. AMPI does not splice.
5. If AMPI actually mopped (drop/rewrite), the proxy erases the live
   llama.cpp slot once the port is known, then forwards. Marks-only (pin)
   does not erase. Ollama has no slots.
6. Bytes to the upstream (registry by `request.model`, else `MBA_UPSTREAM_URL`
   if the registry is empty). Response is piped through.

**Operator (mba)**

1. `mba` parses argv (`cli/route.ts`) and calls the service (`GET` / `POST`).
2. The daemon reads/writes the adapter tree and state dir.
3. Exceptions that do not need the daemon: `mba start` / `mba stop` /
   `mba restart`, `--help`, `completion`, `estimate-memory`. `mba migrate`
   scans local GGUFs; the hub write is still `POST /models/adopt`.

**MCP**

Service-backed tools are HTTP wrappers. The daemon is the only file writer.

## Conventions

- Daemon owns state. `mba` does not patch adapter JSONL/YAML. MCP does not
  either.
- Escalation YAML names AMPI recipes only. Never a CM cut (`context-gc` is
  retired). Never an SM state.
- CM is the only splice of `messages[]`. Do not edit chat in the proxy,
  a recipe, or the CLI.
- AMPI always finishes (progress measure + `maxTurns`). Bound/held limits
  are not AMPI. What ships is [`docs/ampi.md`](docs/ampi.md), not a
  four-item menu.
- Commands take a **model id** (left column of `mba models list`).
- CLI: service payload first, then TTY print. TTY and `--json` are two skins
  of the same route. JSON field names are the contract. No Ink, Commander,
  or fzf. One paint kit: `cli/style.ts`.
- Tests live next to the code (`*.test.ts`). Do not snapshot whole TTY dumps.
- Empty house `tcb.jsonl` means inherit, not off (ADR-0108).

## Adding a CLI verb

Follow [`docs/workflows/cli-development.md`](docs/workflows/cli-development.md):

1. Add the fact to the service payload first. Do not scrape files from `mba`.
2. Route in `cli/route.ts`, dispatch in `cli/mba.ts`, help in `cli/help.ts`.
3. Print with `cli/style.ts`. Interactive prompts use `cli/interactive.ts`.
4. Test parse/route. Fake stdin for pickers. Then
   `npm run build -w @mba-ai/core`.

## Adding a watch / TCB rule

1. Detector in `bcb/rules/`. Wire it through `tool-circuit-breaker.ts`.
2. Per-model on/off/inherit is a daemon door (`model-watches.ts`), not a
   CLI file edit. Known watches v1 are the three `read_file` watches
   (ADR-0108). Do not grow a general rule IDE in the same cut.
3. If the response is a mop, the ladder names an AMPI recipe; the recipe
   asks CM. Do not splice in the rule.

## Adding an AMPI recipe

1. Read [`docs/ampi.md`](docs/ampi.md) first. Sanitize is the live job.
   Assist / Sanction / Recover are names, not a build queue.
2. Recipe in `ampi/recipes/`, register in `ampi/registry.ts`. The name on
   the ladder is AMPI, never a CM cut.
3. The body asks `cm/engine.ts` (`replace` / `insert` / `set-mark` /
   `sweep` / `compact`). A new *kind* of CM target is an MBA change.
4. Do not re-open a file the harness refused. Do not add an MBA file
   allowlist.

## Adding a CM cut

Closed enum in `cm/types.ts` + a function + `applyCm` in `cm/engine.ts`.
Do not merge Sweep into Compact. Do not merge Mark into Sweep. Write stays
`replace` vs `insert`.

## Testing

```sh
npm test                         # vitest run (workspace)
npx vitest run packages/core/src/service/intervention.test.ts
```

A bug fix should fail before the change and pass after. CLI: route/parse
always; printers as small units.

## Dependencies policy

- Hono is the daemon HTTP stack. Do not add Express.
- MCP SDK stays in `@mba-ai/mcp-server`, not in core.
- Do not add Ink, Commander, fzf, blessed, or a second TTY renderer.
- Prefer the OS-aware paths in `service/paths.ts` over new env vars.
- Do not add a second HTTP client in mcp-server; reuse `service-client.ts`.

## Common tasks

```sh
npm install
npm run typecheck && npm test && npm run build
mba start                 # or: npm run mba -- start
mba restart               # after a service-path rebuild
mba status
npm run build -w @mba-ai/core    # after CLI changes; then npm link in packages/core
```

## Do not

- Do not implement Assist, Sanction, or Recover because the handbook names
  them. Do not add an MBA file allowlist.
- Do not add a new plane, runner, or public CLI verb because an existing
  door is slightly inconvenient.
- Do not bump `@mba-ai/*` or rewrite a shipped changelog unless this change
  **is** the release. See [`docs/ci.md`](docs/ci.md).
- Do not mix unrelated surfaces in one PR. Features start with an issue.

## Pointers

| Need | Where |
| --- | --- |
| Operator hour | [README.md](README.md) |
| How to send a change | [CONTRIBUTING.md](CONTRIBUTING.md) |
| CLI change | [`docs/workflows/cli-development.md`](docs/workflows/cli-development.md) |
| AMPI | [`docs/ampi.md`](docs/ampi.md) |
| Merge gate | [`docs/ci.md`](docs/ci.md) |
| Open a PR | [`skills/open-pr/SKILL.md`](skills/open-pr/SKILL.md) |
| Release `@mba-ai/core` | [`skills/release-core/SKILL.md`](skills/release-core/SKILL.md) |
| Decisions | [`docs/adr/`](docs/adr/) |
