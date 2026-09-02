/**
 * Unix-domain-socket listener for the MBA service app (ADR-0101 Step 1).
 *
 * MCP clients connect over a local socket instead of a TCP port. The socket
 * is bound with `createAdaptorServer` (the hono node-server adaptor) plus an
 * explicit `listen(socketPath)` — `serve()` cannot do UDS because it always
 * calls `listen(port, hostname)`.
 *
 * Stale-socket handling: a crashed daemon leaves its socket file behind. On
 * boot we probe the path — a dead socket (connect refused) is unlinked and
 * rebound; a live one (connect succeeds) means another daemon owns it and is
 * an error.
 */

import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import net from "node:net";
import type { Hono } from "hono";
import { createAdaptorServer } from "@hono/node-server";

export interface UdsHandle {
  readonly socketPath: string;
  close(): Promise<void>;
}

/**
 * Probe whether a socket file at `socketPath` is live (a listener accepts a
 * connection). A stale file — a regular file, or a socket with no listener —
 * refuses the connect and is reported as not live.
 */
function isLiveSocket(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.connect({ path: socketPath });
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", () => resolve(false));
  });
}

/**
 * Bind `app` to a Unix domain socket at `socketPath`.
 *
 * Stale-socket handling: if a file already exists at `socketPath`, probe it —
 * a dead socket (left by a crash) is unlinked and rebound; a live one is an
 * error (another daemon owns it).
 */
export function startUdsListener(app: Hono, socketPath: string): Promise<UdsHandle> {
  return new Promise<UdsHandle>((resolve, reject) => {
    let settled = false;

    function bind(): void {
      mkdirSync(dirname(socketPath), { recursive: true });
      const server = createAdaptorServer({ fetch: app.fetch });
      server.once("error", (err) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      });
      server.listen(socketPath, () => {
        if (settled) return;
        settled = true;
        resolve({
          socketPath,
          close: () =>
            new Promise<void>((res, rej) => {
              server.close((err) => {
                // The socket file is removed after the listener is down.
                try {
                  unlinkSync(socketPath);
                } catch {
                  // Already gone — nothing to clean up.
                }
                if (err) rej(err);
                else res();
              });
            }),
        });
      });
    }

    // A stale file from a crashed daemon is unlinked before we bind.
    if (existsSync(socketPath)) {
      void isLiveSocket(socketPath).then((live) => {
        if (live) {
          reject(
            new Error(
              `UDS already in use at ${socketPath} — another MBA daemon is running`,
            ),
          );
          return;
        }
        unlinkSync(socketPath);
        bind();
      });
      return;
    }
    bind();
  });
}
