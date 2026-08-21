#!/usr/bin/env node
/**
 * Model Behavioral Adapter MCP server.
 *
 * Exposes MBA tools over stdio transport:
 *   - mba_file_metadata   — probe a workspace file (offline)
 *   - mba_model_registry  — light listing of loaded model adapters (offline)
 *   - mba_resolve_config  — effective global MBA config from the service
 *   - mba_set_rules       — update global TCB rules via the service
 *   - mba_server_status   — service health/liveness probe
 *   - mba_list_models     — model plane listing + live loaded state (ADR-0093)
 *   - mba_ensure_model    — user-triggered model switch (ADR-0093, OFF by default)
 *
 * The service tools are thin HTTP wrappers: the global MBA service
 * (ADR-0092) stays the single source of truth and the only file writer.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type TextContent,
} from "@modelcontextprotocol/sdk/types.js";
import { resolve } from "node:path";
import { loadAdapters } from "./adapter/loader.js";
import { resolveServiceBaseUrl } from "./service-client.js";
import { createEnsureModelHandler } from "./tools/ensure-model.js";
import { createFileMetadataHandler } from "./tools/file-metadata.js";
import { createListModelHandler } from "./tools/list-models.js";
import { createModelRegistryHandler } from "./tools/model-registry.js";
import { createResolveConfigHandler } from "./tools/resolve-config.js";
import { createServerStatusHandler } from "./tools/server-status.js";
import { createSetRulesHandler } from "./tools/set-rules.js";

const mbaDir = process.env.MBA_DIR
  ? resolve(process.env.MBA_DIR)
  : resolve(process.cwd(), ".MBA");

const workspaceRoot = process.env.MBA_WORKSPACE_ROOT
  ? resolve(process.env.MBA_WORKSPACE_ROOT)
  : resolve(process.cwd());

const adapters = loadAdapters(resolve(mbaDir, "adapters"), workspaceRoot);

const server = new Server(
  {
    name: "mba-mcp-server",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "mba_file_metadata",
        description:
          "Probe a workspace file and return metadata (exists, totalLines, sizeBytes, " +
          "isDirectory, lastModified, isBinary). This tool does NOT return file content; " +
          "use read_file with a valid line range after probing. " +
          "If isBinary is true, do not use read_file; use run_in_terminal with the " +
          "appropriate CLI (e.g. sqlite3 for .db/.sqlite files) or session_store_sql " +
          "for the session database.",
        inputSchema: {
          type: "object",
          properties: {
            filePath: {
              type: "string",
              description: "Path to the file, relative to the workspace root",
            },
          },
          required: ["filePath"],
        },
      },
      {
        name: "mba_model_registry",
        description:
          "List the MBA model adapters loaded from .MBA/adapters (offline — no " +
          "service round-trip). Returns a light entry per model: id, name, family, " +
          "model family/name/file, and which binding sections (bcb, tcb, structural, " +
          "server_setup) are present. For a per-model full report (resolved config, " +
          "structural rules, server flags) call mba_resolve_config with the model id.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "mba_resolve_config",
        description:
          "Read the effective global MBA config from the MBA service: version, " +
          "global TCB rules, and the rule-class registry. Optional `model` is passed " +
          "through for per-model resolution context. Requires the MBA service to be " +
          "running; returns a clear error if it is unreachable.",
        inputSchema: {
          type: "object",
          properties: {
            model: {
              type: "string",
              description: "Optional model id for per-model resolution context",
            },
          },
        },
      },
      {
        name: "mba_set_rules",
        description:
          "Update the global TCB rules (and optionally the rule-class registry) via " +
          "the MBA service. `tcb` must be a full ToolCircuitBreakerConfig object; " +
          "`ruleClasses` an optional full RuleClassRegistry object. The service " +
          "validates the shapes, writes atomically, and bumps the version. Requires " +
          "the MBA service to be running.",
        inputSchema: {
          type: "object",
          properties: {
            tcb: {
              type: "object",
              description: "Full ToolCircuitBreakerConfig object",
            },
            ruleClasses: {
              type: "object",
              description: "Optional full RuleClassRegistry object",
            },
          },
          required: ["tcb"],
        },
      },
      {
        name: "mba_server_status",
        description:
          "Health/liveness probe for the global MBA service. Returns the service " +
          "version, uptime, and the on-disk paths it owns. Requires the MBA service " +
          "to be running; returns a clear error if it is unreachable.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "mba_list_models",
        description:
          "List the switchable models from the central model home (~/models/adapters) " +
          "with their live loaded state, as seen by the MBA service. Each entry: id, " +
          "name, family, modelFile, and loaded (true if that model is what the " +
          "upstream llama-server currently has loaded). Read-only. Requires the MBA " +
          "service to be running; returns a clear error if it is unreachable.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "mba_ensure_model",
        description:
          "Ask the MBA service to make sure a specific model is the loaded one " +
          "(ADR-0093). Idempotent: if the model is already loaded this is a no-op. " +
          "Model switching is OFF by default — until the service is armed with " +
          "MBA_MODEL_SWITCH=on, this returns a 409 'disabled' error. Unknown model " +
          "ids return 404. This is the user-triggered switch; the proxy never " +
          "switches models on its own.",
        inputSchema: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "Model id from the adapter tree (see mba_list_models)",
            },
          },
          required: ["id"],
        },
      },
    ],
  };
});

const handleFileMetadata = createFileMetadataHandler(workspaceRoot);
const handleModelRegistry = createModelRegistryHandler(adapters);
const handleResolveConfig = createResolveConfigHandler();
const handleSetRules = createSetRulesHandler();
const handleServerStatus = createServerStatusHandler();
const handleListModels = createListModelHandler();
const handleEnsureModel = createEnsureModelHandler();

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const args = (request.params.arguments ?? {}) as Record<string, unknown>;
  let result: unknown;

  switch (request.params.name) {
    case "mba_file_metadata": {
      result = handleFileMetadata({ filePath: String(args.filePath ?? "") });
      break;
    }
    case "mba_model_registry": {
      result = handleModelRegistry();
      break;
    }
    case "mba_resolve_config": {
      result = await handleResolveConfig({
        model: typeof args.model === "string" ? args.model : undefined,
      });
      break;
    }
    case "mba_set_rules": {
      result = await handleSetRules({
        tcb: args.tcb,
        ruleClasses: args.ruleClasses,
      });
      break;
    }
    case "mba_server_status": {
      result = await handleServerStatus();
      break;
    }
    case "mba_list_models": {
      result = await handleListModels();
      break;
    }
    case "mba_ensure_model": {
      result = await handleEnsureModel({
        id: typeof args.id === "string" ? args.id : "",
      });
      break;
    }
    default:
      throw new Error(`Unknown tool: ${request.params.name}`);
  }

  const content: TextContent = {
    type: "text",
    text: JSON.stringify(result, null, 2),
  };

  return {
    content: [content],
    isError: (result as { error?: unknown }).error !== undefined,
  };
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Diagnostics to stderr so they don't collide with MCP messages on stdout.
  const serviceUrl = resolveServiceBaseUrl();
  console.error(`mba-mcp-server started`);
  console.error(`  adapters: ${adapters.length} loaded from ${mbaDir}`);
  console.error(`  workspaceRoot: ${workspaceRoot}`);
  console.error(
    `  mba service: ${serviceUrl ?? "not discovered (service tools will report unreachable)"}`,
  );
}

main().catch((err) => {
  console.error("mba-mcp-server fatal error:", err);
  process.exit(1);
});
