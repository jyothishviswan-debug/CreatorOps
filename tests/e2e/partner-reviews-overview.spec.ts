import { test, expect } from "@playwright/test";

import { createFixtures, noDocumentOverflow, signInAs, VIEWPORTS } from "./helpers/partner-reviews-fixtures";

// Step 13B - the Partner Reviews Overview (/partner-reviews) through the real UI on real emulator data.
// Runs in the default `chromium` project (pre-authed as the seeded Super Admin, GLOBAL scope).
//
// The composition is STRUCTURALLY FROZEN (golden master OV_DATA["creator-reviews"]): 4 KPI cards; a top row of
// 3 panels (span 4) and a bottom row of 4 panels (span 3). Data: reviews in the PAST month 2015-04 - the newest
// month any Partner Reviews spec uses, so it is also the default month - created through the trusted services
// under a private region. Assertions are scoped to that month (no other spec writes to it).
const fx = createFixtures("e2e13bov");
const MONTH = "2015-04";
const NAMES = { draft: "E2E OV Draft Partner", finalized: "E2E OV Finalized Partner", candidate: "E2E OV Candidate Partner", behind: "E2E OV Behind Partner" };

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  await fx.grantFixtureRegion();
  const draft = await fx.seedRich({ month: MONTH, displayName: NAMES.draft });
  await fx.generate(draft.partner.partnerRef, MONTH);
  const finalized = await fx.seedRich({ month: MONTH, displayName: NAMES.finalized, threadStatus: "APPROVED" });
  await fx.generateFinalized(finalized.partner.partnerRef, MONTH);
  await fx.seedRich({ month: MONTH, displayName: NAMES.candidate });
  // A finalized review whose LAST RECORDED freshness check said "behind upstream".
  const behind = await fx.seedPartner({ displayName: NAMES.behind });
  await fx.seedDirectReview(behind, MONTH, { status: "FINALIZED", hint: "revision_available" });
});

test.afterAll(async () => {
  await fx.cleanupAll();
});

test("exact composition: header, ov-page structure, 4 KPIs in order, top 3 panels span 4, bottom 4 panels span 3", async ({ page }) => {
  await page.goto(`/partner-reviews?month=${MONTH}`);

  await expect(page.locator(".ov-page")).toHaveCount(1);
  await expect(page.locator(".ov-page .eyebrow")).toHaveText("MEASURE & REVIEW");
  await expect(page.locator("h1")).toHaveText("Partner Reviews");
  await expect(page.getByText("Review monthly production, compliance and performance independently.")).toBeVisible();
  // Overview | Workspace switch, Overview current.
  await expect(page.locator(".tabs .tab")).toHaveText(["Overview", "Workspace"]);
  await expect(page.locator(".tabs .tab.active")).toHaveText("Overview");
  await expect(page.locator(".ov-context")).toHaveCount(1);

  // KPI row: exactly four, in order.
  await expect(page.locator(".ov-kpis .ov-kpi")).toHaveCount(4);
  await expect(page.locator(".ov-kpis .ov-kpi .ov-kpi-label")).toHaveText(["Monthly reviews", "Assignments received", "Qualifying content", "Finalized reviews"]);
  // Real values for this month: 3 reviews (draft, finalized, behind-finalized), 2 finalized; Assignments received = 2 (draft + finalized reviews carry one each).
  await expect(page.locator(".ov-kpis .ov-kpi .ov-kpi-value").nth(0)).toHaveText("3");
  await expect(page.locator(".ov-kpis .ov-kpi .ov-kpi-value").nth(1)).toHaveText("2");
  await expect(page.locator(".ov-kpis .ov-kpi .ov-kpi-value").nth(3)).toHaveText("2");
  await expect(page.locator(".ov-kpis .ov-kpi small").nth(0)).toHaveText("April 2015");
  await expect(page.locator(".ov-kpis .ov-kpi small").nth(2)).toHaveText("Requirement unavailable");

  // Two panel rows: top exactly 3 (4/4/4), bottom exactly 4 (3/3/3/3).
  const rows = page.locator(".ov-row");
  await expect(rows).toHaveCount(2);
  const top = rows.nth(0).locator(".ov-panel");
  const bottom = rows.nth(1).locator(".ov-panel");
  await expect(rows.nth(1)).toHaveClass(/ov-row-secondary/);
  await expect(top).toHaveCount(3);
  await expect(bottom).toHaveCount(4);
  await expect(top.locator(".ov-panel-head h2")).toHaveText(["Production Summary", "Submission Timeliness", "Performance Evidence"]);
  await expect(bottom.locator(".ov-panel-head h2")).toHaveText(["Review Lifecycle", "Needs Attention", "Recent Activity", "Quick Actions"]);
  for (let i = 0; i < 3; i += 1) expect(await top.nth(i).evaluate((el) => (el as HTMLElement).style.getPropertyValue("--ov-span"))).toBe("4");
  for (let i = 0; i < 4; i += 1) expect(await bottom.nth(i).evaluate((el) => (el as HTMLElement).style.getPropertyValue("--ov-span"))).toBe("3");
  // Spans are real grid widths: the three top panels are equal, as are the four bottom ones (12-column grid).
  const widths = async (loc: typeof top) => (await loc.evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().width))));
  const topWidths = await widths(top);
  const bottomWidths = await widths(bottom);
  expect(new Set(topWidths.map((w) => Math.round(w / 4))).size).toBe(1);
  expect(new Set(bottomWidths.map((w) => Math.round(w / 4))).size).toBe(1);
  expect(bottomWidths[0]).toBeLessThan(topWidths[0]!);
});

test("panel rows are the approved slots; Required is Unavailable without an Agreement policy; Stale/lifecycle come from stored evidence", async ({ page }) => {
  await page.goto(`/partner-reviews?month=${MONTH}`);
  const top = page.locator(".ov-row").nth(0).locator(".ov-panel");
  const bottom = page.locator(".ov-row").nth(1).locator(".ov-panel");

  // Production Summary (columns): Required / Under review / Approved / Completed assignments, Required = Unavailable (never 0).
  await expect(top.nth(0).locator(".ov-column-labels span")).toHaveText(["Required", "Under review", "Approved", "Completed assignments"]);
  await expect(top.nth(0).locator(".ov-col").first()).toHaveText("Unavailable");
  await expect(top.nth(0).locator(".ov-col").first().locator(".ov-column")).toHaveCount(0);

  // Submission Timeliness (donut): On time / Late.
  await expect(top.nth(1).locator(".ov-legend-item span").filter({ hasText: /^(On time|Late)$/ })).toHaveText(["On time", "Late"]);
  // Performance Evidence (donut): Available / Stale / Missing.
  await expect(top.nth(2).locator(".ov-legend-item span").filter({ hasText: /^(Available|Stale|Missing)$/ })).toHaveText(["Available", "Stale", "Missing"]);
  // Review Lifecycle (donut): Needs review / Draft / in review / Finalized - exclusive, candidate + behind-upstream review under Needs review.
  const lifecycle = bottom.nth(0).locator(".ov-legend-item");
  await expect(lifecycle).toHaveCount(3);
  await expect(lifecycle.nth(0)).toContainText("Needs review");
  await expect(lifecycle.nth(0).locator("b")).toHaveText("2");
  await expect(lifecycle.nth(1)).toContainText("Draft / in review");
  await expect(lifecycle.nth(1).locator("b")).toHaveText("1");
  await expect(lifecycle.nth(2)).toContainText("Finalized");
  await expect(lifecycle.nth(2).locator("b")).toHaveText("1");

  // Needs Attention: real non-zero categories only, each a real link into the filtered Workspace.
  const attention = bottom.nth(1).locator(".ov-attention-row");
  await expect(attention.filter({ hasText: "Review revision available" })).toHaveAttribute("href", `/partner-reviews/workspace?month=${MONTH}&signal=revision_available`);
  await expect(attention.filter({ hasText: "Draft reviews" })).toHaveAttribute("href", `/partner-reviews/workspace?filter=drafts&month=${MONTH}`);
  // Nothing forced: a category with a zero count is absent.
  await expect(attention.filter({ hasText: "Late submissions" })).toHaveCount(0);
  await expect(attention.filter({ hasText: "LFC/SFC rule unavailable" })).toHaveCount(0);

  // Recent Activity: Partner Review events only, Partner display names, review links, no opaque refs.
  const events = bottom.nth(2).locator(".ov-event");
  expect(await events.count()).toBeGreaterThan(0);
  expect(await events.count()).toBeLessThanOrEqual(6);
  const activityText = await bottom.nth(2).innerText();
  expect(activityText).toMatch(/Review (generated|finalized)|Submitted for review/);
  expect(activityText).toContain("E2E OV");
  expect(activityText).not.toMatch(/pr_[0-9a-f]{20}/);
  await expect(events.first()).toHaveAttribute("href", /^\/partner-reviews\/pr_[0-9a-f]{20}$/);

  // Quick Actions: the four approved destinations.
  await expect(bottom.nth(3).locator(".ov-action-grid a")).toHaveText(["Review queue", "Draft / in review", "Finalized history", "Open workspace"]);
});

test("Quick Actions open the real Workspace with the right filter and month (no placeholder dialogs)", async ({ page }) => {
  await page.goto(`/partner-reviews?month=${MONTH}`);
  const actions = page.locator(".ov-row").nth(1).locator(".ov-panel").nth(3).locator(".ov-action-grid a");

  await actions.filter({ hasText: "Review queue" }).click();
  await expect(page).toHaveURL(new RegExp(`/partner-reviews/workspace\\?filter=needs-review&month=${MONTH}$`));
  await expect(page.locator("h1")).toHaveText("Partner Reviews workspace");
  await expect(page.locator('.segment[aria-label="Review filter"] button.active')).toHaveText("Needs Review");

  await page.goto(`/partner-reviews?month=${MONTH}`);
  await page.locator(".ov-row").nth(1).locator(".ov-panel").nth(3).locator(".ov-action-grid a").filter({ hasText: "Draft / in review" }).click();
  await expect(page).toHaveURL(new RegExp(`filter=drafts&month=${MONTH}$`));
  await expect(page.locator('.segment[aria-label="Review filter"] button.active')).toHaveText("Drafts / In Review");

  await page.goto(`/partner-reviews?month=${MONTH}`);
  await page.locator(".ov-row").nth(1).locator(".ov-panel").nth(3).locator(".ov-action-grid a").filter({ hasText: "Finalized history" }).click();
  await expect(page).toHaveURL(new RegExp(`filter=finalized&month=${MONTH}$`));

  await page.goto(`/partner-reviews?month=${MONTH}`);
  await page.locator(".ov-row").nth(1).locator(".ov-panel").nth(3).locator(".ov-action-grid a").filter({ hasText: "Open workspace" }).click();
  await expect(page).toHaveURL(new RegExp(`/partner-reviews/workspace\\?month=${MONTH}$`));
  await expect(page.locator("dialog[open]")).toHaveCount(0);
});

test("a Needs Attention row opens the Workspace narrowed to that signal", async ({ page }) => {
  await page.goto(`/partner-reviews?month=${MONTH}`);
  await page.locator(".ov-attention-row").filter({ hasText: "Review revision available" }).click();
  await expect(page).toHaveURL(/signal=revision_available/);
  await expect(page.getByTestId("signal-chip")).toContainText("Review revision available");
  await expect(page.getByRole("table")).toContainText(NAMES.behind);
  await expect(page.getByRole("table")).not.toContainText(NAMES.draft);
});

test("the default month is the latest review month in scope (not the current calendar month) and an explicit month is never changed", async ({ page }) => {
  await page.goto("/partner-reviews");
  await expect(page.getByLabel("Reporting month")).toHaveValue(MONTH);
  await expect(page.getByTestId("month-source")).toHaveText("Latest review month");

  // A month with no data is used exactly as chosen: neutral states, never a zero-filled fake.
  await page.goto("/partner-reviews?month=2001-01");
  await expect(page.getByLabel("Reporting month")).toHaveValue("2001-01");
  await expect(page.locator(".ov-kpis .ov-kpi .ov-kpi-value").first()).toHaveText("0");
  await expect(page.locator(".ov-row").nth(0).locator(".ov-panel .ov-column-labels").first()).toContainText("Required");
  await expect(page.locator(".ov-row")).toHaveCount(2);
  await expect(page.locator(".ov-row").nth(0).locator(".ov-panel")).toHaveCount(3);
  await expect(page.locator(".ov-row").nth(1).locator(".ov-panel")).toHaveCount(4);

  // Garbage falls back to the default and says so.
  await page.goto("/partner-reviews?month=banana");
  await expect(page.getByText("not a valid YYYY-MM month").first()).toBeVisible();
  await expect(page.getByLabel("Reporting month")).toHaveValue(MONTH);

  // Choosing a month in the selector is real URL state.
  await page.goto(`/partner-reviews?month=${MONTH}`);
  const options = await page.getByLabel("Reporting month").locator("option").allTextContents();
  expect(options).toContain("April 2015");
});

test("canonical terminology; no blended score, rating or tier; no Finance controls", async ({ page }) => {
  await page.goto(`/partner-reviews?month=${MONTH}`);
  const text = await page.locator("main").innerText();
  for (const word of ["Creator", "Deliverable", "Productivity"]) expect(text, word).not.toContain(word);
  expect(text).not.toMatch(/\b(rating|ranking|tier|overall score|blended score|weighted)\b/i);
  expect(text).not.toMatch(/payable|invoice|payment/i);
  await expect(page.getByRole("button", { name: /payable|invoice|payment/i })).toHaveCount(0);
  // Performance is explicitly not a composite.
  await expect(page.getByText(/never a composite score/i).first()).toBeVisible();
});

for (const width of VIEWPORTS) {
  test(`Overview has no document-level horizontal overflow at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/partner-reviews?month=${MONTH}`);
    await expect(page.locator(".ov-kpis .ov-kpi")).toHaveCount(4);
    const { scrollWidth, innerWidth } = await noDocumentOverflow(page);
    expect(scrollWidth, `Overview overflows at ${width}px`).toBeLessThanOrEqual(innerWidth);
  });
}

test("a read-only Viewer sees the same Overview (no action controls exist on it)", async ({ page }) => {
  await signInAs(page, "viewer");
  await page.goto(`/partner-reviews?month=${MONTH}`);
  await expect(page.locator(".ov-kpis .ov-kpi")).toHaveCount(4);
  await expect(page.locator(".ov-kpis .ov-kpi .ov-kpi-value").nth(0)).toHaveText("3");
  await expect(page.getByRole("button", { name: /generate|finalize|refresh|submit/i })).toHaveCount(0);
});
