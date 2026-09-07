# @mba-ai/mcp-server

The MCP control plane for MBA. Any MCP host (VS Code Copilot, Cline, Claude Desktop) can read and tune the daemon through this server.

**MBA (Model Behavioral Adapter)** is a local-first system daemon focused on individual model behavior. This package is not that daemon. It is a thin stdio client over [`@mba-ai/core`](../core): zero framework dependency, no file writes of its own.

The service must already be running for the service-backed tools. Discovery is `<state dir>/mba/service.json`, or `MBA_SERVICE_URL`.

The operator story lives in the [repo README](../../README.md).

## Tools

Offline (no service):

- `mba_file_metadata` — probe a workspace file (exists, line count, size). Does not return content.
- `mba_model_registry` — light list of adapters from `MBA_DIR/adapters` (default `./.MBA/adapters`).

Service-backed (fail soft if the daemon is down):

- `mba_server_status` — reachable or not, plus version
- `mba_resolve_config` — resolved config for a model
- `mba_set_rules` — enable/disable BCB rules and rule classes
- `mba_list_models` — adapter tree plus live loaded state
- `mba_set_model_config` — one dial on `server_setup` or `client` (never restarts)
- `mba_ensure_model` — ask the service to load a model. Off until the service is started with `MBA_MODEL_SWITCH=on`

## Install

```sh
npm install @mba-ai/mcp-server
```

## Run

```sh
npx -y @mba-ai/mcp-server
```

## Environment

| Variable | Role | Default |
| --- | --- | --- |
| `MBA_SERVICE_URL` | Service URL if discovery is not used | — |
| `MBA_BASE_DIR` | State dir for `mba/service.json` | OS-aware (see `@mba-ai/core`) |
| `MBA_DIR` | Root for the offline adapter list (`<MBA_DIR>/adapters`) | `./.MBA` |
| `MBA_WORKSPACE_ROOT` | Workspace root for `mba_file_metadata` | `process.cwd()` |

## Host config

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

VS Code `settings.json` uses `mcp.servers` with the same command. Set `MBA_WORKSPACE_ROOT` to the workspace if the host cwd is not the project. Set `MBA_DIR` only if the offline registry is not `./.MBA`.

## Example

```json
{
  "name": "mba_resolve_config",
  "arguments": {
    "model": "qwen3-coder"
  }
}
```

## Security

`mba_file_metadata` rejects paths outside `MBA_WORKSPACE_ROOT`. Service-backed tools only reach `127.0.0.1`. The server runs with the permissions of the process that launches it.

## Docs

- [Repo README](../../README.md)
- [`@mba-ai/core`](../core)
- [`docs/adr/`](../../docs/adr/)
