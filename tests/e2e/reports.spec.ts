import { expect as baseExpect, test, type Page } from "@playwright/test";

import { collectBrowserErrors, collectResponseBodies, leaked, noDocumentOverflow, renderedDom, SENSITIVE_STRINGS, waitForHydration } from "./helpers/finance-agreements-fixtures";
import { createOperationsFixtures, signInAs, VIEWPORTS, type OperationsFixtures } from "./helpers/operations-fixtures";

import { listReportDefinitions } from "@/server/reports";

const expect = baseExpect.configure({ timeout: 20_000 });

// Step 19B e2e: the Reports UI suite - catalog coverage (13/13), a full run, a viewer-safe run, the
// viewer-safe-blocked neutral message, finalize + snapshot re-open, the bounded periods picker, and
// responsive certification for /reports and /foundation. Adapted from tests/e2e/operations.spec.ts's
// own idiom (Step 18B/18C): hermetic private-region fixtures via createOperationsFixtures, unique
// tag, everything seeded through the TRUSTED service layer, removed in afterAll.

test.describe.configure({ mode: "serial" });

const TAG = `RPT${Date.now().toString(36)}`;
const fx: OperationsFixtures = createOperationsFixtures(TAG);

let headUserRef = "";

async function expectNoOverflow(page: Page, label: string) {
  const { scrollWidth, innerWidth } = await noDocumentOverflow(page);
  expect(scrollWidth, `${label}: document scrolls horizontally (${scrollWidth} > ${innerWidth})`).toBeLessThanOrEqual(innerWidth);
}

test.beforeAll(async () => {
  await fx.finance.grantFixtureRegion();
  const head = await fx.finance.actorOf("head");
  headUserRef = head.userRef;
});

test.afterAll(async () => {
  await fx.cleanupAll();
});

// ==========================================================================================
test.describe("Catalog", () => {
  test("1: /reports lists all 13 real report definitions, grouped into families", async ({ page }) => {
    const errors = collectBrowserErrors(page);
    await signInAs(page, "head");
    await page.goto("/reports");
    await expect(page.getByRole("heading", { level: 1, name: "Reports" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Catalog" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Your finalized reports" })).toBeVisible();

    const groups = await page.getByTestId("report-family-group").all();
    expect(groups.length).toBe(3);

    for (const def of listReportDefinitions()) {
      await expect(page.locator(`[data-testid="report-catalog-card"][data-report-id="${def.reportId}"]`)).toContainText(def.title);
    }
    expect(errors.errors).toEqual([]);
  });

  test("2: all 13 report ids are individually reachable and show their own real title/purpose", async ({ page }) => {
    await signInAs(page, "head");
    for (const def of listReportDefinitions()) {
      await page.goto(`/reports/${def.reportId}`);
      await expect(page.getByRole("heading", { level: 1, name: def.title })).toBeVisible();
      await expect(page.getByText(def.purpose)).toBeVisible();
      // No stale "coming soon" / "not yet implemented" language anywhere (13/13 real execution).
      await expect(page.getByText(/coming soon|not yet implemented/i)).toHaveCount(0);
    }
  });
});

// ==========================================================================================
test.describe("Execution", () => {
  test("3: full run - Operations Attention shows a seeded Task, provenance, and limitations", async ({ page }) => {
    const errors = collectBrowserErrors(page);
    const partner = await fx.finance.seedPartner({ displayName: `${TAG} Ops Target` });
    const taskTitle = `${TAG} attention task`;
    // Assigned to the Head actor themselves (rather than a region grant) - the "an actor sees their
    // own assigned/owned Task even outside region/team grants" scope exception (see
    // src/server/operations/operations-gate.ts's own comment) is the most robust way to guarantee
    // this report-running actor actually sees this seeded Task, independent of region-grant wiring.
    await fx.seedTask({ title: taskTitle, targetType: "PARTNER", targetRef: partner.partnerRef, assigneeUserRef: headUserRef });

    await signInAs(page, "head");
    await page.goto("/reports/operations_attention");
    await waitForHydration(page, '[data-testid="report-run-button"]');
    await page.getByRole("button", { name: "Run report" }).click();

    await expect(page.getByTestId("report-result")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("report-metrics-panel")).toBeVisible();
    await expect(page.locator('[data-testid="report-section"][data-section-id="tasks"]')).toContainText(taskTitle);

    // Full run: real provenance rows, never the viewer-safe "hidden" note.
    await expect(page.getByTestId("report-provenance-panel")).toContainText("operations");
    await expect(page.getByTestId("report-limitations-panel").locator("li")).not.toHaveCount(0);
    expect(errors.errors).toEqual([]);
  });

  test("4: viewer-safe run - Partner Portfolio succeeds for Viewer and hides provenance honestly", async ({ page }) => {
    const errors = collectBrowserErrors(page);
    await signInAs(page, "viewer");
    await page.goto("/reports/partner_portfolio");
    await expect(page.getByText("Viewer-safe run")).toBeVisible();
    await page.getByRole("button", { name: "Run report" }).click();

    await expect(page.getByTestId("report-result")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("report-metrics-panel")).toBeVisible();
    await expect(page.getByTestId("report-provenance-panel")).toContainText("Not shown for a viewer-safe run");
    expect(errors.errors).toEqual([]);
  });

  test("5: Viewer sees a neutral, honest message for the two viewer-safe-blocked reports", async ({ page }) => {
    await signInAs(page, "viewer");
    for (const reportId of ["finance_status", "administration_security"] as const) {
      await page.goto(`/reports/${reportId}`);
      await expect(page.getByTestId("report-viewer-blocked")).toBeVisible();
      await expect(page.getByText("Not available on your access level")).toBeVisible();
      // No filter form, no run button, no raw error - just the neutral state.
      await expect(page.getByTestId("report-filters-form")).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Run report" })).toHaveCount(0);
    }
  });

  test("6: Manager full run still works for a viewer-safe-blocked report (only Viewer is restricted)", async ({ page }) => {
    // Manager (not Analyst - Analyst holds run_reports/export but never held the "finance" source
    // feature at all, see seed-access-data.ts's own partnership_manager/analyst grants) holds both
    // run_reports and the "finance" source feature finance_status declares in requiredSourceFeatures.
    await signInAs(page, "manager");
    await page.goto("/reports/finance_status");
    await expect(page.getByTestId("report-viewer-blocked")).toHaveCount(0);
    await page.getByRole("button", { name: "Run report" }).click();
    await expect(page.getByTestId("report-result")).toBeVisible({ timeout: 15_000 });
  });
});

// ==========================================================================================
test.describe("Finalized snapshots", () => {
  test("7: finalize a run, re-open the immutable snapshot, and see it under your own finalized reports", async ({ page }) => {
    const errors = collectBrowserErrors(page);
    await signInAs(page, "head");
    await page.goto("/reports/partner_portfolio");
    await page.getByRole("button", { name: "Run report" }).click();
    await expect(page.getByTestId("report-result")).toBeVisible({ timeout: 15_000 });

    await page.getByRole("button", { name: "Finalize as snapshot" }).click();
    await expect(page.getByTestId("finalize-success")).toBeVisible({ timeout: 15_000 });
    await page.getByRole("link", { name: "View this snapshot" }).click();

    await expect(page.getByText("Immutable snapshot.")).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: "Partner Portfolio" })).toBeVisible();
    await expect(page.getByTestId("report-metrics-panel")).toBeVisible();

    await page.goto("/reports/snapshots");
    await expect(page.getByRole("heading", { level: 1, name: "Your finalized reports" })).toBeVisible();
    await expect(page.getByTestId("snapshots-table")).toContainText("Partner Portfolio");
    expect(errors.errors).toEqual([]);
  });
});

// ==========================================================================================
test.describe("Bounded periods picker (Long-Period Partner Programme)", () => {
  test("8: the periods control caps at 6 chips and a finalized-review period run renders period coverage", async ({ page }) => {
    const partner = await fx.finance.seedPartner({ displayName: `${TAG} LongPeriod Partner` });
    await fx.reviews.seedDirectReview(partner, "2024-06", { status: "FINALIZED" });

    await signInAs(page, "head");
    await page.goto("/reports/long_period_partner_programme");
    await waitForHydration(page, '[data-testid="periods-input-month"]');

    const monthInput = page.getByTestId("periods-input-month");
    const addButton = page.getByTestId("periods-input-add");
    // Exactly 6 valid months - the control disables BOTH the month input and the add button once the
    // 6-period cap is reached (a stronger guardrail than merely disabling the button), so a 7th fill
    // attempt would hang waiting for an editable, disabled input. The cap itself is asserted below.
    const months = ["2024-01", "2024-02", "2024-03", "2024-04", "2024-05", "2024-06"];
    for (const month of months) {
      await monthInput.fill(month);
      await addButton.click();
    }
    await expect(page.getByTestId("periods-input-chips").locator(".pill")).toHaveCount(6);
    await expect(page.getByText("Maximum of 6 periods reached")).toBeVisible();
    await expect(addButton).toBeDisabled();
    await expect(monthInput).toBeDisabled();

    // Remove one chip, confirm the cap lifts by one.
    await page.getByRole("button", { name: /Remove/ }).first().click();
    await expect(page.getByTestId("periods-input-chips").locator(".pill")).toHaveCount(5);

    // Reset to exactly the one period with real finalized-review evidence, plus the required partner ref.
    for (const remove of await page.getByRole("button", { name: /Remove/ }).all()) {
      const stillThere = await remove.isVisible().catch(() => false);
      if (stillThere) await remove.click().catch(() => undefined);
    }
    await monthInput.fill("2024-06");
    await addButton.click();
    await page.getByTestId("filter-partnerRef").fill(partner.partnerRef);

    await page.getByRole("button", { name: "Run report" }).click();
    await expect(page.getByTestId("report-result")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-testid="report-section"][data-section-id="periodCoverage"]')).toBeVisible();
  });
});

// ==========================================================================================
// Step 19C closure: scenarios the 19B suite above did not yet exercise - real execution against the
// GLOBAL deterministic Analytics/Partners seed (src/server/analytics/seed-analytics-data.ts,
// src/server/partners/seed-partners-data.ts - written once per emulator reset, before this file's own
// beforeAll ever runs, by tests/e2e/auth.setup.ts's resetEmulatorTestState), drilldown
// re-authorization, cross-actor snapshot inaccessibility, and a real-browser sensitive-data check.
test.describe("Step 19C closure", () => {
  test("11: Campaign Performance - the real matched Instagram row's views/engagement are honestly 'Not available' (never a fabricated 0), and the campaignRef filter genuinely scopes to that one Campaign (Step 19C fix)", async ({ page }) => {
    const errors = collectBrowserErrors(page);
    await signInAs(page, "head");
    await page.goto("/reports/campaign_performance");
    await waitForHydration(page, '[data-testid="report-run-button"]');
    await page.getByTestId("filter-campaignRef").fill("seed-campaign-planned");
    await page.getByRole("button", { name: "Run report" }).click();
    await expect(page.getByTestId("report-result")).toBeVisible({ timeout: 15_000 });

    await expect(page.locator('[data-testid="report-metric"][data-metric-id="matchedContentCount_instagram"]')).toContainText("1");
    await expect(page.locator('[data-testid="report-metric"][data-metric-id="views_instagram"]')).toContainText("Not available");
    await expect(page.locator('[data-testid="report-metric"][data-metric-id="engagement_instagram"]')).toContainText("Not available");
    await expect(page.getByText('Filtered to Campaign "South Programmes Launch".')).toBeVisible();
    expect(errors.errors).toEqual([]);
  });

  test("12: Channel Growth & Freshness shows the real seeded YouTube follower figure for creator-house", async ({ page }) => {
    await signInAs(page, "head");
    await page.goto("/reports/channel_growth_freshness");
    await waitForHydration(page, '[data-testid="report-run-button"]');
    await page.getByTestId("filter-partnerRef").fill("creator-house");
    await page.getByTestId("filter-platform").selectOption("youtube");
    await page.getByRole("button", { name: "Run report" }).click();
    await expect(page.getByTestId("report-result")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-testid="report-section"][data-section-id="accounts"]')).toContainText("128,000");
  });

  test("13: Cross-Platform Partner / Programme keeps followers_youtube separate from followers_instagram for creator-house - never blended", async ({ page }) => {
    await signInAs(page, "head");
    await page.goto("/reports/cross_platform_partner_programme");
    await waitForHydration(page, '[data-testid="report-run-button"]');
    await page.getByTestId("filter-partnerRef").fill("creator-house");
    await page.getByRole("button", { name: "Run report" }).click();
    await expect(page.getByTestId("report-result")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-testid="report-section"][data-section-id="byPartner"]')).toContainText("128,000");
  });

  test("14: drilldown closure - Campaign Delivery's Content row links into the real Content module, which re-authorizes normally (Reports is never an authorization bridge)", async ({ page }) => {
    await signInAs(page, "head");
    await page.goto("/reports/campaign_delivery");
    await waitForHydration(page, '[data-testid="report-run-button"]');
    await page.getByTestId("filter-campaignRef").fill("seed-campaign-planned");
    await page.getByRole("button", { name: "Run report" }).click();
    await expect(page.getByTestId("report-result")).toBeVisible({ timeout: 15_000 });

    const drilldown = page.locator('[data-testid="report-section"][data-section-id="content"]').getByTestId("report-row-drilldown").first();
    await expect(drilldown).toBeVisible();
    const href = await drilldown.getAttribute("href");
    expect(href).toMatch(/^\/content\//);

    await drilldown.click();
    await expect(page).toHaveURL(/\/content\//);
    // Real re-authorization in the Content module itself - a genuine detail page (Head holds
    // Kerala/Maharashtra, the fixture Content's own region), never a denial and never Reports
    // granting access to a record the actor could not otherwise open directly.
    await expect(page.getByText("Access denied")).toHaveCount(0);
    await expect(page.locator("h1")).toBeVisible();
  });

  test("15: cross-actor snapshot inaccessibility via a direct URL - a different actor gets the exact same neutral 404 a non-existent snapshot would, never Head's real data", async ({ page }) => {
    await signInAs(page, "head");
    await page.goto("/reports/discovery_funnel");
    await waitForHydration(page, '[data-testid="report-run-button"]');
    await page.getByRole("button", { name: "Run report" }).click();
    await expect(page.getByTestId("report-result")).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: "Finalize as snapshot" }).click();
    await expect(page.getByTestId("finalize-success")).toBeVisible({ timeout: 15_000 });
    const href = await page.getByRole("link", { name: "View this snapshot" }).getAttribute("href");
    expect(href).toBeTruthy();

    // Manager independently holds real Reports access too - this is not a permission gap, only a
    // different actor's OWN snapshot list, which never includes Head's snapshot.
    await signInAs(page, "manager");
    await page.goto(href!);
    await expect(page.getByRole("heading", { name: "This page could not be found." })).toBeVisible();
    await expect(page.getByTestId("report-metrics-panel")).toHaveCount(0);
  });

  test("16: sensitive-data closure - Finance Status never leaks PAN/Aadhaar/bank/GST in page text, DOM, or any network response body, even when a real KYC-bearing active Agreement exists for the filtered Partner", async ({ page }) => {
    const errors = collectBrowserErrors(page);
    const bodies = collectResponseBodies(page);
    const partner = await fx.finance.seedPartner({ displayName: `${TAG} Sensitive KYC Partner` });
    await fx.finance.fullKyc(fx.finance.partnerSubject(partner));
    await fx.finance.seedActive(fx.finance.partnerCp(partner));

    await signInAs(page, "manager");
    await page.goto("/reports/finance_status");
    await waitForHydration(page, '[data-testid="report-run-button"]');
    await page.getByTestId("filter-partnerRef").fill(partner.partnerRef);
    await page.getByRole("button", { name: "Run report" }).click();
    await expect(page.getByTestId("report-result")).toBeVisible({ timeout: 15_000 });

    expect(leaked(await renderedDom(page), SENSITIVE_STRINGS)).toEqual([]);
    expect(leaked(await page.content(), SENSITIVE_STRINGS)).toEqual([]);
    for (const body of bodies.bodies) expect(leaked(body.text, SENSITIVE_STRINGS), body.url).toEqual([]);
    expect(errors.errors).toEqual([]);
  });
});

// ==========================================================================================
test.describe("Responsive", () => {
  for (const width of VIEWPORTS) {
    test(`9: /reports renders with no horizontal overflow at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await signInAs(page, "head");
      await page.goto("/reports");
      await expect(page.getByRole("heading", { level: 1, name: "Reports" })).toBeVisible();
      await expectNoOverflow(page, `/reports @ ${width}`);
    });

    test(`10: /foundation renders with no horizontal overflow at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await signInAs(page, "head");
      await page.goto("/foundation");
      await expect(page.getByRole("heading", { level: 1, name: "The design foundation" })).toBeVisible();
      await expectNoOverflow(page, `/foundation @ ${width}`);
    });
  }
});
