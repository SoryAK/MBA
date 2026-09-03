/**
 * TCB kill-response builder (ADR-0101 Step 2).
 *
 * Copied from C-Yard `packages/proxy/src/server.ts` (`buildBcbKillResponse`).
 * Builds the proxy response for a kill action, or returns undefined to
 * continue with a (possibly mutated) body.
 *
 * The C-Yard `wantStream` param was dropped: the kill action alone determines
 * the response shape (return-error → 400 JSON, close-stream → 200 SSE), so
 * the flag was vestigial.
 */

import type { ToolCircuitBreakerKill } from "./types.js";

/**
 * Build the proxy response for a kill action, or undefined to continue.
 *
 * - `drop-tools`: deletes `tools` from the body and continues.
 * - `block-tool`: filters the killed tool out of `tools` and continues.
 * - `return-error`: 400 JSON error.
 * - `close-stream`: 200 SSE with a `finish_reason: stop` and `[DONE]`.
 */
export function buildBcbKillResponse(
  kill: ToolCircuitBreakerKill,
  parsed: Record<string, unknown>,
): Response | undefined {
  if (kill.action === "drop-tools") {
    delete parsed.tools;
    return undefined; // continue with mutated body in caller
  }
  if (kill.action === "block-tool") {
    const tools = parsed.tools;
    if (Array.isArray(tools)) {
      parsed.tools = tools.filter((t) => {
        if (!t || typeof t !== "object") return true;
        const fn = (t as { function?: unknown }).function as { name?: unknown } | undefined;
        return fn?.name !== kill.tool;
      });
    }
    return undefined; // continue with mutated body in caller
  }

  const errorBody = {
    error: {
      message: `c-yard BCB kill: ${kill.reason}`,
      type: "bcb_kill",
      param: kill.tool,
      code: kill.rule,
    },
  };

  if (kill.action === "return-error") {
    return new Response(JSON.stringify(errorBody), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  if (kill.action === "close-stream") {
    const streamBody =
      `: c-yard BCB kill: ${kill.reason}\n\n` +
      `data: ${JSON.stringify({ choices: [{ index: 0, finish_reason: "stop", delta: {} }] })}\n\n` +
      `data: [DONE]\n\n`;
    return new Response(streamBody, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }

  return undefined;
}
