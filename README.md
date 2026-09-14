# MBA

[![CI](https://img.shields.io/github/actions/workflow/status/SoryAK/MBA/ci.yml?branch=main&label=CI)](https://github.com/SoryAK/MBA/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@mba-ai/core?label=npm)](https://www.npmjs.com/package/@mba-ai/core)
[![release](https://img.shields.io/github/v/release/SoryAK/MBA?label=release)](https://github.com/SoryAK/MBA/releases)
[![license](https://img.shields.io/github/license/SoryAK/MBA)](LICENSE)
[![stars](https://img.shields.io/github/stars/SoryAK/MBA)](https://github.com/SoryAK/MBA/stargazers)
[![downloads](https://img.shields.io/npm/dm/@mba-ai/core?label=downloads)](https://www.npmjs.com/package/@mba-ai/core)

**MBA** is a local-first, per-model behavior layer for models that run on your machine. It is not a host (Ollama), an inference engine (llama.cpp), or a harness (Cursor, Cline). It gathers this model’s assets into its model hub, builds a profile, and loads that profile at inference. You configure which behaviors to watch and how the system responds when they show up.

```text
configure adapter → BCB (system watch) → AMPI (system live response)
```

We are looking for **contributors and collaborators**. Issues, PRs, and design discussion are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

Node ≥ 22. llama.cpp on `PATH` if you boot the inference server today.

## Install

Two things: the **daemon** (owns the store, the boot, the watch) and `mba` (the remote). If the daemon is down, `mba` will say so.

```sh
npm install
mba start                 # from a checkout: npm run mba -- start
mba status

mba                  # home menu on a TTY (after the CLI is on your PATH)
```

`mba start` runs the daemon in the background (systemd --user on Linux). `mba stop` stops it. A second `mba start` prints the URL already in use. `--foreground` is this terminal, if you want the logs.

The service binds `127.0.0.1` on an OS-assigned port and writes `<state dir>/mba/service.json`. The CLI finds it there, or via `MBA_SERVICE_URL`.

## Migrating Models

If  you already have pre-downloaded models, migrate them into the hub:

```sh
mba migrate models ~/models #copies (or hardlinks) models and scaffolds the needed files into the model hub 
```

## Pulling Models

Pull a GGUF into the hub and scaffold the house:

```sh
mba models pull owner/repo:Q4_K_M --id qwen3.8-27b
```

HuggingFace search is the same path without a URL:

```sh
mba models search
```

`mba models pull` downloads a GGUF and scaffolds the house. A failed verify leaves nothing.

## Booting and Connecting

Boot this model. Then attach a client.

```sh
mba s boot qwen3.8-27b
mba connect qwen3.8-27b --harness cursor
mba status
```

Boot starts this model’s inference server with no client attached. Connect attaches one. After that, chat goes through MBA.

## CLI

`mba --help` and `mba <group> --help` are the command list. The TTY home menu is `mba`.

```sh
mba models               # pick and edit dials
mba models list          # id · family; commands take the id
mba models watch <id>
mba s logs <id>
mba machine              # enforce | warn | off
```

`m` / `s` are shortcuts. `--yes` skips confirm. `--json` on list / show / status.

## Env


| Variable          | Role                                 |
| ----------------- | ------------------------------------ |
| `MBA_SERVICE_URL` | Service URL if discovery is not used |
| `MBA_BASE_DIR`    | Store / state base override          |
| `MBA_ADAPTER_DIR` | Adapter tree (model store)           |
| `MBA_SWITCH_PORT` | Default boot port (8080)             |


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


| Package                                     | Role                                      |
| ------------------------------------------- | ----------------------------------------- |
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
- [System manual](.Manual/model-behavioral-adapters.md)
- [AMPI](docs/ampi.md) — live-response subsystem
- [CI](docs/ci.md) — merge gate (GitHub Actions)
- [Releases](https://github.com/SoryAK/MBA/releases) — what shipped (`@mba-ai/core` changelog)
- [ADRs](docs/adr/) — architecture decision records
- [SECURITY.md](SECURITY.md) — report a vulnerability privately

## License

[Apache-2.0](LICENSE) © 2026 SoryAK
