/**
 * Operator-client doors: GET/POST /clients and POST /clients/remove.
 */

import type { Hono } from "hono";
import {
  addOperatorClient,
  clientsCorruptJson,
  listRegisteredClients,
  readOperatorClients,
  removeOperatorClient,
} from "./operator-clients.js";
import type { ServiceRouteContext } from "./route-context.js";

export function registerClientRoutes(app: Hono, ctx: ServiceRouteContext): void {
  const { paths } = ctx;

  app.get("/clients", (c) => {
    const state = readOperatorClients(paths.clientsPath);
    return c.json({
      clients: listRegisteredClients(paths.clientsPath),
      integrity: state.kind,
      ...(state.kind === "corrupt" ? { error: state.error } : {}),
    });
  });

  app.post("/clients", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const input = body as { name?: unknown; envelope?: unknown; ide?: unknown };
    if (
      !input ||
      typeof input !== "object" ||
      typeof input.name !== "string" ||
      input.name.length === 0 ||
      typeof input.envelope !== "string" ||
      input.envelope.length === 0 ||
      (input.ide !== undefined && typeof input.ide !== "string")
    ) {
      return c.json({ error: "body must be { name, envelope, ide? }" }, 400);
    }
    const result = addOperatorClient(paths.clientsPath, {
      name: input.name,
      envelope: input.envelope,
      ide: typeof input.ide === "string" ? input.ide : undefined,
    });
    if (!result.ok) {
      if (result.code === "clients-corrupt") {
        return c.json(clientsCorruptJson(result.error), 503);
      }
      return c.json({ error: result.error }, 400);
    }
    return c.json({
      name: result.client.name,
      envelope: result.client.envelope,
      ...(result.client.ide ? { ide: result.client.ide } : {}),
      updated: result.updated,
    });
  });

  app.post("/clients/remove", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const input = body as { name?: unknown };
    if (!input || typeof input !== "object" || typeof input.name !== "string" || input.name.length === 0) {
      return c.json({ error: "body must be { name }" }, 400);
    }
    const result = removeOperatorClient(paths.clientsPath, input.name);
    if (!result.ok) {
      if (result.code === "clients-corrupt") {
        return c.json(clientsCorruptJson(result.error), 503);
      }
      return c.json({ error: result.error }, 400);
    }
    return c.json({ name: input.name.trim().toLowerCase(), removed: result.removed });
  });
}
