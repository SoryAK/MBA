# @mba-ai/core

The MBA framework, local daemon, and `mba` CLI.

**MBA** is the per-model behavior layer on your machine. It is not a host (Ollama) and not a client (Cline). This package is that system: adapter resolution, the BCB engine, the service that owns state on this machine, and the CLI that talks to it.

The companion [`@mba-ai/mcp-server`](../mcp-server) is a thin MCP client over the service.

The beginning process (install → migrate or pull → boot → connect) lives in the [repo README](../../README.md). AMPI lives in [docs/ampi.md](../../docs/ampi.md).

We are looking for **contributors and collaborators**. See [CONTRIBUTING.md](../../CONTRIBUTING.md).

```text
configure adapter → BCB (system watch) → AMPI (system live response)
```

## What this package is

- **Adapters** — per-model configuration, resolved from the lineage tree, loaded before boot and applied at runtime.
- **BCB** — behavioral circuit breakers. You name known failure modes on this model and configure an escalation ladder plus a programmatic response.
- **AMPI** — automated multi-process intervention. A named recipe that runs when a breaker fires and always finishes. See [docs/ampi.md](../../docs/ampi.md).
- **Service** — binds `127.0.0.1` on an OS-assigned port and writes `<state dir>/mba/service.json`.
- **CLI** — `mba` (`start`, `stop`, `restart`, `models`, `servers`, `clients`, `migrate`, `machine`, `status`). `mba start` runs the daemon in the background; `mba stop` stops it; `mba restart` is stop then start; every other verb talks to it. Known watches: `mba models watch`.

## Install (library)

```sh
npm install @mba-ai/core
```

That embeds the framework. It does not start the daemon.

## Beginning process

From a checkout of this repo (Node ≥ 22):

```sh
npm install
mba start                 # from a checkout: npm run mba -- start
mba status
```

`mba start` runs the daemon in the background (systemd --user on Linux). `mba stop` stops it. `mba restart` is stop then start (picks up a rebuild). `--foreground` is this terminal. `npm start` in this package is the same verb; `npm run dev` is `--foreground`.

Models you already have:

```sh
mba migrate models ~/models
```

No weights yet:

```sh
mba models pull owner/repo:Q4_K_M --id qwen3.8-27b
# or: mba models search
```

The hour — boot the inference server, then attach a client:

```sh
mba s boot qwen3.8-27b
mba connect qwen3.8-27b --harness cursor
mba status
```

Boot starts the **model inference server** with **this** model’s dials only. Today that server is llama.cpp (on `PATH`). More inference servers are coming; MBA is not locked to one.

`npx @mba-ai/core` and the `mba` bin run the **CLI**. After a build, `npm link` in this directory puts `mba` on your PATH.

```sh
mba --help
```

## Environment

| Variable | Role |
| --- | --- |
| `MBA_SERVICE_URL` | Service URL if discovery is not used |
| `MBA_BASE_DIR` | Store / state base override |
| `MBA_ADAPTER_DIR` | Adapter tree (model store) |
| `MBA_SWITCH_PORT` | Default boot port (8080) |
| `MBA_UPSTREAM_URL` | Fallback upstream when the registry is empty |

Defaults are OS-aware (see `src/service/paths.ts`).

## Develop

```sh
npm install
npm run typecheck
npm test
npm run build
```

After CLI changes, rebuild this package so a linked `mba` picks them up.

## Contributing

See [CONTRIBUTING.md](../../CONTRIBUTING.md). Conduct: [CODE_OF_CONDUCT.md](../../CODE_OF_CONDUCT.md). The operator walkthrough is the [repo README](../../README.md).

## Docs

- [Repo README](../../README.md) — install, migrate, pull, boot, connect
- [AMPI](../../docs/ampi.md) — live-response subsystem
- [Changelog](https://github.com/SoryAK/MBA/blob/main/packages/core/CHANGELOG.md) — user-facing notes per npm version
