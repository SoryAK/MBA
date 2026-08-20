# ADR 0085: MBA as MCP Server

## Status

Proposed

## Context

ADR-0084 introduced the Model Behavioral Adapter (MBA): a repo-root `.MBA/`
directory containing YAML adapter indexes, JSONL rule bindings, and JSON
structural configs. The proxy loads these files directly on every request and
applies them to grammar injection, circuit breakers, and streaming behavior.

This works, but it has limitations:

- **Proxy-locked:** Adapter logic only runs inside the c-yard proxy.
- **Static identity:** The proxy must discover model identity itself via
  upstream probes (`/cyard/dna`, `/v1/models`, `/props`).
- **No custom tools:** Adapters can only configure existing proxy behavior; they
  cannot expose new tools like `file_metadata`.
- **No environment attestation:** The consumer (Copilot, Cline, etc.) is
  inferred from the system prompt and user-agent, not asserted.

MCP (Model Context Protocol) is becoming the standard way for models to talk to
external tools and context providers. Hosting the MBA registry as an MCP server
would make adapters portable, verifiable, and extensible.

## Decision

We will design a standalone `c-yard-mba` MCP server that hosts the MBA registry
and exposes adapter-specific capabilities to any MCP consumer.

This is **Phase 1 of the design only**. The current file-based MBA remains the
production path while we prototype the MCP server.

## Proposed architecture

```text
┌─────────────────┐     MCP      ┌──────────────────┐
│  VS Code /      │ ◄──────────► │  c-yard-mba      │
│  Copilot /      │              │  MCP server      │
│  Cline          │              │                  │
└─────────────────┘              │  - loads .MBA/   │
                                 │  - resolves      │
┌─────────────────┐              │    adapters      │
│  c-yard proxy   │ ◄──────────► │  - verifies DNA  │
│                 │              │  - exposes tools │
└─────────────────┘              └──────────────────┘
                                        │
                                        ▼
                                ┌───────────────┐
                                │  Ollama / HF  │
                                │  DNA lookup   │
                                └───────────────┘
```

## Capabilities

### 1. Adapter registry

The MCP server loads `.MBA/adapters/` and exposes tools to query them:

- `mba_list_adapters` — list available adapters
- `mba_resolve_adapter` — resolve the best adapter for a context
- `mba_get_config` — return BCB/TCB/structural config for an adapter

### 2. Environment attestation

The consumer must identify itself. The server accepts:

- `harness` (copilot, cline, etc.)
- `ide` (vscode, cursor, etc.)
- `runtime` (llama.cpp, ollama, vllm)
- `runtimeVersion`
- `modelName`
- Optional `modelDna` {digest, quant, build}

The server uses this context to resolve the matching adapter using the same
specificity rules as ADR-0084.

### 3. DNA verification

The MCP server can optionally confirm model identity by querying:

- Ollama `/api/ps` or `/api/show`
- llama.cpp `/props`
- A future Hugging Face metadata endpoint

This makes the identity dimension authoritative instead of trusting the
consumer's claim.

### 4. Adapter-specific tools

Adapters can declare tools they want exposed. Example:

```yaml
bindings:
  tools: "./tools.json"
```

Where `tools.json` defines a `file_metadata` tool that reads workspace file
stats and returns `{totalLines, sizeBytes, exists}`.

The MCP server registers these tools under the adapter namespace so the model
can call them.

## Security considerations

- **Sandboxing:** Adapter tools run inside the MCP server process. A malicious
  adapter could read or delete files. We need a capability allowlist and
  workspace-root scoping.
- **Authentication:** Any MCP client can request any adapter. For local use this
  is fine; remote use would require auth.
- **Tool namespace collisions:** Adapter tools must be prefixed to avoid
  colliding with VS Code/Copilot built-in tools.

## Phased plan

1. **Phase 0 (now):** Keep file-based MBA as production. Commit adapter files.
2. **Phase 1:** Design and prototype `c-yard-mba` MCP server with read-only
   registry tools.
3. **Phase 2:** Add DNA verification via Ollama/llama.cpp probes.
4. **Phase 3:** Allow adapters to expose custom tools like `file_metadata`.
5. **Phase 4:** Migrate the c-yard proxy to consult the MCP server while
   retaining a file-based fallback for offline use.

## Consequences

### Pros

- Adapters become portable across MCP-compatible hosts.
- Model identity can be verified independently.
- Adapters can expose custom tools without changing the proxy.
- Single registry, multiple consumers (proxy, IDE extensions, CLI tools).

### Cons

- New standalone component with lifecycle and transport complexity.
- Adds process/network overhead per request in Phase 4.
- Requires a wire protocol between proxy and MBA server.
- Security surface increases because adapters can expose arbitrary tools.

## Related

- ADR-0084: Model Behavioral Adapter specification
- ADR-0083: Tool Circuit Breaker subsystem
- Open issue: read_file overshoots due to lack of preflight metadata
