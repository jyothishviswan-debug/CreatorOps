import { test as setup, expect } from "@playwright/test";

import { EMULATOR_TEST_USERS } from "@/server/auth/seed-users";
import { resetEmulatorTestState } from "@/server/dev/emulator-reset";

const STORAGE_STATE = "tests/e2e/.auth/user.json";
const ADMIN_USER = EMULATOR_TEST_USERS.find((user) => user.email === "admin@creatorops.com")!;

setup("reset emulator state and sign in", async ({ page }) => {
  const password = process.env.EMULATOR_TEST_USER_PASSWORD;
  if (!password) {
    throw new Error("EMULATOR_TEST_USER_PASSWORD is not set - check .env.local.");
  }

  // Step 5B.1A: this Playwright project's "setup" test runs exactly once
  // before the whole suite - the right, and only, place to wipe the
  // emulator back to a known baseline before an automated run. Every
  // provisioned/lifecycle/audit user any spec creates afterward is
  // deliberately NOT cleaned up per-test (several specs' own assertions
  // rely on data created earlier in the same run being visible later),
  // so without this the emulator would otherwise accumulate indefinitely
  // across repeated `pnpm test:e2e` runs.
  await resetEmulatorTestState(password);

  await page.goto("/sign-in");
  await page.getByPlaceholder("you@company.com").fill(ADMIN_USER.email);
  await page.getByPlaceholder("Enter your password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();

  await page.waitForURL(/\/dashboard$/);
  await expect(page.locator("h1")).toBeVisible();

  await page.context().storageState({ path: STORAGE_STATE });
});
