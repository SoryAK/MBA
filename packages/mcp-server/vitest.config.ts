import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    globalSetup: "../core/src/test-support/cleanup-tmp.ts",
  },
});
