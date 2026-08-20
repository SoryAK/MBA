/**
 * Default Tool Circuit Breaker (TCB) configuration.
 *
 * These defaults are shipped automatically when the user has not created a
 * config file. They encode the loop patterns we have observed in production
 * Copilot/AI-Toolkit sessions with weak local models.
 */

import type { ToolCircuitBreakerConfig } from "./types.js";

export function defaultToolCircuitBreakerConfig(): ToolCircuitBreakerConfig {
  return {
    tools: {
      read_file: {
        repeatRun: {
          enabled: true,
          threshold: 2,
          kill: { enabled: true, ignoredTrips: 1, action: "return-error" },
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
              "[[c-yard: {filePath} has {actualLines} line(s). Do not call read_file beyond line {actualLines}; use the range you already have or ask a follow-up question.]]",
          },
        },
      },
    },
  };
}
