# Changelog

User-facing changes to `@mba-ai/core` on npm. Versions before **0.1.12** are not listed.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.16] — 2026-09-13

### Added

- `mba start` / `mba stop`: background daemon (systemd --user on Linux). `--foreground` is this terminal. A second start prints the URL already in use.
- Known watches: `mba models watch <id>` for clamp / eof / loop (`inherit` | `off` | `on`). Empty house `tcb.jsonl` inherits on, not off.
- Read-loop mop on first trip (Sanitize).
- `mba migrate models` / `mba migrate find`: local GGUFs into the hub (copy or hardlink).
- Bare boot (family+model dials only). `mba connect` stages the card and mints a token.
- `mba clients`: pairing, hashed tokens, stage / revoke.
- Per-model SQLite tool and trip history.

### Changed

- `mba start` is how the daemon runs. `npm start` is that verb; `--foreground` is `npm run dev`.
- Boot does not attach a client env. `mba connect` does that after.
- llama.cpp owns boot warmup (MBA does not POST `/completion`).
- Package README follows install → migrate or pull → boot → connect. Commands take a model id (`mba models list` is id · family).

### Removed

- `mba migrate adapters` and `mba migrate-paths`. Use `mba migrate models` / `find`.

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
