# Changelog

User-facing changes to `@mba-ai/core` on npm. Versions before **0.1.12** are not listed.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.15] — 2026-09-08

### Added

- llama-server catalog (scan, nickname, ignore/restore) and boot picker; GPU layers clamped to host VRAM.
- Noun CLI (`mba models|servers|machine|status`) with list-plus-preview TTY.
- Per-model `instructions.md` and `notes.md` (notes are never injected).
- Live AMPI sanitize with llama.cpp slot erase after a mop; CM compact/prune (Assist, Sanction, Recover stay parked).
- Machine overlay (enforce / warn / off), `estimate-memory`, and slot control in the per-model KV folder.
- `mba migrate adapters`. Pull finishes the house if weights already landed.

### Changed

- Requires Node 22+ (`node:sqlite` in BCB kill-state).
- License is Apache-2.0 (was MIT).
- Adapters use `mba.ai/v1alpha1` only; the legacy apiVersion is dropped.
- Escalation YAML names AMPI recipes. CM is the only plane that edits `messages[]`.

### Fixed

- Boot `binaryPath` must be a live catalog llama-server.
- Pull `id` / `family` cannot write outside the model store.

## [0.1.12] — 2026-09-05

### Added

- Daemon-as-proxy: TCP + Unix-socket front, registry-routed upstreams with TTL health checks, TCB/escalation on the request path (ADR-0101 Steps 1–2).
- Interactive boot: pre-boot flag preview (`POST /servers/resolve`) and post-boot log tail.
- HuggingFace search in `mba pull`, SSE download progress, llama.cpp `extraArgs` map (ADR-0100).
- Server log ring buffer (no `.log` files), interactive `mba servers list`, boot-trace logging.

### Fixed

- Typecheck/CI test issues, premature llama-server exit, process-group kill `ESRCH`.
- Stall-based health deadline, self-healing G2 port rule, and kv slot dirs.
