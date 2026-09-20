import { test, expect, type Page } from "@playwright/test";

import { partnerReviewsCollection } from "@/server/partner-reviews/firestore";
import { reviewRefFor } from "@/server/partner-reviews/period";

import { createFixtures, noDocumentOverflow, signInAs, VIEWPORTS } from "./helpers/partner-reviews-fixtures";

// Step 13B - the Partner-wise monthly productivity history (/partner-reviews/partner/[partnerId]) through the real UI
// on real emulator data. The golden master models no such page, so it is a NEW composition of accepted pieces.
//
// One Partner P with a long, deliberately gappy history (PAST months 2011-2012, private region):
//   2012-02  generated through the trusted services: Instagram views 3,000 + YouTube views 9,000 (the default month)
//   2012-01  finalized and REVISED (latestVersion 2)
//   2011-12  generated: Instagram 2,000 + YouTube 8,000
//   2011-11  Agreement-governed (policy-built snapshot) with a warning-only target
//   2011-10, 07, 06, 05, 04, 03  plain Draft reviews        2011-09  Assignment but NO review ("Needs review")
//   2011-08  nothing at all ("No review")                    2011-02, 2011-01  older reviews (beyond the 12-month window)
const fx = createFixtures("e2e13bph");
const NAME = "E2E PH Aurora";
const HIDDEN_NAME = "E2E PH Hidden Person";

let partnerRef = "";
let hiddenRef = "";
const url = (query = "") => `/partner-reviews/partner/${partnerRef}${query}`;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  await fx.grantFixtureRegion();
  const partner = await fx.seedPartner({ displayName: NAME });
  partnerRef = partner.partnerRef;

  // Real evidence + trusted generation for 2012-02 and 2011-12 (Instagram AND YouTube, kept separate).
  for (const [month, ig, yt] of [
    ["2012-02", 3000, 9000],
    ["2011-12", 2000, 8000],
  ] as const) {
    const assignment = await fx.seedAssignment(partner.partnerRef, { dueAt: `${month}-10` });
    const thread = await fx.seedThread(assignment, { month, status: "APPROVED", approvedAt: `${month}-09T00:00:00.000Z` });
    await fx.seedAnalytics(partner.partnerRef, { contentRef: thread.contentRef, platform: "instagram", likes: 10, views: ig, month });
    await fx.seedAnalytics(partner.partnerRef, { contentRef: null, platform: "youtube", likes: null, views: yt, month });
    await fx.generate(partner.partnerRef, month);
  }

  // Direct, schema-valid reviews (cheap long history).
  await fx.seedDirectReview(partner, "2012-01", { status: "FINALIZED", latestVersion: 2 });
  await fx.seedDirectReview(partner, "2011-11", {
    status: "DRAFT",
    policy: {
      agreementRef: "agr-e2e-ph",
      agreementVersion: 2,
      monthlyDeliverableRequirement: { requiredCount: 3, qualifyingUnit: "approved_content_thread" },
      targets: [{ targetRef: "t-reach", metricId: "reach", targetValue: 100, unit: "count", comparison: "at_least" }],
    },
  });
  for (const month of ["2011-10", "2011-07", "2011-06", "2011-05", "2011-04", "2011-03", "2011-02", "2011-01"]) await fx.seedDirectReview(partner, month, { status: "DRAFT" });
  // 2011-09: in-period Assignment, no review.
  await fx.seedAssignment(partner.partnerRef, { dueAt: "2011-09-15" });

  const hidden = await fx.seedPartner({ displayName: HIDDEN_NAME, regionIds: [fx.hiddenRegion] });
  hiddenRef = hidden.partnerRef;
  await fx.seedDirectReview(hidden, "2012-02", { status: "DRAFT" });
});

test.afterAll(async () => {
  await fx.cleanupAll();
});

const tab = (page: Page, name: string) => page.getByRole("tab", { name, exact: true });
const rows = (page: Page) => page.locator("table tbody tr");

test("header: Partner, 'Monthly productivity history', latest review month as the default (not the calendar month), Open monthly review", async ({ page }) => {
  await signInAs(page, "manager");
  await page.goto(url());
  await expect(page.locator("h1")).toHaveText(NAME);
  await expect(page.locator(".head")).toContainText("Monthly productivity history");
  await expect(page.locator(".head .eyebrow")).toHaveText("PARTNER REVIEWS / PARTNER HISTORY");
  const context = page.locator(".detailcontext");
  await expect(context).toContainText("Latest review month");
  await expect(context).toContainText("February 2012");
  await expect(context).toContainText("Selected month");
  await expect(context).toContainText("Latest review month");
  await expect(context).toContainText("Evidence freshness");
  await expect(page.getByLabel("Reporting month")).toHaveValue("2012-02");
  await expect(page.getByTestId("month-source")).toHaveText("Latest review month");
  const open = page.getByRole("link", { name: "Open monthly review" });
  await expect(open).toHaveAttribute("href", `/partner-reviews/${reviewRefFor(partnerRef, "2012-02")}`);
  // Partner context / no second sidebar; local tabs in the specified order.
  await expect(page.locator('.workflow[role="tablist"] [role="tab"]')).toHaveText(["Monthly Trend", "Production", "Compliance", "Performance", "Commercial Evidence", "Review History"]);
  await expect(tab(page, "Monthly Trend")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("aside.sidebar, nav.sidebar")).toHaveCount(1);
});

test("Monthly Trend: a bounded 12-month window, newest first; a month with no review reads 'No review' / 'Needs review' - never zero", async ({ page }) => {
  await signInAs(page, "manager");
  await page.goto(url());
  await expect(rows(page)).toHaveCount(12);
  await expect(rows(page).first().locator("td").first()).toHaveText("February 2012");
  await expect(rows(page).last().locator("td").first()).toHaveText("March 2011");
  // The window is exactly Mar 2011 .. Feb 2012; Jan/Feb 2011 are older.
  await expect(page.locator("table")).not.toContainText("January 2011");

  const gap = rows(page).filter({ hasText: "August 2011" });
  await expect(gap).toContainText("No review");
  const needs = rows(page).filter({ hasText: "September 2011" });
  await expect(needs).toContainText("Needs review");
  await expect(needs).toContainText("1 Assignment found");
  for (const row of [gap, needs]) {
    // Exactly the month label, the state and its note - no numeric cell at all.
    const cells = await row.locator("td").allInnerTexts();
    expect(cells.slice(1).join(" ")).not.toMatch(/\b0\b/);
  }

  // Each real month keeps its facts SEPARATE: lifecycle, qualifying content, required, on time/late, freshness, targets, version.
  const feb = rows(page).filter({ hasText: "February 2012" });
  await expect(feb).toContainText("Draft");
  await expect(feb).toContainText("v1");
  const jan = rows(page).filter({ hasText: "January 2012" });
  await expect(jan).toContainText("Finalized");
  await expect(jan).toContainText("revised");
  await expect(page.getByText(/there is no overall score or blended line/)).toBeVisible();

  // Older months are reachable, still bounded.
  await page.getByRole("link", { name: "Show older months" }).click();
  await expect(page).toHaveURL(/until=2011-02/);
  await expect(rows(page)).toHaveCount(12);
  await expect(rows(page).first().locator("td").first()).toHaveText("February 2011");
  await expect(rows(page).filter({ hasText: "January 2011" })).toContainText("Draft");
  await page.getByRole("link", { name: "Back to the latest months" }).click();
  await expect(page).not.toHaveURL(/until=/);
});

test("Production and Compliance sections are month-wise history tables", async ({ page }) => {
  await signInAs(page, "manager");
  await page.goto(url());
  await tab(page, "Production").click();
  await expect(page).toHaveURL(/tab=production/);
  await expect(page.locator("table thead")).toContainText("Required");
  await expect(page.locator("table thead")).toContainText("Actual qualifying");
  await expect(page.locator("table thead")).toContainText("Completed assignments");
  await expect(page.locator("table thead")).toContainText("Approved Content");
  await expect(page.locator("table thead")).toContainText("Under review");
  await expect(page.locator("table thead")).toContainText("LFC / SFC");
  await expect(rows(page)).toHaveCount(12);
  // Without an Agreement the requirement is Unavailable (a dash that announces itself), never a zero.
  const feb = rows(page).filter({ hasText: "February 2012" });
  await expect(feb.locator('[role="img"][aria-label="Unavailable"]').first()).toBeVisible();
  // The governed month shows its Agreement requirement.
  await expect(rows(page).filter({ hasText: "November 2011" })).toContainText("3");

  await tab(page, "Compliance").click();
  await expect(page.locator("table thead")).toContainText("On time");
  await expect(page.locator("table thead")).toContainText("Late");
  await expect(page.locator("table thead")).toContainText("Unknown timing");
  await expect(page.locator("table thead")).toContainText("Revision requests");
  await expect(page.locator("table thead")).toContainText("Missing / incomplete work");
  await expect(rows(page)).toHaveCount(12);
  await expect(page.getByText("unknown timing is never counted as late")).toBeVisible();
});

test("Performance keeps Instagram and YouTube separate: own panels, own tables, no combined figure, gaps stay gaps", async ({ page }) => {
  await signInAs(page, "manager");
  await page.goto(url("?tab=performance"));
  await expect(page.getByRole("heading", { name: "Instagram performance" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "YouTube performance" })).toBeVisible();
  const tables = page.locator("table");
  await expect(tables).toHaveCount(2);
  const instagram = await tables.nth(0).innerText();
  const youtube = await tables.nth(1).innerText();
  expect(instagram).toContain("3,000");
  expect(instagram).toContain("2,000");
  expect(instagram).not.toContain("9,000");
  expect(youtube).toContain("9,000");
  expect(youtube).toContain("8,000");
  expect(youtube).not.toContain("3,000");
  const all = await page.locator("main").innerText();
  expect(all).not.toContain("12,000");
  expect(all).not.toContain("17,000");
  // Real 12D trend charts (two months of native values each), every value also present as text.
  await expect(page.locator(".ov-trend-grid")).toHaveCount(2);
  // Native columns are labelled; engagement is source-reported only; follower snapshots are counted per account, never summed.
  await expect(tables.nth(0).locator("thead")).toContainText("Engagement (source-reported)");
  await expect(tables.nth(0).locator("thead")).toContainText("Follower snapshots");
  await expect(page.getByText(/Reach is unavailable unless a verified source supplies it/)).toBeVisible();
  // A month without a review is a state, not a zero, in the platform tables too.
  await expect(tables.nth(0).locator("tbody tr").filter({ hasText: "August 2011" })).toContainText("No review");
});

test("Commercial Evidence: Agreement ref/version, required vs actual, 'Used as commercial evidence', warning-only targets, revised months preserved", async ({ page }) => {
  await signInAs(page, "head");
  await page.goto(url("?tab=commercial"));
  await expect(rows(page)).toHaveCount(12);
  const governed = rows(page).filter({ hasText: "November 2011" });
  await expect(governed).toContainText("agr-e2e-ph · version 2");
  await expect(governed).toContainText("Required 3");
  await expect(governed).toContainText("Actual:");
  await expect(governed).toContainText("Used as commercial evidence");
  await expect(governed).toContainText("Target monitoring only · does not affect payment");
  await expect(governed).toContainText("0 met · 0 not met · 1 unavailable");
  // Ungoverned months: everything Unavailable, no label claiming payment-affecting evidence.
  const plain = rows(page).filter({ hasText: "October 2011" });
  await expect(plain).toContainText("Unavailable · none governs");
  await expect(plain).not.toContainText("Used as commercial evidence");
  // A revised month says so and points at the preserved earlier versions.
  const revised = rows(page).filter({ hasText: "January 2012" });
  await expect(revised).toContainText("Revised · 1 revision");
  await expect(revised).toContainText("Earlier versions are preserved");
  // No money anywhere.
  const text = await page.locator("main").innerText();
  expect(text).not.toMatch(/₹|\bINR\b|\bUSD\b|payable|invoice/i);
});

test("Review History: chronological monthly table with the required columns; Open review opens the right review", async ({ page }) => {
  await signInAs(page, "manager");
  await page.goto(url("?tab=history"));
  const head = page.locator("table thead");
  for (const column of ["Month", "Current version", "Lifecycle", "Freshness", "Finalized", "Revisions", "Commercial evidence", "Warning-only targets"]) await expect(head).toContainText(column);
  await expect(rows(page)).toHaveCount(12);
  const jan = rows(page).filter({ hasText: "January 2012" });
  await expect(jan).toContainText("Version 2");
  await expect(jan).toContainText("Finalized");
  await expect(jan.locator("td").nth(5)).toHaveText("1");
  await expect(rows(page).filter({ hasText: "August 2011" })).toContainText("No review");
  await expect(rows(page).filter({ hasText: "August 2011" }).getByRole("link", { name: "Select August 2011" })).toBeVisible();

  // Open review -> the correct monthly review, versioned detail.
  await rows(page).filter({ hasText: "December 2011" }).getByRole("link", { name: "Open review for December 2011" }).click();
  await expect(page).toHaveURL(new RegExp(`/partner-reviews/${reviewRefFor(partnerRef, "2011-12")}$`));
  await expect(page.locator("h1")).toHaveText(`${NAME} · December 2011`);
  // ...and the Partner context leads back to the history.
  await page.getByRole("link", { name: "Partner history" }).click();
  await expect(page).toHaveURL(new RegExp(`/partner-reviews/partner/${partnerRef}\\?month=2011-12`));
  await expect(page.getByLabel("Reporting month")).toHaveValue("2011-12");
});

test("the selected month drives the header block: 'No review' / 'Needs review' offer Generate Review, which is idempotent and creates ONE Draft", async ({ page }) => {
  await signInAs(page, "manager");
  await page.goto(url("?month=2011-08"));
  await expect(page.getByLabel("Reporting month")).toHaveValue("2011-08");
  await expect(page.getByTestId("month-source")).toHaveText("Selected month");
  await expect(page.getByRole("status").filter({ hasText: "no in-period Assignments were found" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open monthly review" })).toHaveCount(0);
  const generate = page.getByRole("button", { name: "Generate Review" });
  await expect(generate).toBeVisible();

  await generate.dblclick();
  await expect(page.getByRole("link", { name: "Open monthly review" })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Draft review generated for August 2011" })).toBeVisible();
  const ref = reviewRefFor(partnerRef, "2011-08");
  const head = await partnerReviewsCollection().doc(ref).get();
  expect(head.exists).toBe(true);
  expect(head.data()!.latestStatus).toBe("DRAFT");
  expect(head.data()!.latestVersion).toBe(1);
  // The bounded history re-reads: August 2011 is now a real Draft review.
  await page.getByRole("tab", { name: "Review History" }).click();
  await expect(rows(page).filter({ hasText: "August 2011" })).toContainText("Draft");
  await page.getByRole("link", { name: "Open monthly review" }).click();
  await expect(page).toHaveURL(new RegExp(`/partner-reviews/${ref}$`));
  await expect(page.locator(".detailcontext")).toContainText("Version 1 of 1");

  // Needs review month: same Generate Review affordance, with its in-period Assignment count.
  await page.goto(url("?month=2011-09"));
  await expect(page.getByRole("status").filter({ hasText: "1 in-period Assignment and no review yet" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Generate Review" })).toBeVisible();
});

test("a Viewer is read-only: history reads, no Generate Review, and an explicit read-only note", async ({ page }) => {
  await signInAs(page, "viewer");
  await page.goto(url("?month=2011-09"));
  await expect(page.locator("h1")).toHaveText(NAME);
  await expect(page.getByRole("button", { name: "Generate Review" })).toHaveCount(0);
  await expect(page.getByText("You have read-only access.")).toBeVisible();
  await page.goto(url());
  await expect(page.getByRole("link", { name: "Open monthly review" })).toBeVisible();
});

test("direct route requires the Partner's live scope: an out-of-scope Partner and an unknown one render the identical neutral access-denied page", async ({ page }) => {
  await signInAs(page, "manager");
  const denied = await page.goto(`/partner-reviews/partner/${hiddenRef}`);
  expect(denied?.ok()).toBeTruthy();
  await expect(page.getByRole("heading", { name: "Access denied" })).toBeVisible();
  const deniedText = await page.locator("main").innerText();
  expect(deniedText).not.toContain(HIDDEN_NAME);
  await page.goto("/partner-reviews/partner/does-not-exist");
  await expect(page.getByRole("heading", { name: "Access denied" })).toBeVisible();
  expect(await page.locator("main").innerText()).toBe(deniedText);
  // The global actor reaches it.
  await signInAs(page, "admin");
  await page.goto(`/partner-reviews/partner/${hiddenRef}`);
  await expect(page.locator("h1")).toHaveText(HIDDEN_NAME);
});

test("Partner detail (Context tab) links to Partner Reviews for an actor who may open it", async ({ page }) => {
  await page.goto(`/partners/${partnerRef}`);
  await page.getByRole("tab", { name: "Context" }).click();
  await expect(page.getByRole("heading", { name: "Partner Reviews" })).toBeVisible();
  await page.getByRole("link", { name: "Open Partner Reviews" }).click();
  await expect(page).toHaveURL(new RegExp(`/partner-reviews/partner/${partnerRef}$`));
  await expect(page.locator("h1")).toHaveText(NAME);
});

test("canonical terminology; no blended score; no Finance controls", async ({ page }) => {
  await signInAs(page, "manager");
  for (const tabName of ["trend", "production", "compliance", "performance", "commercial", "history"]) {
    await page.goto(url(`?tab=${tabName}`));
    const text = (await page.locator("main").innerText()).replace(/Monthly productivity history/g, "").replace(/\b(?:no|never)\s+(?:[a-z-]+\s+){0,3}(?:score|blended line)\b/gi, "");
    expect(text, tabName).not.toMatch(/\b(Creator|Deliverable|Productivity)\b/);
    expect(text, tabName).not.toMatch(/\b(score|rating|tier|ranking)\b/i);
    expect(text, tabName).not.toMatch(/payable|invoice|₹/i);
  }
});

for (const width of VIEWPORTS) {
  test(`Partner-wise page has no document-level horizontal overflow at ${width}px; local tabs stay usable`, async ({ page }) => {
    await signInAs(page, "manager");
    await page.setViewportSize({ width, height: 900 });
    await page.goto(url());
    for (const name of ["Monthly Trend", "Production", "Compliance", "Performance", "Commercial Evidence", "Review History"]) {
      await tab(page, name).click();
      await expect(tab(page, name)).toHaveAttribute("aria-selected", "true");
      await tab(page, name).scrollIntoViewIfNeeded();
      const box = await tab(page, name).boundingBox();
      expect(box, `${name} tab has a box at ${width}px`).not.toBeNull();
      expect(box!.x + box!.width, `${name} tab is inside the viewport at ${width}px`).toBeLessThanOrEqual(width + 1);
      const { scrollWidth, innerWidth } = await noDocumentOverflow(page);
      expect(scrollWidth, `${name} overflows at ${width}px`).toBeLessThanOrEqual(innerWidth);
    }
  });
}
