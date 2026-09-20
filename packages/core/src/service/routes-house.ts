/**
 * House doors: resolve_config, set_rules, machine overlay, status.
 */

import type { Hono } from "hono";
import { isToolCircuitBreakerConfig } from "../bcb/is-config.js";
import { isRuleClassRegistry, type RuleClassRegistry } from "../bcb/rule-classes.js";
import type { ToolCircuitBreakerConfig } from "../bcb/types.js";
import {
  isMachineOverlayMode,
  MACHINE_OVERLAY_MODES,
  readGlobalConfig,
  setMachineOverlay,
  setRules,
} from "./config-store.js";
import { withHouseLock } from "./house-lock.js";
import type { ServiceRouteContext } from "./route-context.js";
import { buildStatusSnapshot } from "./status-snapshot.js";

export function registerHouseRoutes(app: Hono, ctx: ServiceRouteContext): void {
  const { paths, opts, startedAt } = ctx;

  app.get("/resolve_config", (c) => {
    const model = c.req.query("model");
    const cfg = readGlobalConfig(paths);
    return c.json({
      version: cfg.version,
      model: model ?? null,
      tcb: cfg.tcb,
      ruleClasses: cfg.ruleClasses,
      machineOverlay: cfg.machineOverlay,
    });
  });

  app.post("/set_rules", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const input = body as { tcb?: unknown; ruleClasses?: unknown };
    if (!input || typeof input !== "object" || !isToolCircuitBreakerConfig(input.tcb)) {
      return c.json({ error: "body.tcb must be a valid ToolCircuitBreakerConfig" }, 400);
    }
    if (input.ruleClasses !== undefined && !isRuleClassRegistry(input.ruleClasses)) {
      return c.json({ error: "body.ruleClasses must be a valid RuleClassRegistry" }, 400);
    }
    try {
      const result = await withHouseLock(paths.versionPath, () =>
        setRules(paths, {
          tcb: input.tcb as ToolCircuitBreakerConfig,
          ruleClasses: input.ruleClasses as RuleClassRegistry | undefined,
        }),
      );
      return c.json(result);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "set_rules failed" }, 500);
    }
  });

  app.get("/config/machine-overlay", (c) => {
    const cfg = readGlobalConfig(paths);
    return c.json({ mode: cfg.machineOverlay });
  });

  app.post("/config/machine-overlay", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const input = body as { mode?: unknown };
    if (!input || typeof input !== "object" || !isMachineOverlayMode(input.mode)) {
      return c.json(
        { error: `body.mode must be one of ${MACHINE_OVERLAY_MODES.join(", ")}` },
        400,
      );
    }
    const mode = input.mode;
    try {
      const result = await withHouseLock(paths.versionPath, () =>
        setMachineOverlay(paths, mode),
      );
      return c.json({ mode: result.machineOverlay, version: result.version });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "set_machine_overlay failed" },
        500,
      );
    }
  });

  app.get("/status", async (c) => {
    return c.json(
      await buildStatusSnapshot({
        paths,
        adapterDir: opts.adapterDir ?? "",
        upstreamUrl: opts.upstreamUrl,
        fetch: opts.fetch,
        startedAt,
      }),
    );
  });

}
