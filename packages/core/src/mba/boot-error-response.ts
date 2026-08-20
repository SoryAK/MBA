/**
 * Server boot error responses (Step 7).
 *
 * When the bouncer encounters a server boot error, convert it to an HTTP response.
 * Returns a "retry soon" error response that instructs the client to retry the request.
 *
 * Responsibilities:
 *  - Convert ServerBootError to HTTP response
 *  - Use appropriate status codes (503 Service Unavailable)
 *  - Include retry-after hint
 *  - Log diagnostic info
 */

import type { Context } from "hono";
import { ServerBootError } from "./bouncer.js";

/**
 * Error response shape for "server booting" / retry-soon.
 * Matches OpenAI error format for compatibility.
 */
export interface ServerBootErrorResponse {
  error: {
    message: string;
    type: "server_boot_error";
    code: "server_booting" | "boot_failed" | "configuration_error";
    model?: string;
  };
  retry_after?: number; // seconds to wait before retry
}

/**
 * Convert ServerBootError to HTTP response.
 *
 * Returns:
 *  - 503 Service Unavailable for boot-in-progress / boot-failed
 *  - 500 Internal Server Error for configuration issues (missing-env)
 *
 * Includes Retry-After header to hint at retry interval.
 */
export function handleServerBootError(c: Context, err: ServerBootError): Response {
  const isConfigError = err.reason === "missing-env";
  const statusCode = isConfigError ? 500 : 503;
  const retryAfterSeconds = isConfigError ? undefined : 10; // Retry after 10s for boot errors

  const errorCode =
    err.reason === "missing-env"
      ? "configuration_error"
      : err.reason === "reboot-in-progress"
        ? "server_booting"
        : "boot_failed";

  const body: ServerBootErrorResponse = {
    error: {
      message: err.message,
      type: "server_boot_error",
      code: errorCode,
      model: err.modelId,
    },
    retry_after: retryAfterSeconds,
  };

  const response = c.json(body, statusCode);

  // Add Retry-After header if applicable
  if (retryAfterSeconds !== undefined) {
    response.headers.set("Retry-After", String(retryAfterSeconds));
  }

  return response;
}

/**
 * Error handler middleware for the bouncer.
 * Catches ServerBootError and converts to HTTP response.
 *
 * Usage:
 *   app.onError((err, c) => bootErrorHandler(err, c))
 */
export function bootErrorHandler(err: Error | Error, c: Context): Response | null {
  if (err instanceof ServerBootError) {
    return handleServerBootError(c, err);
  }
  return null; // Not a boot error; let default handler take over
}
