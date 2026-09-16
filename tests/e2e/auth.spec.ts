import { test, expect, type Page } from "@playwright/test";

import { EMULATOR_TEST_USERS } from "@/server/auth/seed-users";

const ADMIN_USER = EMULATOR_TEST_USERS.find((user) => user.email === "admin@creatorops.com")!;
const PASSWORD = process.env.EMULATOR_TEST_USER_PASSWORD!;

async function signIn(page: Page) {
  await page.goto("/sign-in");
  await page.getByPlaceholder("you@company.com").fill(ADMIN_USER.email);
  await page.getByPlaceholder("Enter your password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/dashboard$/);
}

test("unauthenticated visitors are redirected to /sign-in with a return path", async ({ page }) => {
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/sign-in\?redirect=%2Fdashboard$/);
  await expect(page.locator("h1")).toHaveText("Welcome back.");
});

test("invalid credentials show a clear error and stay on /sign-in", async ({ page }) => {
  await page.goto("/sign-in");
  await page.getByPlaceholder("you@company.com").fill(ADMIN_USER.email);
  await page.getByPlaceholder("Enter your password").fill("definitely-the-wrong-password");
  await page.getByRole("button", { name: "Sign in" }).click();

  // Next.js's own route announcer also has role="alert"; target the form's error box directly.
  await expect(page.locator(".error")).toHaveText("Invalid email or password.");
  await expect(page).toHaveURL(/\/sign-in$/);
  await expect(page.getByPlaceholder("Enter your password")).toHaveValue("");
});

test("valid sign-in reaches the dashboard", async ({ page }) => {
  await signIn(page);
  await expect(page.locator("h1")).toBeVisible();
});

test("an authenticated session can reach other protected routes directly", async ({ page }) => {
  await signIn(page);
  await page.goto("/finance");
  await expect(page).toHaveURL(/\/finance$/);
  await expect(page.locator("h1")).toHaveText("Finance");
});

test("the session survives a full page reload", async ({ page }) => {
  await signIn(page);
  await page.goto("/finance");
  await page.reload();
  await expect(page).toHaveURL(/\/finance$/);
  await expect(page.locator("h1")).toHaveText("Finance");
});

test("signing out clears the session and re-locks protected routes", async ({ page }) => {
  await signIn(page);

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/sign-in$/);

  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/sign-in\?redirect=%2Fdashboard$/);
});
