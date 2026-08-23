# @mba-ai/core

The Model Behavioral Adapter (MBA) framework. It gives local LLMs
**per-model behavioral profiles** — each model gets its own adapter
(context budget, tool-circuit-breaker rules, server setup) resolved from a
lineage tree of YAML files — and a real-time engine that enforces those
behavioral rules on the model's tool calls.

## What it does

- **Adapter resolution (B1–B4).** Adapters are YAML files in a lineage
  folder tree (e.g. `vendor/family/model.yaml`). The resolver scores and
  merges them least-specific-first into a single resolved config per model.
- **TCB (Tool Circuit Breaker).** A real-time watchdog over the model's tool
  calls. Rules are notice-only detectors with an escalation ladder
  (nudge → mask → kill). Rule classes bundle detectors; state persists in
  SQLite.
- **The global service.** Owns the resolved config and rule state on one
  machine. It binds `127.0.0.1` on an OS-assigned port and writes a
  discovery file (`~/.mba/mba/service.json`) so consumers can find it.

The companion package [`@mba-ai/mcp-server`](../mcp-server) is a thin MCP
client over this service — it has zero dependency on the framework.

## Installation

```bash
npm install @mba-ai/core
```

## Running the global service

```bash
npx @mba-ai/core
# or, from a checkout:
npm run start:service
```

The service binds `127.0.0.1:<port>` and writes `~/.mba/mba/service.json`.

## Environment variables

|Variable|Description|Default|
|---|---|---|
|`MBA_BASE_DIR`|Store base dir (service discovery + SQLite state)|`~/.mba`|
|`MBA_ADAPTER_DIR`|Directory containing the adapter lineage tree|`~/models/adapters`|
|`MBA_UPSTREAM_URL`|Upstream model endpoint the service fronts|—|

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run build       # emit dist/
```

Requires Node ≥ 20.

## Related

See [ADR-0084](../../docs/adr/0084-model-behavioral-adapter-specification.md)
(specification), [ADR-0090](../../docs/adr/0090-adapter-lineage-tree.md)
(lineage tree), and
[ADR-0092](../../docs/adr/0092-mba-standalone-framework.md) (standalone
framework) for the design.
