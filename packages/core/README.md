# @mba-ai/core

The MBA framework, local daemon, and `mba` CLI.

**MBA (Model Behavioral Adapter)** is a local-first system daemon focused on individual model behavior. This package is that system: adapter resolution, the BCB engine, the service that owns state on this machine, and the CLI that talks to it.

It is not a model host and not a client. The companion [`@mba-ai/mcp-server`](../mcp-server) is a thin MCP client over the service.

The operator story (why per model, BCB, AMPI, onboarding) lives in the [repo README](../../README.md).

```text
configure adapter → BCB (system watch) → AMPI (system live response)
```

## What this package is

- **Adapters** — per-model configuration, resolved from the lineage tree, loaded before boot and applied at runtime.
- **BCB** — behavioral circuit breakers. You name known failure modes on this model and configure an escalation ladder plus a programmatic response.
- **AMPI** — automated multi-process intervention. A deterministic named recipe that runs when a breaker fires (Sanitize, Assist, Sanction, Recover).
- **Service** — binds `127.0.0.1` on an OS-assigned port and writes `<state dir>/mba/service.json`.
- **CLI** — `mba` (`models`, `servers`, `machine`, `status`). The published bin is the CLI, not the service.

## Install (library)

```sh
npm install @mba-ai/core
```

That embeds the framework. It does not start the daemon.

## Run the service

From a checkout of this repo:

```sh
npm install
npm run start:service
```

Or `npm run start` / `npm run dev` in this package. The CLI finds the service via discovery or `MBA_SERVICE_URL`.

`npx @mba-ai/core` and the `mba` bin run the **CLI**. After a build, `npm link` in this directory puts `mba` on your PATH.

```sh
mba --help
mba status
```

Node ≥ 22. llama.cpp on `PATH` if you boot with `mba servers boot`.

## Environment

| Variable | Role |
| --- | --- |
| `MBA_SERVICE_URL` | Service URL if discovery is not used |
| `MBA_BASE_DIR` | Store / state base override |
| `MBA_ADAPTER_DIR` | Adapter tree (model store) |
| `MBA_SWITCH_PORT` | Default boot port (8080) |
| `MBA_UPSTREAM_URL` | Fallback upstream when the registry is empty |

Defaults are OS-aware (see `src/service/paths.ts`). Upgrading from a pre-0.1.1 install: `mba migrate-paths` once (local, never overwrites).

## Develop

```sh
npm install
npm run typecheck
npm test
npm run build
```

After CLI changes, rebuild this package so a linked `mba` picks them up.

## Docs

- [Repo README](../../README.md) — operator pitch, run, onboarding, CLI
