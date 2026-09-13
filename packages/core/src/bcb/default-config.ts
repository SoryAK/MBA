/**
 * Default Tool Circuit Breaker (TCB) configuration.
 *
 * These defaults are shipped automatically when the user has not created a
 * config file. They encode the loop patterns we have observed in production
 * Copilot/AI-Toolkit sessions with weak local models. `read_file` `repeatRun`
 * mops duplicate pairs on the first trip; EOF / clamp / binary do not summon
 * AMPI.
 */

import type { ToolCircuitBreakerConfig } from "./types.js";

export function defaultToolCircuitBreakerConfig(): ToolCircuitBreakerConfig {
  return {
    tools: {
      read_file: {
        repeatRun: {
          enabled: true,
          threshold: 2,
          escalation: {
            tiers: [
              { tier: "nudge", afterIgnoredTrips: 0, action: "ampi", recipe: "sanitize/duplicates" },
              { tier: "kill", afterIgnoredTrips: 1, action: "return-error" },
            ],
            counterMode: "monotonic",
          },
        },
        readClamp: {
          enabled: true,
        },
        eofOverflow: {
          enabled: true,
          kill: { enabled: true, ignoredTrips: 1, action: "return-error" },
          hint: {
            enabled: true,
            message:
              "[[mba: {filePath} has {actualLines} line(s). Do not call read_file beyond line {actualLines}; use the range you already have or ask a follow-up question.]]",
          },
        },
      },
    },
  };
}
