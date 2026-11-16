import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Each worker gets a throwaway HOME: the real `~/.config/ukb/config.json`
    // may point this machine at a shared board, which would make every
    // local-only verb under test refuse to run.
    setupFiles: ["tests/setup-isolated-home.ts"],
    testTimeout: 15000,
  },
});
