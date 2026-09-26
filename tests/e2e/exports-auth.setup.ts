import { test as setup, expect } from "@playwright/test";

import { EMULATOR_TEST_USERS } from "@/server/auth/seed-users";
import { resetEmulatorTestState } from "@/server/dev/emulator-reset";

// Mirrors tests/e2e/auth.setup.ts exactly, but writes to its OWN storage-state path
// (tests/e2e/.auth/user.exports-test.json) so the Export Center e2e run (driven by a private,
// non-default-port Playwright config - see the stage's own execution constraints) never collides
// with the main suite's own tests/e2e/.auth/user.json.
const STORAGE_STATE = "tests/e2e/.auth/user.exports-test.json";
const ADMIN_USER = EMULATOR_TEST_USERS.find((user) => user.email === "admin@creatorops.com")!;

setup("reset emulator state and sign in", async ({ page }) => {
  const password = process.env.EMULATOR_TEST_USER_PASSWORD;
  if (!password) {
    throw new Error("EMULATOR_TEST_USER_PASSWORD is not set - check .env.local.");
  }

  await resetEmulatorTestState(password);

  await page.goto("/sign-in");
  await page.getByPlaceholder("you@company.com").fill(ADMIN_USER.email);
  await page.getByPlaceholder("Enter your password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();

  await page.waitForURL(/\/dashboard$/);
  await expect(page.locator("h1")).toBeVisible();

  await page.context().storageState({ path: STORAGE_STATE });
});
