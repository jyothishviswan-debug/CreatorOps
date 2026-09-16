import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Emulator-backed integration tests (real Firestore/Auth emulator
    // reads, not mocked) are excluded from the default `pnpm test` run -
    // they need the emulator up. Run them with `pnpm test:emulator`.
    exclude: ["node_modules/**", "src/**/*.emulator.test.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
});
