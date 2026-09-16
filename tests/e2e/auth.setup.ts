import { test as setup, expect } from "@playwright/test";

import { EMULATOR_TEST_USERS, seedEmulatorTestUsers } from "@/server/auth/seed-users";
import { seedAccessControlData } from "@/server/authz/seed-access-data";

const STORAGE_STATE = "tests/e2e/.auth/user.json";
const ADMIN_USER = EMULATOR_TEST_USERS.find((user) => user.email === "admin@creatorops.com")!;

setup("seed emulator test users and sign in", async ({ page }) => {
  const password = process.env.EMULATOR_TEST_USER_PASSWORD;
  if (!password) {
    throw new Error("EMULATOR_TEST_USER_PASSWORD is not set - check .env.local.");
  }

  // Idempotent - safe even if a previous run already created these users.
  await seedEmulatorTestUsers(password);
  await seedAccessControlData();

  await page.goto("/sign-in");
  await page.getByPlaceholder("you@company.com").fill(ADMIN_USER.email);
  await page.getByPlaceholder("Enter your password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();

  await page.waitForURL(/\/dashboard$/);
  await expect(page.locator("h1")).toBeVisible();

  await page.context().storageState({ path: STORAGE_STATE });
});
