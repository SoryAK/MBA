import { defineConfig } from "vitest/config";

// Root vitest config — aggregates every package's test suite via projects.
// Each package still owns its local vitest.config.ts; `cd packages/<x> &&
// npx vitest run` works against the package-local config.
export default defineConfig({
  test: {
    projects: ["packages/*"],
  },
});
