# MBA

[![npm](https://img.shields.io/npm/v/@mba-ai/core.svg?style=for-the-badge)](https://www.npmjs.com/package/@mba-ai/core)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg?style=for-the-badge)](LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=for-the-badge)](https://github.com/SoryAK/MBA/pulls)

**MBA** is the per-model behavior layer on your machine. It is not a host (Ollama) and not a client (Cline). You give a model a house: how it boots, who may talk to it, and what the system watches while it works.

```text
configure adapter → BCB (system watch) → AMPI (system live response)
```

We are looking for **contributors and collaborators**. Issues, PRs, and design discussion are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

Node ≥ 22. llama.cpp on `PATH` if you boot the inference server today.

## Install

Two things: the **daemon** (owns the store, the boot, the watch) and **`mba`** (the remote). If the daemon is down, `mba` will say so.

```sh
npm install
mba start                 # from a checkout: npm run mba -- start
mba status
```

`mba start` runs the daemon in the background (systemd --user on Linux). `mba stop` stops it. A second `mba start` prints the URL already in use. `--foreground` is this terminal, if you want the logs.

The service binds `127.0.0.1` on an OS-assigned port and writes `<state dir>/mba/service.json`. The CLI finds it there, or via `MBA_SERVICE_URL`.

```sh
mba                  # home menu on a TTY (after the CLI is on your PATH)
```

## Models you already have

If the GGUFs are on this machine, bring them into the hub:

```sh
mba migrate models ~/models
```

That copies (or hardlinks) them in and scaffolds the house. You are not downloading anything.

## No weights yet

Pull a GGUF into the hub and scaffold the house:

```sh
mba models pull owner/repo:Q4_K_M --id qwen3.8-27b
```

HuggingFace search is the same path without a URL:

```sh
mba models search
```

`mba models pull` downloads the GGUF (resume + sha256). HuggingFace repos take the digest from LFS metadata; other sources need `--sha256`. After verify it parses the header locally, writes a TODO-marked adapter (and a family tier if that family is new), empty BCB/TCB/`server_setup` bindings, and empty `instructions.md` (the model reads this later) plus `notes.md` (you read this; never injected). A failed verify deletes the partial and leaves no scaffold.

## The hour

Boot this model. Then attach a client.

```sh
mba s boot qwen3.8-27b
mba connect qwen3.8-27b --harness cursor
mba status
```

Boot starts the **model inference server** with **this** model’s dials only — no client attached yet. Today that server is llama.cpp. More inference servers are coming; MBA is not locked to one. Connect stages the card and mints a token. After that, chat goes through MBA.

You did not have to write a breaker file. `read_file` is already watched: overshoots get clamped, past-EOF gets a stop, a read-loop gets mopped. Empty `tcb.jsonl` in the house means inherit that, not “off.” `mba models list` is **id · family**; commands take the id (left). See it with `mba models watch qwen3.8-27b`. Change it with `mba models watch qwen3.8-27b loop off` (or `inherit` / `on`).

`mba models stage` copies a non-empty winning `instructions.md` into the file the harness already injects (`CLAUDE.local.md`, `.cursor/rules/mba.mdc`, …). The model id is in that card; the filename stays the harness slot. `mba connect` does that and mints a Bearer token; once any session exists, chat through the MBA proxy requires it. `notes.md` stays in the store.

## BCB and AMPI

**BCB** is the watch. **AMPI** is the live response when a breaker trips — a named recipe that runs and finishes. Sanitize (mop the window) is what actually runs on a loop today. The rest of AMPI is the charter, not a menu of products. The handbook is [AMPI](docs/ampi.md).

When AMPI steps in, it is always doing one of four jobs:

- **Sanitize** — mop the context window. Dirt from a trip or a closed chapter. Stay on this thread. No new truth.
- **Assist** — help when the model is struggling. Supply what’s missing. Not a penalty. Not a rewind.
- **Sanction** — punish or prevent. Consequence after bad behavior (privilege gone, hard residue, no handoff). Ladder mask/kill can stay the cheap form; AMPI Sanction is the consequence.
- **Recover** — undo or reset. The stretch itself is bad: roll back to a pin, or reset the chapter. Not mopping while you continue (Sanitize). Not helping forward (Assist). Not punishing (Sanction).

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

## CLI

`mba --help` and `mba <group> --help` are the command list.

```sh
mba models               # pick and edit dials
mba models list          # id · family; commands take the id
mba models watch qwen3.8-27b
mba models watch qwen3.8-27b loop off
mba models show qwen3.8-27b
mba models stage qwen3.8-27b --harness cursor
mba connect qwen3.8-27b --harness cursor
mba servers              # list / boot / stop (TTY)
mba s logs <id>
mba migrate models ~/models   # local GGUFs → hub (copy/hardlink)
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

## MCP

The service must already be running (`mba start`).

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

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Conduct: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Docs

- [CONTRIBUTING.md](CONTRIBUTING.md) — how to help
- [`.Manual/model-behavioral-adapters.md`](.Manual/model-behavioral-adapters.md) — system manual
- [`docs/ampi.md`](docs/ampi.md) — AMPI (live-response subsystem)
- [`docs/ci.md`](docs/ci.md) — merge gate (GitHub Actions)
- [`docs/adr/`](docs/adr/) — architecture decision records

## License

[Apache-2.0](LICENSE) © 2026 SoryAK
