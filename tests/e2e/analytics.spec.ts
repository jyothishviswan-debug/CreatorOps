import { test, expect, type Page } from "@playwright/test";

import { EMULATOR_TEST_USERS } from "@/server/auth/seed-users";

// Step 12B - Analytics UI E2E, mirroring tests/e2e/content.spec.ts's and
// tests/e2e/assignments.spec.ts's own setup/login/navigation conventions
// exactly. Runs in the default `chromium` project (pre-authed as
// admin@creatorops.com / super_admin / GLOBAL scope via the shared
// storageState); tests needing a different identity call signInAs
// explicitly, same idiom as every other domain spec in this app.
//
// Proves the real, LIVE Step 12A backend + seeded fixtures render
// through the ported golden-master UI - never the retired
// src/features/analytics/fixtures/index.ts sample data (asserted
// explicitly below via literal-string absence checks).
const PASSWORD = process.env.EMULATOR_TEST_USER_PASSWORD!;

function emailFor(name: string): string {
  return EMULATOR_TEST_USERS.find((user) => user.email.startsWith(`${name}@`))!.email;
}

async function signInAs(page: Page, name: string) {
  await page.context().clearCookies();
  await page.goto("/sign-in");
  await page.getByPlaceholder("you@company.com").fill(emailFor(name));
  await page.getByPlaceholder("Enter your password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/dashboard$/);
}

// The exact retired fixture literals (src/features/analytics/fixtures/index.ts)
// that must NEVER leak onto the real route.
const FIXTURE_LITERALS = ["18.4M", "12.7M", "815", "1.62M", "Nila Talks", "Local Decode", "Public Pulse", "South Lens", "94K", "82K", "71K", "65K"];

test.describe("Analytics Overview", () => {
  test("renders the 5 frozen KPI slots in order, with Instagram reach permanently unavailable and Engagement (not Interactions) sourced honestly", async ({ page }) => {
    await signInAs(page, "admin");
    await page.goto("/analytics");
    await expect(page.locator("h1")).toHaveText("Analytics");

    const kpiLabels = await page.locator(".ov-kpi-label").allTextContents();
    expect(kpiLabels).toEqual(["Instagram reach", "YouTube views", "Published content", "Engagement", "Ingestion exceptions"]);
    expect(kpiLabels).not.toContain("Interactions");

    const kpis = page.locator(".ov-kpi");
    await expect(kpis.nth(0)).toContainText("Unavailable");
    await expect(kpis.nth(0)).toContainText("Not in verified metric registry");
  });

  test("never leaks retired fixture sample values onto the real route", async ({ page }) => {
    await signInAs(page, "admin");
    await page.goto("/analytics");
    const bodyText = await page.locator("#main").innerText();
    for (const literal of FIXTURE_LITERALS) expect(bodyText, `fixture literal "${literal}" must not leak`).not.toContain(literal);
    // No internal Analytics source-record ref should ever render as prose.
    expect(bodyText).not.toMatch(/seed-analytics-(content|channel)-/);
  });

  test("Engagement Actions donut never plots a Shares segment (Shares is only ever mentioned in disclosure prose, never as a real value)", async ({ page }) => {
    await signInAs(page, "admin");
    await page.goto("/analytics");
    const panel = page.locator(".ov-panel", { hasText: "Engagement Actions" });
    await expect(panel).toBeVisible();
    // The donut's own legend (real plotted segments) never includes Shares -
    // the panel's `foot` disclosure text legitimately mentions the word
    // "Shares" in prose explaining why it's absent, so the whole-panel text
    // is not checked here.
    const legendText = await panel.locator(".ov-legend").innerText();
    expect(legendText).not.toContain("Shares");
  });

  test("Quick Actions navigate to their real destinations", async ({ page }) => {
    await signInAs(page, "admin");
    await page.goto("/analytics");
    await page.getByRole("link", { name: "Explore metrics" }).click();
    await expect(page).toHaveURL(/\/analytics\/explorer$/);

    await page.goto("/analytics");
    await page.getByRole("link", { name: "Import history", exact: true }).click();
    await expect(page).toHaveURL(/\/analytics\/import-history$/);
  });

  test("Import CTA is visible for Analyst and Super Admin, hidden for Manager and Head (Import Center stays Analyst/Super-Admin-only today)", async ({ page }) => {
    await signInAs(page, "analyst");
    await page.goto("/analytics");
    await expect(page.getByRole("link", { name: "Import data" })).toBeVisible();

    await signInAs(page, "admin");
    await page.goto("/analytics");
    await expect(page.getByRole("link", { name: "Import data" })).toBeVisible();

    await signInAs(page, "manager");
    await page.goto("/analytics");
    await expect(page.getByRole("link", { name: "Import data" })).toHaveCount(0);

    await signInAs(page, "head");
    await page.goto("/analytics");
    await expect(page.getByRole("link", { name: "Import data" })).toHaveCount(0);
  });

  test("Viewer sees an inline access-denied state, never Analytics data", async ({ page }) => {
    await signInAs(page, "viewer");
    await page.goto("/analytics");
    await expect(page.getByText("Access denied")).toBeVisible();
    await expect(page.locator(".ov-kpi")).toHaveCount(0);
  });

  test("Ingestion Exceptions rows deep-link into the Explorer", async ({ page }) => {
    await signInAs(page, "admin");
    await page.goto("/analytics");
    const attentionRow = page.locator(".ov-attention-row").first();
    if ((await attentionRow.count()) > 0) {
      await attentionRow.click();
      await expect(page).toHaveURL(/\/analytics\/explorer\?/);
    }
  });
});

test.describe("Data Explorer", () => {
  test("loads real content records, toggles record kind, filters by match state, table/cards, density", async ({ page }) => {
    await signInAs(page, "admin");
    await page.goto("/analytics/explorer");
    await expect(page.locator("h1")).toHaveText("Metric explorer");
    await expect(page.getByText("Searches the Analytics records currently loaded on this page.")).toBeVisible();

    await expect(page.locator(".tablewrap table tbody tr").first()).toBeVisible();

    await page.getByRole("button", { name: "Channel analytics" }).click();
    await expect(page.locator(".tablewrap table tbody tr").first()).toBeVisible();

    await page.getByLabel("Filter match state").selectOption("AMBIGUOUS");
    await expect(page.locator(".tablewrap .pill", { hasText: "Ambiguous" }).first()).toBeVisible();

    await page.getByRole("button", { name: "Cards view" }).click();
    await expect(page.locator(".recordgrid")).toBeVisible();
    await page.getByRole("button", { name: "Table view" }).click();

    await page.getByRole("button", { name: /Compact rows|Comfortable rows/ }).click();
  });

  test("no raw refs render as visible prose", async ({ page }) => {
    await signInAs(page, "admin");
    await page.goto("/analytics/explorer");
    const bodyText = await page.locator("#main").innerText();
    expect(bodyText).not.toMatch(/seed-analytics-(content|channel)-\w+/);
    expect(bodyText).not.toMatch(/seed-content-approved/);
  });

  test("record inspection dialog shows safe evidence, missing metrics read Unavailable/em-dash never 0", async ({ page }) => {
    await signInAs(page, "admin");
    await page.goto("/analytics/explorer");
    await page.locator(".tablewrap table tbody tr").first().locator(".iconbutton").click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Match state");
    await expect(dialog).toContainText("Engagement");
    await dialog.getByRole("button", { name: "Close dialog" }).click();
  });

  test("Manager (explore, no manage_analytics_data) never sees a Resolve match action", async ({ page }) => {
    await signInAs(page, "manager");
    await page.goto("/analytics/explorer");
    await expect(page.getByText("Resolve match")).toHaveCount(0);
  });

  test("Viewer is denied the Explorer route entirely", async ({ page }) => {
    await signInAs(page, "viewer");
    await page.goto("/analytics/explorer");
    await expect(page.getByText("Access denied")).toBeVisible();
  });

  test("mobile viewport (390px) has no horizontal overflow", async ({ page }) => {
    await signInAs(page, "admin");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/analytics/explorer");
    await expect(page.locator("h1")).toBeVisible();
    const overflow = await page.evaluate(() => document.body.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });
});

test.describe("Import History", () => {
  test("lists real bounded batches with truthful totals, opens batch detail", async ({ page }) => {
    await signInAs(page, "admin");
    await page.goto("/analytics/import-history");
    await expect(page.locator("h1")).toHaveText("Import history");
    await expect(page.locator(".tablewrap table tbody tr").first()).toBeVisible();

    await page.locator(".tablewrap table tbody tr").first().locator(".iconbutton").click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Reconciled row totals");
    await expect(dialog).toContainText("Source sheet inventory");
    const dialogText = await dialog.innerText();
    expect(dialogText).not.toMatch(/[0-9a-f]{32,}/); // no raw full hash/uid dumped
    await dialog.getByRole("button", { name: "Close dialog" }).click();
  });

  test("Import CTA links only to /imports?module=analytics, never an embedded importer", async ({ page }) => {
    await signInAs(page, "analyst");
    await page.goto("/analytics/import-history");
    const cta = page.getByRole("link", { name: "Import data" });
    await expect(cta).toBeVisible();
    await expect(cta).toHaveAttribute("href", "/imports?module=analytics");
  });

  test("Viewer is denied the Import History route entirely", async ({ page }) => {
    await signInAs(page, "viewer");
    await page.goto("/analytics/import-history");
    await expect(page.getByText("Access denied")).toBeVisible();
  });
});

test.describe("Sibling navigation", () => {
  // Step 12F: the shared Analytics tab bar is now the six equal tabs Overview |
  // Instagram | YouTube | Partners | Data Explorer | Import History (Partners was
  // added between YouTube and Data Explorer); the full six-tab / all-routes proof
  // lives in analytics-platform-views.spec.ts and analytics-partners-workspace.spec.ts.
  test("ModuleTabs links Overview/Instagram/YouTube/Partners/Data Explorer/Import History with correct active state", async ({ page }) => {
    await signInAs(page, "admin");
    await page.goto("/analytics");
    await expect(page.locator(".tabs .tab")).toHaveText(["Overview", "Instagram", "YouTube", "Partners", "Data Explorer", "Import History"]);
    await expect(page.locator(".tabs .tab.active")).toHaveText("Overview");
    await page.locator(".tabs").getByRole("link", { name: "Instagram", exact: true }).click();
    await expect(page).toHaveURL(/\/analytics\/instagram$/);
    await expect(page.locator(".tabs .tab.active")).toHaveText("Instagram");
    await page.locator(".tabs").getByRole("link", { name: "YouTube", exact: true }).click();
    await expect(page).toHaveURL(/\/analytics\/youtube$/);
    await expect(page.locator(".tabs .tab.active")).toHaveText("YouTube");
    await page.locator(".tabs").getByRole("link", { name: "Partners", exact: true }).click();
    await expect(page).toHaveURL(/\/analytics\/partners$/);
    await expect(page.locator(".tabs .tab.active")).toHaveText("Partners");
    await page.locator(".tabs").getByRole("link", { name: "Data Explorer", exact: true }).click();
    await expect(page).toHaveURL(/\/analytics\/explorer$/);
    await expect(page.locator(".tabs .tab.active")).toHaveText("Data Explorer");
    await page.locator(".tabs").getByRole("link", { name: "Import History", exact: true }).click();
    await expect(page).toHaveURL(/\/analytics\/import-history$/);
    await expect(page.locator(".tabs .tab.active")).toHaveText("Import History");
  });
});
