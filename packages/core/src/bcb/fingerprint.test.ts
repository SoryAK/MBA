/**
 * Tests for the passive client fingerprint (ADR-0101 Step 2).
 *
 * Copied from C-Yard `packages/core/src/capture-record.ts` (ADR 0016): the
 * harness leaks who it is in the system prompt + User-Agent, so `fingerprint`
 * never injects anything. The daemon needs this to key BCB kill-state by
 * client identity (see `escalate.ts`).
 */

import { describe, expect, it } from "vitest";
import { fingerprint } from "./fingerprint.js";

describe("fingerprint — harness", () => {
  it("detects cline from the system prompt", () => {
    expect(fingerprint("You are Cline, an expert coding agent.", "", false).harness).toBe("cline");
  });

  it("detects cline from the user agent", () => {
    expect(fingerprint("", "Cline/1.0", false).harness).toBe("cline");
  });

  it("detects continue from the user agent", () => {
    expect(fingerprint("", "continue/1.2.3", false).harness).toBe("continue");
  });

  it("detects copilot from the user agent", () => {
    expect(fingerprint("", "GitHubCopilot/1.0", false).harness).toBe("copilot");
  });

  it("detects copilot from a vscode user agent", () => {
    expect(fingerprint("", "VSCode/1.90", false).harness).toBe("copilot");
  });

  it("detects ai-toolkit from the user agent", () => {
    expect(fingerprint("", "Windows-AI-Studio/2.0", false).harness).toBe("ai-toolkit");
  });

  it("returns unknown when nothing matches", () => {
    expect(fingerprint("a generic prompt", "curl/8.0", false).harness).toBe("unknown");
  });

  it("prefers the cline system-prompt marker over the user agent", () => {
    expect(fingerprint("you are cline", "VSCode/1.90", false).harness).toBe("cline");
  });
});

describe("fingerprint — dialect", () => {
  it("is openai-tools when tools are present", () => {
    expect(fingerprint("", "", true).dialect).toBe("openai-tools");
  });

  it("is xml-prose when the prompt uses xml-style tags", () => {
    expect(fingerprint("Use xml-style tags for tool calls.", "", false).dialect).toBe("xml-prose");
  });

  it("is xml-prose when the prompt uses <tool_name>", () => {
    expect(fingerprint("Wrap calls in <tool_name>", "", false).dialect).toBe("xml-prose");
  });

  it("is unknown when there are no tools and no xml markers", () => {
    expect(fingerprint("plain prompt", "", false).dialect).toBe("unknown");
  });

  it("prefers openai-tools over xml markers when tools are present", () => {
    expect(fingerprint("xml-style tags", "", true).dialect).toBe("openai-tools");
  });
});
