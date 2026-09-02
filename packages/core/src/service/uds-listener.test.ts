import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { startUdsListener, type UdsHandle } from "./uds-listener.js";

/** Make an HTTP request over a Unix domain socket and resolve with status + body. */
function socketRequest(
  socketPath: string,
  path: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.on("error", reject);
    req.end();
  });
}

function testApp(): Hono {
  const app = new Hono();
  app.get("/status", (c) => c.json({ ok: true }));
  return app;
}

function socketPathIn(dir: string): string {
  return join(dir, "mba.sock");
}

describe("startUdsListener (ADR-0101 Step 1)", () => {
  it("serves the app over the Unix socket", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mba-uds-"));
    const socketPath = socketPathIn(dir);
    const handle = await startUdsListener(testApp(), socketPath);
    try {
      expect(handle.socketPath).toBe(socketPath);
      const res = await socketRequest(socketPath, "/status");
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ ok: true });
    } finally {
      await handle.close();
    }
  });

  it("removes a stale socket file before binding", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mba-uds-"));
    const socketPath = socketPathIn(dir);
    // Simulate a leftover from a crashed daemon: a plain file at the path.
    writeFileSync(socketPath, "");
    expect(existsSync(socketPath)).toBe(true);

    const handle = await startUdsListener(testApp(), socketPath);
    try {
      const res = await socketRequest(socketPath, "/status");
      expect(res.status).toBe(200);
    } finally {
      await handle.close();
    }
  });

  it("refuses to bind when a live socket already owns the path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mba-uds-"));
    const socketPath = socketPathIn(dir);
    // A live listener on the path (another daemon).
    const other = net.createServer();
    await new Promise<void>((resolve, reject) => {
      other.listen(socketPath, () => resolve());
      other.on("error", reject);
    });

    try {
      await expect(startUdsListener(testApp(), socketPath)).rejects.toThrow();
    } finally {
      await new Promise<void>((resolve) => other.close(() => resolve()));
    }
  });

  it("unlinks the socket file on close", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mba-uds-"));
    const socketPath = socketPathIn(dir);
    const handle: UdsHandle = await startUdsListener(testApp(), socketPath);
    expect(existsSync(socketPath)).toBe(true);
    await handle.close();
    expect(existsSync(socketPath)).toBe(false);
  });
});
