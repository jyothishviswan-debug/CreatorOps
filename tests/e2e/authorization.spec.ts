import { test, expect, type Page } from "@playwright/test";

import { EMULATOR_TEST_USERS } from "@/server/auth/seed-users";

const PASSWORD = process.env.EMULATOR_TEST_USER_PASSWORD!;

function emailFor(name: string): string {
  return EMULATOR_TEST_USERS.find((user) => user.email.startsWith(`${name}@`))!.email;
}

async function signInAs(page: Page, email: string) {
  await page.goto("/sign-in");
  await page.getByPlaceholder("you@company.com").fill(email);
  await page.getByPlaceholder("Enter your password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/dashboard$/);
}

function navLink(page: Page, label: string) {
  return page.locator('nav[aria-label="Global navigation"]').getByRole("link", { name: label });
}

async function expectDirectAccessDenied(page: Page, path: string, featureLabel: string) {
  await page.goto(path);
  await expect(page).toHaveURL(new RegExp(`/access-denied\\?feature=`));
  await expect(page.locator("h1")).toHaveText("You don’t have access to this area");
  await expect(page.locator("p", { hasText: featureLabel })).toBeVisible();
}

async function expectDirectAccessAllowed(page: Page, path: string, expectedHeading: string) {
  await page.goto(path);
  await expect(page).toHaveURL(new RegExp(`${path}$`));
  await expect(page.locator("h1")).toHaveText(expectedHeading);
}

test.describe("Viewer", () => {
  test("can reach Partners (nav + direct route); cannot reach Finance", async ({ page }) => {
    await signInAs(page, emailFor("viewer"));

    await expect(navLink(page, "Partners")).toBeVisible();
    await expect(navLink(page, "Finance")).not.toBeVisible();

    await expectDirectAccessAllowed(page, "/partners", "Partners");
    await expectDirectAccessDenied(page, "/finance", "Finance");
  });
});

test.describe("Analyst", () => {
  test("can reach Import Center (nav + direct route); cannot reach Finance", async ({ page }) => {
    await signInAs(page, emailFor("analyst"));

    await expect(navLink(page, "Import Center")).toBeVisible();
    await expect(navLink(page, "Finance")).not.toBeVisible();

    await expectDirectAccessAllowed(page, "/imports", "Import Center");
    await expectDirectAccessDenied(page, "/finance", "Finance");
  });
});

test.describe("Partnership Manager", () => {
  test("can reach Finance (nav + direct route); cannot reach Import Center (no role-rank fallback from Analyst)", async ({
    page,
  }) => {
    await signInAs(page, emailFor("manager"));

    await expect(navLink(page, "Finance")).toBeVisible();
    await expect(navLink(page, "Import Center")).not.toBeVisible();

    await expectDirectAccessAllowed(page, "/finance", "Finance");
    await expectDirectAccessDenied(page, "/imports", "Import Center");
  });
});

test.describe("Partnership Head", () => {
  test("can reach Finance (nav + direct route); cannot reach Administration", async ({ page }) => {
    await signInAs(page, emailFor("head"));

    await expect(navLink(page, "Finance")).toBeVisible();
    await expect(navLink(page, "Administration")).not.toBeVisible();

    await expectDirectAccessAllowed(page, "/finance", "Finance");
    await expectDirectAccessDenied(page, "/administration", "Administration");
  });
});

test.describe("Super Admin", () => {
  test("can reach Administration (nav + direct route), explicitly - not via a rank comparison", async ({ page }) => {
    await signInAs(page, emailFor("admin"));

    await expect(navLink(page, "Administration")).toBeVisible();
    await expectDirectAccessAllowed(page, "/administration", "Administration");

    // Also explicitly granted every other role's representative feature.
    await expect(navLink(page, "Finance")).toBeVisible();
    await expect(navLink(page, "Import Center")).toBeVisible();
  });
});
