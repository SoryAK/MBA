# @mba-ai/mcp-server

The MCP (Model Context Protocol) control plane for the Model Behavioral
Adapter (MBA) system. It lets any MCP host (VS Code Copilot, Cline, Claude
Desktop) read and tune the global MBA config.

## What it does

The server is a **thin client** over the global MBA service — it has zero
dependency on the framework. It loads the adapter registry from a
`.MBA/adapters/` directory and, for the service-backed tools, talks to the
running global service (discovered via `<state dir>/mba/service.json`).

Tools:

- `mba_file_metadata` — probe a workspace file and return metadata including
  total line count, so models can choose valid `read_file` ranges instead of
  guessing.
- `mba_model_registry` — list the models in the adapter registry (light
  metadata: id, name, family, model file, bindings).
- `mba_resolve_config` — return the resolved config for a model (or the
  default) from the global service.
- `mba_set_rules` — set the TCB rule state (enabled/disabled + rule classes)
  on the global service.
- `mba_server_status` — report whether the global service is reachable and
  its version.

The service-backed tools **fail soft**: if the service is not running, they
return a structured error rather than crashing the host.

## Installation

```bash
npm install @mba-ai/mcp-server
```

## Running

Stdio transport (for VS Code / Copilot):

```bash
npx -y @mba-ai/mcp-server
```

## Environment variables

|Variable|Description|Default|
|---|---|---|
|`MBA_DIR`|Directory containing `.MBA/adapters/`|`./.MBA`|
|`MBA_WORKSPACE_ROOT`|Workspace root for file path scoping|`process.cwd()`|
|`MBA_SERVICE_URL`|Explicit service base URL (skips discovery)|—|
|`MBA_BASE_DIR`|Base dir for service discovery file|OS-aware (see `@mba-ai/core` `src/service/paths.ts`)|

## Example tool call

```json
{
  "name": "mba_resolve_config",
  "arguments": {
    "model": "qwen3-coder"
  }
}
```

## VS Code configuration

Add to your VS Code `settings.json`:

```json
{
  "mcp.servers": {
    "mba": {
      "command": "npx",
      "args": ["-y", "@mba-ai/mcp-server"],
      "env": {
        "MBA_DIR": "/absolute/path/to/.MBA",
        "MBA_WORKSPACE_ROOT": "/absolute/path/to/workspace"
      }
    }
  }
}
```

## Security

`mba_file_metadata` is workspace-scoped. Paths outside `MBA_WORKSPACE_ROOT` are
rejected. The service-backed tools only reach `127.0.0.1`. The server runs with
the permissions of the process that launches it.

## Related

See [ADR-0085](../../docs/adr/0085-mba-as-mcp-server.md) and
[ADR-0092](../../docs/adr/0092-mba-standalone-framework.md) for the design.
