import { test, expect } from "@playwright/test";

// Every static route required by the Step 3B skeleton spec. Dynamic
// [id] detail routes are exercised separately in detail-flow.spec.ts by
// clicking through from their workspace, since fixture ids are generated
// data rather than fixed constants.
const STATIC_ROUTES = [
  "/dashboard",
  "/discovery",
  "/discovery/leads",
  "/discovery/new",
  "/partners",
  "/partners/new",
  "/vendors",
  "/vendors/new",
  "/campaigns",
  "/campaigns/new",
  "/assignments",
  "/content",
  "/analytics",
  "/analytics/explorer",
  "/analytics/import-history",
  "/partner-reviews",
  "/finance",
  "/finance/agreements",
  "/finance/payables",
  "/finance/invoices",
  "/finance/payments",
  "/operations",
  "/operations/tasks",
  "/operations/approvals",
  "/operations/reminders",
  "/reports",
  "/imports",
  "/exports",
  "/administration",
  "/administration/users",
  "/administration/users/new",
  "/administration/access",
  "/administration/audit",
  "/foundation",
];

for (const route of STATIC_ROUTES) {
  test(`route renders without error: ${route}`, async ({ page }) => {
    const pageErrors: Error[] = [];
    page.on("pageerror", (err) => pageErrors.push(err));

    const response = await page.goto(route);
    expect(response?.ok(), `${route} should respond OK`).toBeTruthy();

    await expect(page.locator("h1").first()).toBeVisible();
    expect(pageErrors, `${route} threw a client-side error: ${pageErrors[0]?.message}`).toHaveLength(0);
  });
}

test("unknown dynamic id renders a not-found state, not a crash", async ({ page }) => {
  const pageErrors: Error[] = [];
  page.on("pageerror", (err) => pageErrors.push(err));

  const response = await page.goto("/partners/does-not-exist");
  expect(response?.status()).toBe(404);
  expect(pageErrors).toHaveLength(0);
});
