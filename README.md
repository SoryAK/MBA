# MBA — Model Behavioral Adapter

![WIP](https://img.shields.io/badge/status-work%20in%20progress-orange?style=for-the-badge)

> **Work in progress** — the concept is still actively developing. APIs, package layout, and config formats may change without notice.

MBA is a framework for giving local LLMs **per-model behavioral profiles**: each model gets its own adapter (context budget, tool-circuit-breaker rules, server setup) resolved from a lineage tree of YAML files, and a real-time engine enforces the behavioral rules on tool calls.

It ships as two npm packages under the `@mba-ai` scope:

| Package | What it is |
| --- | --- |
| [`@mba-ai/core`](packages/core) | The framework: adapter resolution (B1–B4), the BCB/TCB tool-circuit-breaker engine, and the global MBA config service |
| [`@mba-ai/mcp-server`](packages/mcp-server) | The MCP control plane: read and tune the global config from any MCP host (VS Code Copilot, Cline, Claude Desktop) |

## How it works

- **Adapters** are YAML files in a lineage folder tree (e.g. `vendor/family/model.yaml`). The resolver scores and merges them least-specific-first into a single resolved config per model.
- **TCB (Tool Circuit Breaker)** is a real-time watchdog over the model's tool calls. Rules are notice-only detectors with an escalation ladder (nudge → mask → kill). Rule classes bundle detectors; state persists in SQLite.
- **The global service** owns the resolved config and rule state on one machine. It binds `127.0.0.1` on an OS-assigned port and writes a discovery file (`~/.mba/mba/service.json`) so consumers can find it.
- **The MCP server** is a thin client over that service — it has zero dependency on the framework, so it can run in any MCP host.

## Install

```sh
npm install @mba-ai/core
```

## Run the global service

```sh
npx @mba-ai/core
# or, from a checkout:
npm run start:service
```

The service binds `127.0.0.1:<port>` and writes a discovery file
(`<state dir>/mba/service.json`) so consumers can find it.
Env: `MBA_BASE_DIR` (state dir override) and `MBA_ADAPTER_DIR` (model store
override). Both default to OS-aware locations (XDG dirs on Linux,
`%APPDATA%`/`%LOCALAPPDATA%` on Windows, `~/Library/Application Support` on
macOS — see `packages/core/src/service/paths.ts`).

Upgrading from a pre-0.1.1 install? Run `mba migrate-paths` once — it moves
your legacy `~/.mba` state and `~/models/adapters` store to the OS-aware
locations (local-only, works with the service stopped, never overwrites).

## Model onboarding

```sh
mba pull <url|owner/repo[:file-or-quant]> --id <id> [--sha256 <digest>] [--family <family>]
```

One-command onboarding (ADR-0098): downloads a GGUF (resume + sha256
verify), parses its header into a profile, and scaffolds the two-tier
adapter binding (family + adapter) with a TODO-marked draft adapter.

For HuggingFace repos the digest is auto-resolved from the repo's published
LFS metadata (ADR-0099) — no hash hunting:

```sh
mba pull rico03/Qwen3.8-27B-...-GGUF:Q4_K_M --id qwen3.8-27b-opus-distill
```

`--sha256` stays available as an override (and is still required for
non-HuggingFace sources).

## MCP control plane

Point any MCP host at the server:

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

Tools exposed: `mba_file_metadata`, `mba_model_registry`, `mba_resolve_config`, `mba_set_rules`, `mba_server_status`.

## Development

```sh
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest run (all packages)
npm run build       # emit dist/ for both packages
```

Requires Node ≥ 20.

## Documentation

- [`.Manual/model-behavioral-adapters.md`](.Manual/model-behavioral-adapters.md) — the full system manual
- [`docs/adr/`](docs/adr/) — architecture decision records (0084–0098)

## License

[MIT](LICENSE) © 2026 SoryAK
