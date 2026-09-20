/**
 * One live-chat policy for a request (model + harness + TCB + reasoning).
 *
 * Pairing already knows the session. The proxy used to ignore that and feed
 * global TCB plus a hardcoded Copilot/VS Code reasoning gate. This block
 * assembles the effective house after the door check.
 */

import { basename } from "node:path";
import { fingerprint } from "../bcb/fingerprint.js";
import type { ToolCircuitBreakerConfig } from "../bcb/types.js";
import type { ReasoningGate } from "../cm/reasoning.js";
import { defaultIdeForHarness, DEFAULT_RESOLVE_ENV } from "./env-context.js";
import { readModelCatalog } from "./model-catalog.js";
import { overlayTcbForModel } from "./model-watches.js";
import { reasoningGateForModel } from "./reasoning-gate.js";
import type { RecipeResolutionContext } from "./recipe-resolution.js";
import type { ClientSession } from "./sessions.js";

export interface ChatRequestPolicy {
  readonly modelId?: string;
  readonly harness: string;
  readonly ide: string;
  readonly serverRuntime: string;
  readonly tcb: ToolCircuitBreakerConfig;
  readonly reasoning?: ReasoningGate;
}

export interface ResolveChatPolicyInput {
  readonly globalTcb: ToolCircuitBreakerConfig;
  readonly adapterDir?: string;
  readonly requestModel?: string;
  readonly session?: ClientSession;
  readonly ua: string;
  readonly body: string;
}

function catalogModelId(
  adapterDir: string | undefined,
  requestModel: string | undefined,
  session?: ClientSession,
): string | undefined {
  if (session?.modelId) return session.modelId;
  if (!requestModel) return undefined;
  if (!adapterDir) return requestModel;
  try {
    const catalog = readModelCatalog(adapterDir);
    const hit =
      catalog.find((e) => e.id === requestModel) ??
      catalog.find((e) => e.name === requestModel) ??
      catalog.find(
        (e) =>
          e.modelFile !== undefined &&
          (e.modelFile === requestModel || basename(requestModel) === basename(e.modelFile)),
      );
    return hit?.id ?? requestModel;
  } catch {
    return requestModel;
  }
}

function chatHints(body: string): { systemPrompt: string; hasTools: boolean } {
  try {
    const parsed = JSON.parse(body) as { messages?: unknown; tools?: unknown };
    const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
    let systemPrompt = "";
    for (const message of messages) {
      if (!message || typeof message !== "object") continue;
      const row = message as { role?: unknown; content?: unknown };
      if (row.role === "system" && typeof row.content === "string") {
        systemPrompt = row.content;
        break;
      }
    }
    const hasTools = Array.isArray(parsed.tools) && parsed.tools.length > 0;
    return { systemPrompt, hasTools };
  } catch {
    return { systemPrompt: "", hasTools: false };
  }
}

/**
 * Resolve the request's model, authorized/fingerprinted harness, house TCB,
 * and reasoning dial. Unknown model or missing adapter leaves global TCB.
 */
export function resolveChatPolicy(input: ResolveChatPolicyInput): ChatRequestPolicy {
  const { systemPrompt, hasTools } = chatHints(input.body);
  const fingerprinted = fingerprint(systemPrompt, input.ua, hasTools).harness;
  const harness = input.session?.harness ?? fingerprinted;
  const ide =
    (input.session?.ide && input.session.ide.length > 0
      ? input.session.ide
      : undefined) ?? defaultIdeForHarness(harness);
  const serverRuntime = DEFAULT_RESOLVE_ENV.serverRuntime;
  const env: RecipeResolutionContext = { harness, ide, serverRuntime };
  const modelId = catalogModelId(input.adapterDir, input.requestModel, input.session);
  const tcb =
    input.adapterDir && modelId
      ? overlayTcbForModel(input.globalTcb, input.adapterDir, modelId, env)
      : input.globalTcb;
  return {
    modelId,
    harness,
    ide,
    serverRuntime,
    tcb,
    reasoning: reasoningGateForModel(modelId ?? input.requestModel, input.adapterDir, env),
  };
}
