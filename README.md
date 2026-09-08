# MBA

![WIP](https://img.shields.io/badge/status-work%20in%20progress-orange?style=for-the-badge)
[![npm](https://img.shields.io/npm/v/@mba-ai/core.svg?style=for-the-badge)](https://www.npmjs.com/package/@mba-ai/core)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge)](LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=for-the-badge)](https://github.com/SoryAK/MBA/pulls)

**MBA (Model Behavioral Adapter)** is a local-first system daemon focused on individual model behavior. It is not a model host (Ollama) and not a client (Cline). It is the per-model behavior layer and control plan on your machine.

Work in progress. APIs and file formats may still move.

```text
configure adapter → BCB (system watch) → AMPI (system live response)
```

## Why per model

A model’s behavior can derive from several factors:

- **Training** — what it saw, and what it was taught to do (chat, code, tools, long reasoning)
- **Scale and architecture** — how much it can hold, and whether it is dense or routed
- **Packing** — quantization and format; how much of that training still appears at runtime
- **Environment and hardware** — client, IDE, and inference server, on this machine’s RAM, VRAM, and CPU. The same weights do not behave the same under Copilot on a 24 GB box and a raw endpoint on an 8 GB box
- **Task and objective** — what this run is trying to get done, and what the model was optimized for. A coder pass and a short chat are not the same run
- **Runtime config** — context, GPU layers, cache, samplers, grammar, tool limits. These are chosen for this model, not inherited from the last one that booted

Training, scale, and packing live in the weights. Environment, hardware, task, objective, and runtime config sit around them. The behavior you get is the whole set.

Most stacks attach the last of those to the fleet — one endpoint, one context number, one tool policy. MBA attaches the whole set to **this** model.

MBA consolidates those factors into a **model behavioral adapter** — the configuration that belongs to this model. It is managed in one place, loaded before boot, and applied at runtime.

## BCB and AMPI

**BCB** (behavioral circuit breakers) is the monitoring system. You name the known failure modes to watch on this model, then configure an escalation ladder and a programmatic automated response. The ladder notices when a known bad behavior appears, and can clamp or hint *ahead of time*.

**AMPI** (automated multi-process intervention) is that response when a breaker fires. It is not another model deciding what to do. It is a programmatic, configurable, deterministic named recipe: it runs, owns the next turn or turns, and finishes.

Its main focus is four functions:

- **Sanitize** — mop the context window. Dirt from a trip or a closed chapter. Stay on this thread. No new truth.
- **Assist** — help when the model is struggling. Give what is missing, or steer onto a better next step. Not a penalty. Not a rewind.
- **Sanction** — punish or prevent. Consequence after bad behavior (privilege gone, hard residue, no handoff). Ladder mask/kill can stay the cheap form; AMPI Sanction is the consequence.
- **Recover** — undo or reset. The stretch itself is bad: roll back to a pin, or reset the chapter. Not mopping while you continue (Sanitize). Not helping forward (Assist). Not punishing (Sanction).

## Run

Node ≥ 20. llama.cpp on `PATH` if you boot with `mba servers boot`.

```sh
npm install
npm run start:service
```

The service binds `127.0.0.1` on an OS-assigned port and writes `<state dir>/mba/service.json`. The CLI finds it there, or via `MBA_SERVICE_URL`.

```sh
npm run mba -- status
mba                  # home menu on a TTY (after the CLI is on your PATH)
```

## Onboarding

```sh
mba models pull owner/repo:Q4_K_M --id qwen
# download + sha256 verify → GGUF metadata / profile → family + adapter scaffold

mba s boot qwen              # port optional (MBA_SWITCH_PORT, default 8080)
# resolve adapter + server_setup (+ machine clamp) → flag preview → boot

mba status
```

`mba models pull` downloads the GGUF (resume + sha256). HuggingFace repos take the digest from LFS metadata; other sources need `--sha256`. After verify it parses the header locally, writes a TODO-marked adapter (and a family tier if that family is new), empty BCB/TCB/`server_setup` bindings, and TODO `instructions.md` (the model reads this later) plus `notes.md` (you read this; never injected). A failed verify deletes the partial and leaves no scaffold.

`mba s boot` resolves that adapter tree into llama.cpp flags — the same chain as the preview — then boots. `mba models search` is the interactive HuggingFace path into the same pull.

## CLI

`mba --help` and `mba <group> --help` are the command list.

```sh
mba models               # pick and edit dials
mba models show qwen
mba servers              # list / boot / stop (TTY)
mba s logs <id>
mba machine              # enforce | warn | off
mba estimate-memory <gguf>
eval "$(mba completion)" # bash; or: mba completion zsh
```

`mba server` = `mba servers`. `m` / `s` are shortcuts. `--yes` skips confirm (never auto-restarts). `--json` on list / show / status.

## Env

| Variable | Role |
| --- | --- |
| `MBA_SERVICE_URL` | Service URL if discovery is not used |
| `MBA_BASE_DIR` | Store / state base override |
| `MBA_ADAPTER_DIR` | Adapter tree (model store) |
| `MBA_SWITCH_PORT` | Default boot port (8080) |

Defaults are OS-aware: XDG on Linux, `%APPDATA%` / `%LOCALAPPDATA%` on Windows, `~/Library/Application Support` on macOS.

Upgrading from a pre-0.1.1 install: `mba migrate-paths` once (local, never overwrites).

## MCP

The service must already be running.

```json
{
  "mcpServers": {
    "mba": {
      "command": "npx",
      "args": ["-y", "@mba-ai/mcp-server"]
    }
  }
}
```

## Packages

| Package | Role |
| --- | --- |
| [`@mba-ai/core`](packages/core) | Framework, BCB engine, service, `mba` CLI |
| [`@mba-ai/mcp-server`](packages/mcp-server) | MCP client over that service |

```sh
npm install @mba-ai/core    # embed the library; not how you run the operator CLI
```

## Develop

```sh
npm install
npm run typecheck
npm test
npm run build
```

After CLI changes, rebuild `@mba-ai/core` so a linked `mba` picks them up (`npm run build -w @mba-ai/core`, then `npm link` in `packages/core`).

## Docs

- [`.Manual/model-behavioral-adapters.md`](.Manual/model-behavioral-adapters.md) — system manual
- [`docs/adr/`](docs/adr/) — architecture decision records

## License

[MIT](LICENSE) © 2026 SoryAK
