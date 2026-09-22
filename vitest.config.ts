import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Cold ESM import of src/index.ts (with its peer-dep chain) exceeds
    // vitest's default 10s hook timeout on Windows when collected in
    // parallel with the rest of the suite. Raise the limit so the
    // `beforeAll` in test/index.test.ts doesn't flake locally.
    hookTimeout: 60_000,
    testTimeout: 60_000,
    coverage: {
      provider: "v8",
      include: ["src/runner/**/*.ts", "src/agents.ts", "src/security.ts", "src/output.ts"],
      thresholds: { lines: 80, functions: 80, statements: 80, branches: 70 },
    },
  },
});
