#!/usr/bin/env node
/**
 * `mba` — thin door over the MBA service (ADR-0096).
 *
 * Nouns: models, servers, machine. Local tools stay top-level.
 * Old flat verbs (config / set / open / pull / machine-overlay) are aliases.
 */

import { fail, resolveServiceUrl } from "./client.js";
import { cmdCompletion } from "./completion.js";
import { cmdEstimateMemory } from "./estimate-memory.js";
import { usageFor } from "./help.js";
import { cmdHome } from "./home.js";
import { cmdMachine } from "./machine.js";
import { cmdMigratePaths } from "./migrate.js";
import {
  cmdModelsEdit,
  cmdModelsList,
  cmdModelsOpen,
  cmdModelsPick,
  cmdModelsSearch,
  cmdModelsSet,
  cmdModelsShow,
  dispatchModelsPull,
} from "./models.js";
import { parseMbaArgv } from "./route.js";
import { cmdServers } from "./servers.js";
import { cmdStatus } from "./status.js";

async function main(argv: readonly string[]): Promise<void> {
  const { assumeNo, json, route } = parseMbaArgv(argv);
  const skipRestart = assumeNo || !process.stdin.isTTY;

  if (route.cmd === "help") {
    process.stdout.write(usageFor(route.topic) + "\n");
    return;
  }
  if (route.cmd === "home") {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      process.stdout.write(usageFor("overview") + "\n");
      return;
    }
    const baseUrl = resolveServiceUrl();
    if (!baseUrl) {
      fail(
        "MBA service not discovered — start it (npm run dev -w @mba-ai/core) or set MBA_SERVICE_URL",
      );
    }
    try {
      await cmdHome(baseUrl, skipRestart);
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }
    return;
  }
  if (route.cmd === "status") {
    await cmdStatus(json);
    return;
  }
  if (route.cmd === "completion") {
    cmdCompletion(route.args);
    return;
  }
  if (route.cmd === "migrate-paths") {
    cmdMigratePaths();
    return;
  }
  if (route.cmd === "estimate-memory") {
    cmdEstimateMemory([...route.args]);
    return;
  }
  if (route.cmd === "unknown") {
    fail(`unknown command: ${route.command}\n\n${usageFor("overview")}`);
  }

  const baseUrl = resolveServiceUrl();
  if (!baseUrl) {
    fail(
      "MBA service not discovered — start it (npm run dev -w @mba-ai/core) or set MBA_SERVICE_URL",
    );
  }

  try {
    switch (route.cmd) {
      case "machine":
        await cmdMachine(baseUrl, route.args);
        return;
      case "servers":
        await cmdServers(baseUrl, route.args, json, skipRestart);
        return;
      case "models":
        switch (route.action) {
          case "pick":
            if (json) {
              await cmdModelsList(baseUrl, true);
              return;
            }
            await cmdModelsPick(baseUrl, skipRestart);
            return;
          case "list":
            await cmdModelsList(baseUrl, json);
            return;
          case "edit":
            await cmdModelsEdit(baseUrl, route.args[0], skipRestart);
            return;
          case "show":
            await cmdModelsShow(baseUrl, route.args[0], json);
            return;
          case "set":
            await cmdModelsSet(
              baseUrl,
              route.args[0],
              route.args[1],
              route.args[2],
              skipRestart,
            );
            return;
          case "open":
            await cmdModelsOpen(baseUrl, route.args[0], route.args[1]);
            return;
          case "search":
            await cmdModelsSearch(baseUrl);
            return;
          case "pull":
            await dispatchModelsPull(baseUrl, route.args);
            return;
        }
    }
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

main(process.argv.slice(2)).catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
