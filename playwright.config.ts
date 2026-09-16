// Load .env.local the same way `next dev` does (dev=true) before anything
// else in this file runs, so the auth.setup project and the Firebase Admin
// SDK code it imports resolve emulator values - never .env.production.local.
import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd(), true);

import { defineConfig, devices } from "@playwright/test";

const STORAGE_STATE = "tests/e2e/.auth/user.json";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:3100",
    trace: "on-first-retry",
  },
  projects: [
    { name: "setup", testMatch: /auth\.setup\.ts/ },
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], storageState: STORAGE_STATE },
      dependencies: ["setup"],
      testIgnore: [/auth\.setup\.ts/, /auth\.spec\.ts/, /authorization\.spec\.ts/],
    },
    {
      // Tests that sign in as a specific identity themselves (rather than
      // reusing the shared admin storageState) - the base auth flow tests
      // plus the per-role authorization tests, each of which needs its
      // own fresh, unauthenticated starting context.
      name: "chromium-unauthenticated",
      use: { ...devices["Desktop Chrome"] },
      dependencies: ["setup"],
      testMatch: [/auth\.spec\.ts/, /authorization\.spec\.ts/],
    },
  ],
  webServer: [
    {
      command: "next dev --port 3100",
      url: "http://localhost:3100",
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      // Step 4B's authorization checks read Firestore (users, accessGrants,
      // scopeAssignments, sensitiveAccessGrants), so both emulators are
      // needed now, not just Auth.
      command: "firebase emulators:start --project demo-creatorops --only auth,firestore",
      url: "http://127.0.0.1:9099/",
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
});
