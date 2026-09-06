# Changelog

User-facing changes to `@mba-ai/core` on npm. Versions before **0.1.12** are not listed.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.12] — 2026-09-05

### Added

- Daemon-as-proxy: TCP + Unix-socket front, registry-routed upstreams with TTL health checks, TCB/escalation on the request path (ADR-0101 Steps 1–2).
- Interactive boot: pre-boot flag preview (`POST /servers/resolve`) and post-boot log tail.
- HuggingFace search in `mba pull`, SSE download progress, llama.cpp `extraArgs` map (ADR-0100).
- Server log ring buffer (no `.log` files), interactive `mba servers list`, boot-trace logging.

### Fixed

- Typecheck/CI test issues, premature llama-server exit, process-group kill `ESRCH`.
- Stall-based health deadline, self-healing G2 port rule, and kv slot dirs.
