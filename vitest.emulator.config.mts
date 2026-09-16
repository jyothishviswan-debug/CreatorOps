// Config for `pnpm test:emulator` - focused tests that hit the real
// running Firestore/Auth emulator (no mocks), proving the seeded access-
// control data produces the expected decisions end-to-end. Separate from
// the default vitest.config.mts so a plain `pnpm test` never needs the
// emulator to be running.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { defineConfig } from "vitest/config";

// @next/env's loadEnvConfig (used by playwright.config.ts and
// scripts/seed-emulator-users.ts) doesn't reliably load files when run
// inside Vite's own config-file bundler - it reports zero loaded files
// here for reasons that didn't reproduce standalone under tsx or under
// Playwright's config loader. A plain, dependency-free .env.local parser
// sidesteps that entirely; this file only ever needs simple KEY=value
// lines, never multiline values or $VAR expansion.
function loadDotEnvLocal(): Record<string, string> {
  const envPath = path.resolve(process.cwd(), ".env.local");
  if (!existsSync(envPath)) return {};

  const values: Record<string, string> = {};
  for (const rawLine of readFileSync(envPath, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return values;
}

const dotEnvLocal = loadDotEnvLocal();

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.emulator.test.ts"],
    // Test workers don't inherit ad-hoc process.env mutations made in
    // this config module (they run in separate threads/forks) - vitest's
    // own `env` option is what actually forwards the loaded values in.
    env: { ...dotEnvLocal, ...process.env },
    // Step 5B.1A: wipes the emulator back to a known baseline once,
    // before any *.emulator.test.ts file runs - see
    // tests/emulator-global-setup.ts for why.
    globalSetup: ["./tests/emulator-global-setup.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
});
