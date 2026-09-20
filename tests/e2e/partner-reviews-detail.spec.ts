import { test, expect, type Page } from "@playwright/test";

import { partnerReviewVersionsCollection } from "@/server/partner-reviews/firestore";

import { createFixtures, noDocumentOverflow, signInAs, VIEWPORTS } from "./helpers/partner-reviews-fixtures";

// Step 13B - the Review Detail (/partner-reviews/[reviewRef]) through the real UI on real emulator data. Reviews are
// created through the TRUSTED services under a private region (month 2013-04 belongs to this spec alone); each flow
// signs in as the seeded identity that owns it (Manager prepares, Head finalizes; Viewer/Analyst are read-only).
const fx = createFixtures("e2e13bdt");
const MONTH = "2013-04";
const NAME = { a: "E2E DT Alpha", b: "E2E DT Bravo", c: "E2E DT Charlie", d: "E2E DT Delta", e: "E2E DT Echo" };

let refA = "";
let refB = "";
let refC = "";
let refD = "";
let refE = "";
let partnerB = "";
let partnerC = "";
const IN_CAMPAIGN = "E2E DT Campaign IN";
const OUT_CAMPAIGN = "E2E DT Campaign OUT-SECRET";
const OUT_URL = "https://instagram.com/p/e2e-dt-out-secret-url";

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  await fx.grantFixtureRegion();
  // A: Draft prepared by the Manager (real Assignment + Content + Analytics evidence).
  const a = await fx.seedRich({ month: MONTH, displayName: NAME.a, threadStatus: "APPROVED", views: 4000 });
  refA = (await fx.generate(a.partner.partnerRef, MONTH)).head.reviewRef;
  // B: In Review, then upstream changes (a new Analytics record) => finalize must say "Refresh required".
  const b = await fx.seedRich({ month: MONTH, displayName: NAME.b });
  partnerB = b.partner.partnerRef;
  refB = (await fx.generateInReview(b.partner.partnerRef, MONTH)).reviewRef;
  await fx.seedAnalytics(b.partner.partnerRef, { contentRef: null, likes: 7, month: MONTH });
  // C: Finalized, then upstream changes => "revision available".
  const c = await fx.seedRich({ month: MONTH, displayName: NAME.c, threadStatus: "APPROVED" });
  partnerC = c.partner.partnerRef;
  refC = (await fx.generateFinalized(c.partner.partnerRef, MONTH)).reviewRef;
  await fx.seedAnalytics(c.partner.partnerRef, { contentRef: null, likes: 9, month: MONTH });
  // D: an Agreement-governed month with warning-only targets (snapshot built by the accepted pure builder from a policy).
  const d = await fx.seedPartner({ displayName: NAME.d });
  refD = (
    await fx.seedDirectReview(d, MONTH, {
      status: "DRAFT",
      policy: {
        agreementRef: "agr-e2e-dt",
        agreementVersion: 4,
        monthlyDeliverableRequirement: { requiredCount: 2, qualifyingUnit: "approved_content_thread" },
        lfcSfcRule: { ruleRef: "rule-e2e-dt", byFormat: { reel: "SFC" }, affectsPayment: true },
        targets: [
          { targetRef: "t-reach", metricId: "reach", targetValue: 500, unit: "count", comparison: "at_least" },
          { targetRef: "t-growth", metricId: "followerGrowth", targetValue: 50, unit: "count", comparison: "at_least" },
        ],
      },
    })
  ).reviewRef;
  // E: redaction fixture - one in-scope and one out-of-scope Campaign/Assignment/Content/Analytics under the same Partner.
  const e = await fx.seedPartner({ displayName: NAME.e });
  const campIn = await fx.seedCampaign(IN_CAMPAIGN, [fx.region]);
  const campOut = await fx.seedCampaign(OUT_CAMPAIGN, [fx.hiddenRegion]);
  const a1 = await fx.seedAssignment(e.partnerRef, { dueAt: `${MONTH}-10`, regionIds: [fx.region], campaignRef: campIn.campaignRef, campaignName: IN_CAMPAIGN });
  const t1 = await fx.seedThread(a1, { month: MONTH, regionIds: [fx.region] });
  await fx.seedAnalytics(e.partnerRef, { contentRef: t1.contentRef, likes: 11, month: MONTH, regionIds: [fx.region] });
  const a2 = await fx.seedAssignment(e.partnerRef, { dueAt: `${MONTH}-12`, regionIds: [fx.hiddenRegion], campaignRef: campOut.campaignRef, campaignName: OUT_CAMPAIGN });
  const t2 = await fx.seedThread(a2, { month: MONTH, regionIds: [fx.hiddenRegion], url: OUT_URL });
  await fx.seedAnalytics(e.partnerRef, { contentRef: t2.contentRef, likes: 22, month: MONTH, regionIds: [fx.hiddenRegion], postUrl: OUT_URL });
  refE = (await fx.generate(e.partnerRef, MONTH, "admin")).head.reviewRef;
});

test.afterAll(async () => {
  await fx.cleanupAll();
});

const open = async (page: Page, reviewRef: string, query = "") => {
  await page.goto(`/partner-reviews/${reviewRef}${query}`);
  await expect(page.locator("h1")).toBeVisible();
};
const tab = (page: Page, name: string) => page.getByRole("tab", { name, exact: true });
// A `.kv` row by its exact label (the label is the row's first span).
const kv = (page: Page, label: string) => page.locator(".kv").filter({ has: page.locator("span:first-child", { hasText: new RegExp(`^${label}$`) }) });
const pill = (page: Page) => page.locator(".detailcontext .pill").first();

test("header, context strip and local tabs follow the accepted Detail pattern (no second sidebar)", async ({ page }) => {
  await signInAs(page, "manager");
  await open(page, refA);
  await expect(page.locator("h1")).toHaveText(`${NAME.a} · April 2013`);
  await expect(page.locator(".head .eyebrow")).toHaveText("PARTNER REVIEWS / MONTHLY REVIEW");
  await expect(page.locator(".detailcontext > div")).toHaveCount(4);
  await expect(page.locator(".detailcontext")).toContainText("Version 1 of 1");
  await expect(pill(page)).toHaveText("Draft");
  await expect(page.locator(".detailcontext")).toContainText("Freshness");
  await expect(page.locator(".detailcontext")).toContainText("Evidence cutoff");
  // Local tabs, in order; exactly one global sidebar.
  await expect(page.locator('.workflow[role="tablist"] [role="tab"]')).toHaveText(["Overview", "Production", "Compliance", "Performance", "Version History"]);
  await expect(tab(page, "Overview")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("aside.sidebar, nav.sidebar")).toHaveCount(1);
  // Partner context + navigation links.
  await expect(page.getByRole("link", { name: "Partner history" })).toHaveAttribute("href", /\/partner-reviews\/partner\/.+\?month=2013-04$/);
  await expect(page.getByRole("link", { name: "Back to workspace" })).toHaveAttribute("href", `/partner-reviews/workspace?month=${MONTH}`);
});

test("tabs are URL state (?tab=) and keyboard-selectable; an unknown tab falls back to Overview", async ({ page }) => {
  await signInAs(page, "manager");
  await open(page, refA, "?tab=performance");
  await expect(tab(page, "Performance")).toHaveAttribute("aria-selected", "true");
  await tab(page, "Compliance").click();
  await expect(page).toHaveURL(/tab=compliance/);
  await tab(page, "Overview").click();
  await expect(page).not.toHaveURL(/tab=/);
  await open(page, refA, "?tab=finance");
  await expect(tab(page, "Overview")).toHaveAttribute("aria-selected", "true");
});

test("Manager: Refresh evidence and Submit for review work, and there is NO Finalize control", async ({ page }) => {
  await signInAs(page, "manager");
  await open(page, refA);
  await expect(page.getByRole("button", { name: "Refresh evidence" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Submit for review" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Finalize", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Create revision" })).toHaveCount(0);

  await page.getByRole("button", { name: "Refresh evidence" }).click();
  await expect(page.getByText("Evidence refreshed.")).toBeVisible();
  await expect(pill(page)).toHaveText("Draft");

  await page.getByRole("button", { name: "Submit for review" }).click();
  await expect(page.getByText("Submitted for review.")).toBeVisible();
  await expect(pill(page)).toHaveText("In review");
  // Submitted: the Manager can still refresh, can never finalize.
  await expect(page.getByRole("button", { name: "Submit for review" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Finalize", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Refresh evidence" })).toBeVisible();
});

test("Head: Finalize asks for confirmation - Escape closes the dialog and restores focus - confirming finalizes", async ({ page }) => {
  await signInAs(page, "head");
  await open(page, refA);
  const finalize = page.getByRole("button", { name: "Finalize", exact: true });
  await expect(finalize).toBeVisible();
  await finalize.focus();
  await page.keyboard.press("Enter");
  const dialog = page.locator("dialog[open]");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Finalize this review?" })).toBeVisible();
  await expect(dialog).toContainText("Finalizing never refreshes evidence");
  // Focus is inside the modal; Escape closes it and focus returns to the trigger.
  await page.keyboard.press("Escape");
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  await expect(finalize).toBeFocused();
  await expect(pill(page)).toHaveText("In review");

  await finalize.click();
  await page.locator("dialog[open]").getByRole("button", { name: "Finalize review" }).click();
  await expect(page.getByText("Review finalized.")).toBeVisible();
  await expect(pill(page)).toHaveText("Finalized");
  await expect(page.locator(".detailcontext")).toContainText("Current finalized version");
  await expect(page.getByRole("button", { name: "Finalize", exact: true })).toHaveCount(0);
  await expect(page.getByText("This finalized version is current and immutable.")).toBeVisible();
});

test("stale evidence: Finalize says 'Refresh required' (never auto-refreshes); an explicit refresh, then finalize, succeeds", async ({ page }) => {
  await signInAs(page, "head");
  await open(page, refB);
  await expect(pill(page)).toHaveText("In review");
  await expect(page.locator(".detailcontext")).toContainText("Refresh available");
  const before = (await partnerReviewVersionsCollection(refB).doc("1").get()).data()!;

  await page.getByRole("button", { name: "Finalize", exact: true }).click();
  await page.locator("dialog[open]").getByRole("button", { name: "Finalize review" }).click();
  const alert = page.getByRole("alert").filter({ hasText: "Refresh required" });
  await expect(alert).toBeVisible();
  await expect(alert).toContainText("Finalize never refreshes on its own");
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  // NOTHING was refreshed or written by the rejected finalize.
  await expect(pill(page)).toHaveText("In review");
  const after = (await partnerReviewVersionsCollection(refB).doc("1").get()).data()!;
  expect(after.docVersion).toBe(before.docVersion);
  expect(after.sourceFingerprint).toBe(before.sourceFingerprint);
  expect(after.status).toBe("IN_REVIEW");

  await alert.getByRole("button", { name: "Refresh evidence" }).click();
  await expect(page.getByText("Evidence refreshed.")).toBeVisible();
  await expect(page.getByRole("alert").filter({ hasText: "Refresh required" })).toHaveCount(0);
  await expect(page.locator(".detailcontext")).not.toContainText("Refresh available");

  await page.getByRole("button", { name: "Finalize", exact: true }).click();
  await page.locator("dialog[open]").getByRole("button", { name: "Finalize review" }).click();
  await expect(page.getByText("Review finalized.")).toBeVisible();
  await expect(pill(page)).toHaveText("Finalized");
  void partnerB;
});

test("a stale write (the review changed elsewhere) is reported with a Reload action, never silently overwritten", async ({ page }) => {
  await signInAs(page, "manager");
  const b = await fx.seedRich({ month: MONTH, displayName: "E2E DT Stale Write" });
  const ref = (await fx.generate(b.partner.partnerRef, MONTH)).head.reviewRef;
  await open(page, ref);
  // Someone else refreshes it after this page loaded (docVersion moves on).
  const v = (await partnerReviewVersionsCollection(ref).doc("1").get()).data()!;
  await fx.submit(ref, v.docVersion);
  await page.getByRole("button", { name: "Submit for review" }).click();
  const alert = page.getByRole("alert").filter({ hasText: "This review changed elsewhere" });
  await expect(alert).toBeVisible();
  await alert.getByRole("button", { name: "Reload review" }).click();
  await expect(page.getByText("Reloaded the latest version of this review.")).toBeVisible();
  await expect(pill(page)).toHaveText("In review");
});

test("revision: Create revision starts a new Draft; the finalized version stays current until the replacement is finalized, then reads 'Superseded by version 2' and stays viewable", async ({ page }) => {
  await signInAs(page, "manager");
  await open(page, refC);
  await expect(pill(page)).toHaveText("Finalized");
  await expect(page.locator(".detailcontext")).toContainText("Revision available");
  await expect(page.getByRole("button", { name: "Finalize", exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "Create revision" }).click();
  const dialog = page.locator("dialog[open]");
  await expect(dialog.getByRole("heading", { name: "Create a revision?" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Create revision" })).toBeFocused();
  await page.getByRole("button", { name: "Create revision" }).click();
  await page.locator("dialog[open]").getByRole("button", { name: "Create revision" }).click();
  await expect(page.getByText(/Revision created as a new Draft/)).toBeVisible();
  await expect(pill(page)).toHaveText("Draft");
  await expect(page.locator(".detailcontext")).toContainText("Version 2 of 2");

  // Version History: v2 open Draft, v1 still the current finalized version.
  await tab(page, "Version History").click();
  const rows = page.locator("table tbody tr");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("Version 2");
  await expect(rows.nth(0)).toContainText("Open version");
  await expect(rows.nth(1)).toContainText("Version 1");
  await expect(rows.nth(1)).toContainText("Current finalized version");
  // No second revision can be started while one is open.
  await expect(page.getByRole("button", { name: "Create revision" })).toHaveCount(0);

  // Finish v2 through the trusted services (Manager submits, Head finalizes) - the replacement supersedes v1.
  const v2 = (await partnerReviewVersionsCollection(refC).doc("2").get()).data()!;
  const submitted = await fx.submit(refC, v2.docVersion);
  await fx.finalize(refC, submitted.selectedVersion!.docVersion);

  await open(page, refC, "?tab=history");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("Current finalized version");
  await expect(rows.nth(1)).toContainText("Superseded by version 2");
  await expect(rows.nth(1)).toContainText("Historical · not compared");

  // The superseded version stays readable and immutable.
  await rows.nth(1).getByRole("button", { name: "View version 1" }).click();
  await expect(page.locator(".detailcontext")).toContainText("Version 1 of 2");
  await expect(page.locator(".detailcontext")).toContainText("Superseded by version 2");
  await expect(page.locator(".detailcontext")).toContainText("Historical version · read only");
  await expect(page.getByText("Historical versions are immutable.")).toBeVisible();
  await expect(page.getByRole("button", { name: /Refresh evidence|Submit for review|Finalize|Create revision/ })).toHaveCount(0);
  await expect(page).toHaveURL(/version=1/);
  // Deep link to the old version works, an unknown version falls back and says so.
  await open(page, refC, "?version=1");
  await expect(page.locator(".detailcontext")).toContainText("Version 1 of 2");
  await open(page, refC, "?version=9");
  await expect(page.getByText("This review has no such version")).toBeVisible();
  await expect(page.locator(".detailcontext")).toContainText("Version 2 of 2");
  void partnerC;
});

test("Overview / Production / Compliance / Performance carry independent evidence, with Unavailable states and no score", async ({ page }) => {
  // (default pre-authed Super Admin: the fixture Campaign documents are not scoped for the seeded non-global identities)
  await open(page, refA);
  // Overview: three independent summaries + commercial evidence, no Agreement => everything Unavailable, never zero.
  await expect(page.getByRole("heading", { name: "Production" }).first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Compliance" }).first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Performance" }).first()).toBeVisible();
  await expect(page.getByText("Monthly commercial evidence")).toBeVisible();
  await expect(page.getByText("No Agreement governs this Partner-month")).toBeVisible();
  await expect(kv(page, "Required qualifying content")).toContainText("Unavailable");
  await expect(kv(page, "LFC / SFC evidence")).toContainText("Unavailable");
  await expect(page.getByText("No Agreement target applies to this Partner-month.")).toBeVisible();
  await expect(page.getByText("Used as commercial evidence")).toHaveCount(0);

  await tab(page, "Production").click();
  await expect(page.getByRole("heading", { name: "Production evidence" })).toBeVisible();
  await expect(kv(page, "Assignments included")).toContainText("1");
  await expect(kv(page, "Monthly required qualifying content")).toContainText("Unavailable");
  const production = page.locator("table").first();
  await expect(production).toContainText("Assignment 1");
  await expect(production).toContainText("e2e13bdt Campaign");
  await expect(production).toContainText("APPROVED");
  await expect(production).toContainText("1 submitted link");

  await tab(page, "Compliance").click();
  await expect(page.getByRole("heading", { name: "Compliance evidence" })).toBeVisible();
  await expect(page.getByText("unknown timing is never late")).toBeVisible();
  await expect(kv(page, "Submitted on time")).toContainText("1");
  await expect(page.locator("table").first()).toContainText("Submitted before due");
  await expect(page.locator("table").first()).toContainText("Yes");

  await tab(page, "Performance").click();
  await expect(page.getByRole("heading", { name: "Performance evidence" })).toBeVisible();
  const perf = page.locator("table").first();
  await expect(perf).toContainText("Instagram");
  await expect(perf).toContainText("4,000");
  await expect(perf).toContainText("Engagement (source-reported)");
  await expect(page.getByText("Follower growth needs at least two comparable verified snapshots.")).toBeVisible();
  await expect(page.getByText("Reach", { exact: false }).first()).toBeVisible();
  await expect(page.getByText(/Not available from any verified source/)).toBeVisible();
  await expect(page.getByText(/Reach · Impressions/)).toBeVisible();
  // No score-shaped label exists on any tab.
  const text = (await page.locator("main").innerText()).replace(/\b(?:no|never|not a)\s+(?:[a-z-]+\s+)?scor(?:e|ed)\b/gi, "");
  expect(text).not.toMatch(/\b(score|scored|rating|tier|rank|ranking)\b/i);
});

test("Agreement-governed evidence is labelled 'Used as commercial evidence'; targets are warning-only ('does not affect payment'); unsupported / unjudgeable targets read Unavailable, never Not met", async ({ page }) => {
  await signInAs(page, "head");
  await open(page, refD);
  await expect(page.getByText("Monthly commercial evidence")).toBeVisible();
  await expect(kv(page, "Governing Agreement")).toContainText("agr-e2e-dt");
  await expect(kv(page, "Governing Agreement")).toContainText("version 4");
  await expect(kv(page, "Required qualifying content")).toContainText("2");
  await expect(page.getByText("Used as commercial evidence")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Payment-affecting evidence" })).toBeVisible();

  const targets = page.locator("table").filter({ hasText: "Target value" });
  await expect(targets.locator("tbody tr")).toHaveCount(2);
  // (sorted by target ref: growth, then reach)
  await expect(targets.locator("tbody tr").nth(0)).toContainText("Follower growth");
  await expect(targets.locator("tbody tr").nth(0)).toContainText("Unavailable");
  await expect(targets.locator("tbody tr").nth(1)).toContainText("Reach");
  await expect(targets.locator("tbody tr").nth(1)).toContainText("Unavailable");
  await expect(targets.getByText("Not met")).toHaveCount(0);
  await expect(targets.getByText("Target monitoring only · does not affect payment")).toHaveCount(2);
  await expect(page.getByText("Growth needs at least two comparable verified snapshots.")).toBeVisible();

  // Same warning-only targets on the Performance tab.
  await tab(page, "Performance").click();
  await expect(page.getByRole("heading", { name: "Agreement targets" })).toBeVisible();
  await expect(page.getByText("Target monitoring only · does not affect payment").first()).toBeVisible();
  // No money anywhere.
  const text = await page.locator("main").innerText();
  expect(text).not.toMatch(/₹|\bINR\b|\bUSD\b|payable|invoice/i);
});

test("redaction: a Manager without the out-of-scope Campaign's scope sees no identifier from it (page text and HTML), a global actor sees everything", async ({ page }) => {
  await signInAs(page, "manager");
  await open(page, refE, "?tab=production");
  const html = await page.content();
  const text = await page.locator("main").innerText();
  for (const needle of [OUT_CAMPAIGN, "OUT-SECRET", OUT_URL, "e2e-dt-out-secret-url", "RAW CAPTION", "rawusername"]) {
    expect(text, `page text leaks ${needle}`).not.toContain(needle);
    expect(html, `HTML leaks ${needle}`).not.toContain(needle);
  }
  await expect(page.locator("main")).toContainText(IN_CAMPAIGN);
  // The evidence itself is not hidden: both Assignments are in the canonical count, one row is shown as withheld.
  await expect(kv(page, "Assignments included")).toContainText("2");
  await expect(page.locator("table").first()).toContainText("Withheld");
  await tab(page, "Overview").click();
  await expect(page.getByText(/outside your access/)).toBeVisible();

  await signInAs(page, "admin");
  await open(page, refE, "?tab=production");
  await expect(page.locator("main")).toContainText(OUT_CAMPAIGN);
});

test("Viewer and Analyst are read-only: the review reads, and no lifecycle action is rendered", async ({ page }) => {
  for (const who of ["viewer", "analyst"] as const) {
    await signInAs(page, who);
    await open(page, refB);
    await expect(page.locator(".detailcontext")).toBeVisible();
    await expect(page.getByRole("button", { name: /Refresh evidence|Submit for review|Finalize|Create revision/ })).toHaveCount(0);
    await expect(page.getByText(/No action is available for you|immutable/).first()).toBeVisible();
    await tab(page, "Version History").click();
    await expect(page.locator("table")).toContainText("Version 1");
  }
});

test("unknown reviewRef is a 404 not-found state; an out-of-scope review is the neutral access-denied state", async ({ page }) => {
  const missing = await page.goto("/partner-reviews/pr_ffffffffffffffffffff");
  expect(missing?.status()).toBe(404);
  const hidden = await fx.seedPartner({ displayName: "E2E DT Hidden", regionIds: [fx.hiddenRegion] });
  const ref = (await fx.seedDirectReview(hidden, MONTH, { status: "DRAFT" })).reviewRef;
  await signInAs(page, "manager");
  const denied = await page.goto(`/partner-reviews/${ref}`);
  expect(denied?.ok()).toBeTruthy();
  await expect(page.getByRole("heading", { name: "Access denied" })).toBeVisible();
  expect(await page.locator("main").innerText()).not.toContain("E2E DT Hidden");
});

for (const width of VIEWPORTS) {
  test(`Review Detail has no document-level horizontal overflow at ${width}px, and its local tabs stay usable`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await open(page, refA);
    for (const name of ["Overview", "Production", "Compliance", "Performance", "Version History"]) {
      await tab(page, name).click();
      await expect(tab(page, name)).toHaveAttribute("aria-selected", "true");
      // The selected tab is reachable: scroll it into its strip and it lies within the viewport horizontally.
      await tab(page, name).scrollIntoViewIfNeeded();
      const box = await tab(page, name).boundingBox();
      expect(box, `${name} tab has a box at ${width}px`).not.toBeNull();
      expect(box!.x + box!.width, `${name} tab is inside the viewport at ${width}px`).toBeLessThanOrEqual(width + 1);
      expect(box!.x).toBeGreaterThanOrEqual(-1);
      const { scrollWidth, innerWidth } = await noDocumentOverflow(page);
      expect(scrollWidth, `${name} overflows at ${width}px`).toBeLessThanOrEqual(innerWidth);
    }
  });
}
