# Server Log Capture (Ring Buffer + Journal Tee)

## Feature Name

`mba servers logs` — live and on-demand log viewing for daemon-managed
llama.cpp servers, with no per-server `.log` files on disk.

## Functional Description

Instead of writing each llama-server's stdout/stderr to a `.log`/`.err` file
in the store dir, the daemon captures the output in memory and tees it to its
own stdout (which systemd routes to the journal). The user gets:

1. **One-shot view** — `mba servers logs <id>` prints the server's recent
   output; `--lines N` limits to the last N lines.
2. **Live tail** — `mba servers logs <id> --follow` keeps printing new lines
   as they arrive (polls every 2s, Ctrl-C stops).
3. **Interactive picker** — `mba servers list` → select a server → `logs`
   drops straight into the live tail for that server.
4. **Persistent copy** — every line is also written to the daemon's stdout as
   `[llama:<port>] <line>`, so `journalctl` holds the full history with
   systemd's normal rotation. No log files to clean up, no unbounded growth.

## Internal Workflow

1. **Spawn with pipes** (`server-lifecycle.ts`) — the daemon spawns
   llama-server with `stdio: ["ignore", "pipe", "pipe"]` (stdin ignored,
   stdout+stderr piped) and `detached: true` (so the child survives a daemon
   restart and can be re-adopted).
2. **Line-split into a ring buffer** (`server-log-buffer.ts`) — each
   `data` chunk from stdout/stderr is fed to a per-port `ServerLogBuffer`
   (keyed by port, stored on the shared `LifecycleSeams` instance under a
   `Symbol.for` key). The buffer splits on `\n`, holds the trailing partial
   line until the next chunk, skips empty lines, and evicts the oldest lines
   once total size exceeds the bound (default 1 MiB).
3. **Tee to journal** — at spawn time the lifecycle subscribes a callback to
   the buffer that writes `[llama:<port>] <line>\n` to `process.stdout`.
   systemd captures the daemon's stdout into the journal.
4. **HTTP route** (`service/server.ts`) — `GET /servers/logs?id=<id>&lines=N`
   resolves the id to a registry entry (port), fetches that port's buffer,
   and returns `{ id, lines }`. Unknown id → 404; missing id → 400; bad
   `lines` → 400.
5. **CLI** (`cli/mba.ts`) — `cmdServersLogs` does a one-shot `serviceGet` and
   prints the lines, or (with `--follow`) loops every 2s printing only lines
   newer than the last print. If the buffer evicted below the print anchor
   (heavy output), it re-anchors to the current length and continues (the
   evicted lines are already in the journal). A 404 mid-follow (server
   stopped) ends the tail gracefully.
6. **Interactive** (`cli/interactive.ts`) — the per-server action menu is
   `stop` / `logs` / `back`; picking `logs` calls `cmdServersLogs(...,
   follow=true)`.

## Configuration / Params

- `DEFAULT_LOG_BUFFER_BYTES` = 1 MiB per server (in-memory cap; oldest
  lines evicted beyond this).
- `--lines N` — last N lines (default: all buffered lines).
- `--follow` — poll interval 2s; Ctrl-C stops.
- Tee format: `[llama:<port>] <line>` on the daemon's stdout.
- Server ids: `llama-cpp-<port>` / `ollama-<port>`; the route resolves the
  port from the registry entry, not by parsing the id.

## Known Constraints

- **Bounded memory** — the ring is a live view, not a store. Under heavy
  output, old lines are evicted; the journal is the persistent record.
- **Ollama / API-managed servers** have no daemon-owned process, so no
  buffer exists — the route returns an empty `lines` array (not an error).
- **Follow re-anchors** — if eviction shrinks the buffer below the printed
  count, the tail drops the evicted lines and continues from the current
  tail (no re-print, no crash).
- **Backpressure** — a stalled journal backpressures the daemon's stdout,
  which backpressures the pipe into llama-server. Accepted trade-off (a
  wedged journal is a system-level problem, not a per-server one).
- **Daemon restart** — the in-memory buffer is lost on daemon restart; the
  journal retains the pre-restart history.
