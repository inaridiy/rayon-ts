import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Atomics.wait blocks the thread running the test; keep each file isolated
    // in its own process so a stuck job can be killed by the timeout.
    pool: "forks",
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // Worker code executes in child isolates that Vitest's process-level V8
      // collector cannot attribute. Its behavior is covered by runtime/E2E
      // tests; the generated string is checked separately for drift.
      exclude: ["src/generated/**", "src/worker/**"],
      reporter: ["text", "json-summary", "html"],
      thresholds: {
        statements: 73,
        branches: 67,
        functions: 85,
        lines: 75,
      },
    },
  },
});
