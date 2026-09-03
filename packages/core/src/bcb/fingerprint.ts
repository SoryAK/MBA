/**
 * Passive client fingerprint (ADR-0101 Step 2).
 *
 * Copied from C-Yard `packages/core/src/capture-record.ts` (ADR 0016): the
 * harness leaks who it is in the system prompt + User-Agent, so `fingerprint`
 * never injects anything — it only reads what the client already sends.
 *
 * The daemon needs this to key BCB kill-state by client identity (see
 * `escalate.ts`): the session key is `sha256(harness + systemPrompt)`, so a
 * no-prompt request is isolated per-harness instead of pooling every
 * no-prompt client into one counter.
 *
 * NOTE: this is a COPY, not a move. C-Yard keeps its own `fingerprint` in
 * `capture-record.ts`; dedup is deferred until C-Yard work resumes.
 */

export type Harness = "cline" | "continue" | "copilot" | "ai-toolkit" | "unknown";

export type Dialect = "xml-prose" | "openai-tools" | "unknown";

/**
 * Derive harness + dialect from what the client already sends — no probe, no
 * injection. `systemPrompt` is the first system message content; `ua` is the
 * User-Agent header; `hasTools` is whether the request carried a non-empty
 * `tools[]`.
 */
export function fingerprint(
  systemPrompt: string,
  ua: string,
  hasTools: boolean,
): { harness: Harness; dialect: Dialect } {
  const s = systemPrompt.toLowerCase();
  const u = ua.toLowerCase();
  let harness: Harness = "unknown";
  if (s.includes("you are cline") || u.includes("cline")) harness = "cline";
  else if (u.includes("continue")) harness = "continue";
  else if (u.includes("copilot") || u.includes("vscode")) harness = "copilot";
  else if (u.includes("windows-ai-studio")) harness = "ai-toolkit";
  const dialect: Dialect = hasTools
    ? "openai-tools"
    : s.includes("xml-style tags") || s.includes("<tool_name>")
      ? "xml-prose"
      : "unknown";
  return { harness, dialect };
}
