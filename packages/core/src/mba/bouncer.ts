/**
 * Server auto-reboot bouncer (Step 6).
 *
 * Middleware that ensures the model server is up-to-date before forwarding
 * every proxy request.
 *
 * Flow:
 *  1. Extract model ID from request body
 *  2. Resolve MBA config (get model path + server flags)
 *  3. Load sticky note (last known state)
 *  4. Detect if reboot needed (model changed or flags changed)
 *  5. If needed: boot server, save new sticky note
 *  6. Return error if boot fails (Step 7 handling)
 *  7. Forward request to server
 */

// Import from the leaf modules, not the ./index.js barrel: the barrel
// re-exports bouncer.ts itself, which would make this a circular import.
import { resolveMbaConfig } from "./resolver.js";
import {
  buildLlamaServerFlags,
  sanitizeLlamaCppServerFlags,
} from "./server-flags.js";
import { bootLlamaServer, type ServerBootOptions } from "./server-lifecycle.js";
import { isRebootNeeded, saveServerState } from "./server-state.js";

/**
 * Bouncer error: returned when server boot is in progress or failed.
 * Step 7 will convert this into HTTP response.
 */
export class ServerBootError extends Error {
  readonly kind = "server-boot-error";
  readonly modelId: string;
  readonly reason: "missing-env" | "reboot-in-progress" | "boot-failed";

  constructor(modelId: string, reason: ServerBootError["reason"], message: string) {
    super(message);
    this.name = "ServerBootError";
    this.modelId = modelId;
    this.reason = reason;
  }
}

/**
 * Extract model ID from request body.
 *
 * Expects OpenAI-style: { "model": "qwen3-coder", ... }
 */
export function extractModelFromBody(body: unknown): string | null {
  if (body && typeof body === "object" && "model" in body && typeof body.model === "string") {
    return body.model;
  }
  return null;
}

/**
 * Ensure the model server is up-to-date for the requested model.
 * Boots or reboots if flags/model mismatch detected.
 *
 * The model path is a deployment parameter (ADR-0091): the server recipe
 * (`MbaServerConfig`) carries only runtime tuning knobs, so the caller
 * supplies the resolved `.gguf` location.
 *
 * @throws ServerBootError if LLAMA_SERVER_BIN not set or boot fails
 */
export async function ensureServerReady(
  modelId: string,
  mbaDir: string,
  storeDir: string,
  port: number,
  modelPath: string,
): Promise<void> {
  const binaryPath = process.env.LLAMA_SERVER_BIN;
  if (!binaryPath) {
    throw new ServerBootError(
      modelId,
      "missing-env",
      "LLAMA_SERVER_BIN environment variable not set",
    );
  }

  // Step 2: Resolve MBA config
  let mbaConfig;
  try {
    mbaConfig = resolveMbaConfig(mbaDir, { modelName: modelId, harness: "generic" });
  } catch (err) {
    throw new ServerBootError(
      modelId,
      "boot-failed",
      `Failed to resolve MBA config: ${String(err)}`,
    );
  }

  // Fail fast when no llama.cpp recipe was resolved. Without this the bouncer
  // would boot with all-default flags for a model that has no adapter — the
  // pre-ADR-0091 equivalent was the `server.modelPath` guard.
  if (!mbaConfig.server["llama.cpp"]) {
    throw new ServerBootError(
      modelId,
      "boot-failed",
      `MBA config missing server["llama.cpp"] recipe for model ${modelId}`,
    );
  }

  // Step 3: Sanitize the recipe into a fully-populated flag set, then build CLI args.
  const { flags: resolvedFlags } = sanitizeLlamaCppServerFlags(mbaConfig.server["llama.cpp"]);
  const flags = buildLlamaServerFlags(resolvedFlags);

  // Step 4: Check if reboot needed
  if (!isRebootNeeded(storeDir, modelPath, flags)) {
    // Server is up-to-date
    return;
  }

  // Step 4 & 6: Boot the server
  try {
    const bootOpts: ServerBootOptions = {
      binaryPath,
      modelPath,
      port,
      flags,
      fork: "upstream", // TODO: make configurable from MBA
      warmupTokens: resolvedFlags.warmupTokens,
    };

    const serverState = await bootLlamaServer(bootOpts);

    // Step 5: Save new sticky note
    saveServerState(storeDir, {
      modelPath: serverState.modelPath,
      flags: serverState.flags,
      pid: serverState.pid,
      port: serverState.port,
      bootedAt: serverState.bootedAt,
    });
  } catch (err) {
    throw new ServerBootError(modelId, "boot-failed", `Server boot failed: ${String(err)}`);
  }
}

/**
 * Hono middleware for the bouncer.
 * Calls ensureServerReady before forwarding the request.
 *
 * The server recipe no longer carries the model path (ADR-0091), so the
 * middleware takes a resolver that maps a request model id to its `.gguf`
 * path. A resolver returning null/undefined skips the bouncer for that
 * request (e.g. the model is served elsewhere).
 *
 * Usage:
 *   app.use(bouncerMiddleware(mbaDir, storeDir, port, (id) => resolvePath(id)))
 */
export function bouncerMiddleware(
  mbaDir: string,
  storeDir: string,
  port: number,
  resolveModelPath: (modelId: string) => string | null | undefined,
) {
  return async (c: any) => {
    const body = await c.req.json().catch(() => null);
    const modelId = extractModelFromBody(body);

    if (!modelId) {
      // No model in request; skip bouncer
      return c.next();
    }

    const modelPath = resolveModelPath(modelId);
    if (!modelPath) {
      // No local path for this model; skip bouncer
      return c.next();
    }

    try {
      await ensureServerReady(modelId, mbaDir, storeDir, port, modelPath);
    } catch (err) {
      if (err instanceof ServerBootError) {
        // Step 7: Return error response (handled by Step 7 error handler)
        throw err;
      }
      throw err;
    }

    return c.next();
  };
}
