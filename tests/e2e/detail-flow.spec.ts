import { test, expect } from "@playwright/test";

// Modules whose index route IS the record workspace (real table, click a
// row to open a detail record): Discovery's dedicated /leads sub-route,
// plus Assignments and Content which have no Overview and are
// workspace-only per the golden master's navigate() default.
const WORKSPACE_TO_DETAIL: { workspace: string; back: string }[] = [
  { workspace: "/discovery/leads", back: "/discovery/leads" },
  { workspace: "/assignments", back: "/assignments" },
  { workspace: "/content", back: "/content" },
];

for (const { workspace, back } of WORKSPACE_TO_DETAIL) {
  test(`workspace to detail flow: ${workspace}`, async ({ page }) => {
    await page.goto(workspace);

    const firstRow = page.locator("button.rowlink.person").first();
    await expect(firstRow).toBeVisible();
    const recordName = await firstRow.locator("b").innerText();
    await firstRow.click();

    await expect(page.locator("h1")).toHaveText(recordName);
    await expect(page.getByText("Back to workspace")).toBeVisible();

    await page.getByText("Back to workspace").click();
    await expect(page).toHaveURL(new RegExp(`${back}$`));
  });
}

// Modules that are single-Overview-index (no separate workspace route yet
// - the Overview/Workspace tabs bar is kept for a future build step, per
// explicit product direction). Their Overview's Recent Activity panel
// links directly to real detail records, so the detail pattern is
// exercised via those known hrefs instead of a workspace table.
// Partners moved out of this list in Step 7B, Vendors in Step 8B, and
// Campaigns in Step 9B - each now has a real dedicated Workspace and
// Detail page, covered by tests/e2e/partners.spec.ts, vendors.spec.ts
// and campaigns.spec.ts respectively.
const OVERVIEW_DETAIL_LINKS: { detail: string; back: string }[] = [
  { detail: "/partner-reviews/ananya-rao", back: "/partner-reviews" },
  { detail: "/reports/monthly-partner-review", back: "/reports" },
];

for (const { detail, back } of OVERVIEW_DETAIL_LINKS) {
  test(`detail screen renders and returns to workspace: ${detail}`, async ({ page }) => {
    await page.goto(detail);
    await expect(page.locator("h1")).toBeVisible();
    await expect(page.getByText("Back to workspace")).toBeVisible();

    await page.getByText("Back to workspace").click();
    await expect(page).toHaveURL(new RegExp(`${back}$`));
  });
}

test("overview screen renders KPIs and panels: /dashboard", async ({ page }) => {
  await page.goto("/dashboard");
  await expect(page.locator(".ov-kpis").first()).toBeVisible();
});

test("overview screen renders KPIs and panels: /partners", async ({ page }) => {
  await page.goto("/partners");
  await expect(page.locator("h1")).toHaveText("Partners");
  await expect(page.locator(".ov-kpis").first()).toBeVisible();
});

// Partners' and Campaigns' real create forms (with real duplicate
// checking/validation/persistence) are covered by tests/e2e/partners.spec.ts's
// and campaigns.spec.ts's own "Create" suites, not this generic
// fixture-form smoke test.
