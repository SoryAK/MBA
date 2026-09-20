/**
 * Pairing doors: POST /connect and POST /connect/revoke.
 */

import type { Hono } from "hono";
import { compactHarnessKey } from "../mba/envelope.js";
import { readEnvelopeOwner } from "../mba/stage-instructions.js";
import { defaultIdeForHarness } from "./env-context.js";
import { withHouseLock } from "./house-lock.js";
import { readModelCatalog } from "./model-catalog.js";
import { operatorEnvelopeBindings, readOperatorClients } from "./operator-clients.js";
import type { ServiceRouteContext } from "./route-context.js";
import {
  hashToken,
  mintSessionId,
  mintToken,
  pairingActive,
  readSessions,
  revokeSessions,
  sessionsSharingSlot,
  upsertSession,
  writeSessions,
} from "./sessions.js";
import { restageSlotsAfterRevoke, stageModelCard } from "./stage-model-card.js";

export function registerConnectRoutes(app: Hono, ctx: ServiceRouteContext): void {
  const { paths, opts } = ctx;

  app.post("/connect", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const input = body as {
      id?: unknown;
      projectRoot?: unknown;
      harness?: unknown;
      ide?: unknown;
    };
    if (
      !input ||
      typeof input !== "object" ||
      typeof input.id !== "string" ||
      input.id.length === 0 ||
      typeof input.projectRoot !== "string" ||
      input.projectRoot.length === 0 ||
      typeof input.harness !== "string" ||
      input.harness.length === 0 ||
      (input.ide !== undefined && typeof input.ide !== "string")
    ) {
      return c.json(
        { error: "body must be { id, projectRoot, harness, ide? }" },
        400,
      );
    }
    const modelId = input.id;
    const projectRoot = input.projectRoot;
    const harnessName = input.harness;
    const ideOpt = input.ide;
    const outcome = await withHouseLock(paths.sessionsPath, async () => {
      const sessionState = readSessions(paths.sessionsPath);
      if (sessionState.kind === "corrupt") {
        return {
          status: 503 as const,
          body: {
            code: "sessions-corrupt",
            error: `sessions state is corrupt — ${sessionState.error}`,
          },
        };
      }
      const catalog = readModelCatalog(opts.adapterDir ?? "");
      if (!catalog.some((e) => e.id === modelId)) {
        return {
          status: 404 as const,
          body: { error: `unknown model: ${modelId}`, code: "unknown-model" },
        };
      }
      const clientState = readOperatorClients(paths.clientsPath);
      if (clientState.kind === "corrupt") {
        return {
          status: 503 as const,
          body: {
            code: "clients-corrupt",
            error: `operator clients are corrupt — ${clientState.error}`,
          },
        };
      }
      const harness = harnessName;
      const ide =
        (typeof ideOpt === "string" && ideOpt.length > 0 ? ideOpt : undefined) ??
        clientState.clients.find(
          (c) => compactHarnessKey(c.name) === compactHarnessKey(harness),
        )?.ide ??
        defaultIdeForHarness(harness);
      const envelopes = operatorEnvelopeBindings(clientState.clients);
      const previousOwner = readEnvelopeOwner(projectRoot, harness, envelopes, ide);
      const slotPeers = sessionsSharingSlot(
        sessionState.sessions,
        harness,
        projectRoot,
      )
        .map((s) => s.modelId)
        .filter((id) => id !== modelId);
      const staged = stageModelCard({
        adapterDir: opts.adapterDir ?? "",
        modelId,
        projectRoot,
        harness,
        ide,
        envelopes,
        slotPeers,
      });
      if (!staged.ok && staged.code !== "conflict") {
        return {
          status: (staged.code === "unknown-model" ? 404 : 400) as 400 | 404,
          body: { error: staged.error, code: staged.code },
        };
      }
      const token = mintToken();
      const session = {
        id: mintSessionId(),
        modelId,
        harness: harnessName,
        ide,
        projectRoot,
        tokenHash: hashToken(token),
        createdAt: new Date().toISOString(),
      };
      writeSessions(paths.sessionsPath, upsertSession(sessionState.sessions, session));
      return {
        status: 200 as const,
        body: {
          token,
          modelId,
          harness: harnessName,
          ide,
          projectRoot,
          stage: staged.ok
            ? {
                action: staged.action,
                reason: staged.reason,
                envelope: staged.envelope,
                dest: staged.dest,
                owner:
                  readEnvelopeOwner(projectRoot, harness, envelopes, ide) ??
                  (staged.action === "wrote" ? modelId : previousOwner),
                ...(previousOwner &&
                previousOwner !== modelId &&
                staged.action === "wrote"
                  ? { replaced: previousOwner }
                  : {}),
              }
            : { action: "conflict", error: staged.error, code: staged.code },
        },
      };
    });
    return c.json(outcome.body, outcome.status);
  });

  app.post("/connect/revoke", async (c) => {
    let body: unknown = {};
    try {
      const text = await c.req.text();
      if (text.length > 0) body = JSON.parse(text) as unknown;
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const input = (body ?? {}) as {
      id?: unknown;
      harness?: unknown;
      projectRoot?: unknown;
    };
    if (input.id !== undefined && (typeof input.id !== "string" || input.id.length === 0)) {
      return c.json({ error: "body.id must be a model id when set" }, 400);
    }
    if (input.harness !== undefined && typeof input.harness !== "string") {
      return c.json({ error: "body.harness must be a string when set" }, 400);
    }
    if (input.projectRoot !== undefined && typeof input.projectRoot !== "string") {
      return c.json({ error: "body.projectRoot must be a string when set" }, 400);
    }
    const outcome = await withHouseLock(paths.sessionsPath, async () => {
      const sessionState = readSessions(paths.sessionsPath);
      if (sessionState.kind === "corrupt") {
        return {
          status: 503 as const,
          body: {
            code: "sessions-corrupt",
            error: `sessions state is corrupt — ${sessionState.error}`,
          },
        };
      }
      const before = sessionState.sessions;
      const next = revokeSessions(before, {
        modelId: typeof input.id === "string" ? input.id : undefined,
        harness: typeof input.harness === "string" ? input.harness : undefined,
        projectRoot: typeof input.projectRoot === "string" ? input.projectRoot : undefined,
      });
      const revoked = before.filter((s) => !next.some((n) => n.id === s.id));
      writeSessions(paths.sessionsPath, next);
      return { status: 200 as const, next, revoked };
    });
    if (outcome.status === 503) {
      return c.json(outcome.body, 503);
    }
    const clientState = readOperatorClients(paths.clientsPath);
    restageSlotsAfterRevoke({
      adapterDir: opts.adapterDir ?? "",
      envelopes: operatorEnvelopeBindings(clientState.clients),
      remaining: outcome.next,
      revoked: outcome.revoked,
    });
    return c.json({ pairing: { active: pairingActive(outcome.next), count: outcome.next.length } });
  });
}
