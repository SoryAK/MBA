/**
 * OS-aware STATE-dir resolution for the MCP server (ADR-0097 Phase 4).
 *
 * The MCP server is a thin, standalone client — it deliberately does NOT
 * depend on @mba-ai/core (that would drag hono + the whole service into its
 * dep tree just to resolve a path, and couple its tests to core being built
 * first). So it carries its own copy of the small state-dir resolver, kept in
 * lockstep with `@mba-ai/core`'s `service/paths.ts`.
 *
 * The MCP server only ever reads `mba/service.json` for discovery, so it needs
 * the STATE dir and nothing else (no model-store root).
 *
 *   | OS      | STATE                              |
 *   |---------|------------------------------------|
 *   | Linux   | $XDG_CONFIG_HOME/mba (~/.config)   |
 *   | macOS   | ~/Library/Application Support/mba  |
 *   | Windows | %APPDATA%/mba                      |
 */

import { homedir as osHomedir } from "node:os";
import { join } from "node:path";

/**
 * The OS-standard base dir holding `mba/service.json`. Mirrors
 * `defaultStateDir` in @mba-ai/core — keep the two in sync.
 */
export function defaultStateDir(): string {
  switch (process.platform) {
    case "darwin":
      return join(osHomedir(), "Library", "Application Support", "mba");
    case "win32": {
      const appData = process.env.APPDATA;
      if (!appData || appData.length === 0) {
        throw new Error("APPDATA is not set — cannot resolve the Windows state dir");
      }
      return join(appData, "mba");
    }
    case "linux":
    default: {
      const xdg = process.env.XDG_CONFIG_HOME;
      const base = xdg && xdg.length > 0 ? xdg : join(osHomedir(), ".config");
      return join(base, "mba");
    }
  }
}
