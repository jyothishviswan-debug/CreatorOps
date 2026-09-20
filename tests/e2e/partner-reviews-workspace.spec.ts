import { test, expect } from "@playwright/test";

import { partnersCollection } from "@/server/partners/firestore";
import { partnerReviewsCollection } from "@/server/partner-reviews/firestore";
import { reviewRefFor } from "@/server/partner-reviews/period";

import { createFixtures, noDocumentOverflow, signInAs, VIEWPORTS } from "./helpers/partner-reviews-fixtures";

// Step 13B - the Partner Reviews Workspace (/partner-reviews/workspace) through the real UI on real emulator data.
// Default `chromium` project (pre-authed Super Admin, GLOBAL); other identities sign in explicitly.
//
// Data (PAST months only, private region, month 2014-06 is this spec's own): 12 draft reviews (=> two cursor pages
// of 10 + 2), 3 in-review / finalized reviews, 3 Needs Review candidates, one Partner in a region nobody but the
// Super Admin can reach, and one review in a second month for the month selector.
const fx = createFixtures("e2e13bws");
const MONTH = "2014-06";
const OTHER_MONTH = "2014-07";
const DRAFT_NAMES = Array.from({ length: 12 }, (_, i) => `E2E WS Draft ${String(i + 1).padStart(2, "0")}`);
const CANDIDATES = ["E2E WS Candidate Alpha", "E2E WS Candidate Beta", "E2E WS Candidate Gamma"];

let finalizedPartnerRef = "";
let hiddenPartnerName = "";
const draftPartnerRefs: string[] = [];

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  await fx.grantFixtureRegion();
  for (const name of DRAFT_NAMES) {
    const partner = await fx.seedPartner({ displayName: name });
    draftPartnerRefs.push(partner.partnerRef);
    await fx.seedDirectReview(partner, MONTH, { status: "DRAFT" });
  }
  const finalizedPartner = await fx.seedPartner({ displayName: "E2E WS Finalized Partner" });
  finalizedPartnerRef = finalizedPartner.partnerRef;
  await fx.seedDirectReview(finalizedPartner, MONTH, { status: "FINALIZED" });
  const inReview = await fx.seedPartner({ displayName: "E2E WS InReview Partner" });
  await fx.seedDirectReview(inReview, MONTH, { status: "IN_REVIEW" });
  for (const name of CANDIDATES) await fx.seedRich({ month: MONTH, displayName: name });
  const other = await fx.seedPartner({ displayName: "E2E WS Other Month Partner" });
  await fx.seedDirectReview(other, OTHER_MONTH, { status: "DRAFT" });
  // Outside every non-global scope.
  const hidden = await fx.seedPartner({ displayName: "E2E WS Hidden Partner", regionIds: [fx.hiddenRegion] });
  hiddenPartnerName = hidden.displayName;
  await fx.seedDirectReview(hidden, MONTH, { status: "DRAFT" });
});

test.afterAll(async () => {
  await fx.cleanupAll();
});

const filterButton = (page: import("@playwright/test").Page, name: string) => page.locator('.segment[aria-label="Review filter"]').getByRole("button", { name });
const rowsOf = (page: import("@playwright/test").Page) => page.locator("table tbody tr");

test("filters: Needs Review / Drafts-In Review / Finalized-History show the right Partner-months, with the active filter marked", async ({ page }) => {
  await page.goto(`/partner-reviews/workspace?month=${MONTH}`);
  await expect(page.locator("h1")).toHaveText("Partner Reviews workspace");
  await expect(page.locator(".tabs .tab.active")).toHaveText("Workspace");
  await expect(filterButton(page, "Needs Review")).toHaveAttribute("aria-pressed", "true");

  // Needs Review (default): the three candidates, sorted by Partner name, each with Generate Review.
  await expect(rowsOf(page)).toHaveCount(3);
  await expect(rowsOf(page).locator("td:first-child b")).toHaveText(CANDIDATES);
  await expect(page.getByRole("button", { name: /^Generate Review for/ })).toHaveCount(3);
  await expect(page.getByText(/Needs Review is derived, never stored/)).toBeVisible();

  // Drafts / In Review.
  await filterButton(page, "Drafts / In Review").click();
  await expect(page).toHaveURL(/filter=drafts/);
  await expect(filterButton(page, "Drafts / In Review")).toHaveAttribute("aria-pressed", "true");
  await expect(rowsOf(page).first()).toBeVisible();
  const draftText = await page.locator("table").innerText();
  expect(draftText).not.toContain("E2E WS Finalized Partner");

  // Finalized / History.
  await filterButton(page, "Finalized / History").click();
  await expect(page).toHaveURL(/filter=finalized/);
  await expect(rowsOf(page)).toHaveCount(1);
  await expect(rowsOf(page)).toContainText("E2E WS Finalized Partner");
  await expect(rowsOf(page)).toContainText("Finalized");
});

test("cursor pagination through the UI: 10 then 2, no duplicates, prev/next, and the browser never fetches everything", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/partner-reviews/workspace")) requests.push(request.url());
  });
  await page.goto(`/partner-reviews/workspace?filter=drafts&month=${MONTH}`);
  // 12 Drafts + 1 In Review + the hidden-region Draft (the GLOBAL Super Admin reaches it) = 14 -> page 1 holds 10.
  await expect(rowsOf(page)).toHaveCount(10);
  const first = await rowsOf(page).locator("td:first-child b").allTextContents();
  expect(new Set(first).size).toBe(10);

  const pager = page.getByRole("navigation", { name: "Pagination" });
  await expect(pager).toBeVisible();
  await pager.getByRole("button", { name: "Next" }).click();
  await expect(rowsOf(page)).toHaveCount(4);
  const second = await rowsOf(page).locator("td:first-child b").allTextContents();
  expect([...first, ...second]).toHaveLength(14);
  expect(new Set([...first, ...second]).size).toBe(14);
  // The second page came from ONE bounded API call carrying an opaque cursor (not a fetch-all).
  expect(requests).toHaveLength(1);
  expect(requests[0]).toContain("cursor=");
  expect(requests[0]).toContain("limit=10");

  await pager.getByRole("button", { name: "Prev" }).click();
  await expect(rowsOf(page)).toHaveCount(10);
  await expect(rowsOf(page).locator("td:first-child b")).toHaveText(first);
  // Going back does not refetch.
  expect(requests).toHaveLength(1);
});

test("month selector is URL state; Partner search finds only authorized Partners and narrows the list; the Partner link opens the Partner-wise page", async ({ page }) => {
  await page.goto(`/partner-reviews/workspace?filter=drafts&month=${MONTH}`);
  await page.getByLabel("Reporting month").selectOption(OTHER_MONTH);
  await expect(page).toHaveURL(new RegExp(`month=${OTHER_MONTH}`));
  await expect(rowsOf(page)).toHaveCount(1);
  await expect(rowsOf(page)).toContainText("E2E WS Other Month Partner");
  await page.getByLabel("Reporting month").selectOption(MONTH);
  await expect(page).toHaveURL(new RegExp(`month=${MONTH}`));

  // Partner search (keyboard-operable combobox): typing a prefix lists only authorized Partners.
  const search = page.getByRole("combobox", { name: "Search Partners by name" });
  await search.fill("E2E WS Draft 0");
  const results = page.getByRole("listbox", { name: "Partner search results" });
  await expect(results.getByRole("option").first()).toBeVisible();
  await expect(results.getByRole("option")).toHaveCount(9);
  await search.fill("E2E WS Hidden");
  // A GLOBAL actor may reach the hidden-region Partner; a scoped one must not (asserted below as the Manager).
  await expect(results.getByRole("option").first()).toContainText("E2E WS Hidden Partner");
  await search.fill("E2E WS Draft 03");
  // (the list is debounced: wait for the NEW result, not the previous one)
  await expect(results.getByRole("option")).toHaveText(/E2E WS Draft 03/);
  await search.press("ArrowDown");
  await search.press("Enter");
  await expect(page).toHaveURL(/partnerRef=/);
  await expect(page.getByTestId("partner-chip")).toContainText("E2E WS Draft 03");
  await expect(rowsOf(page)).toHaveCount(1);
  await expect(rowsOf(page)).toContainText("E2E WS Draft 03");

  // Clearing the chip restores the list.
  await page.getByRole("button", { name: "Clear Partner filter" }).click();
  await expect(page.getByTestId("partner-chip")).toHaveCount(0);
  await expect(rowsOf(page)).toHaveCount(10);

  // The Partner name links to the Partner-wise history page.
  await page.getByRole("link", { name: /E2E WS Draft 01 - Partner Reviews history/ }).click();
  await expect(page).toHaveURL(new RegExp(`/partner-reviews/partner/${draftPartnerRefs[0]}\\?month=${MONTH}`));
  await expect(page.locator("h1")).toHaveText("E2E WS Draft 01");
  await expect(page.getByText("Monthly productivity history")).toBeVisible();
});

test("the review month links to the versioned review detail", async ({ page }) => {
  await page.goto(`/partner-reviews/workspace?filter=finalized&month=${MONTH}`);
  await rowsOf(page).first().getByRole("link", { name: /Open review for/ }).click();
  await expect(page).toHaveURL(new RegExp(`/partner-reviews/${reviewRefFor(finalizedPartnerRef, MONTH)}$`));
  await expect(page.locator("h1")).toContainText("E2E WS Finalized Partner");
  await expect(page.locator("h1")).toContainText("June 2014");
});

test("Generate Review from a Needs Review row is idempotent: one review, a DRAFT, and a retry/double-click creates no duplicate", async ({ page }) => {
  await page.goto(`/partner-reviews/workspace?month=${MONTH}`);
  const target = rowsOf(page).filter({ hasText: CANDIDATES[0]! });
  const button = target.getByRole("button", { name: /^Generate Review for/ });
  await expect(button).toBeVisible();

  // A double-click posts twice at most; the server collapses onto ONE head (201 then 200).
  const responses: number[] = [];
  page.on("response", (response) => {
    if (response.url().endsWith("/api/partner-reviews") && response.request().method() === "POST") responses.push(response.status());
  });
  await button.dblclick();
  await expect(target.getByRole("link", { name: /Open review for/ })).toBeVisible();
  await expect(target).toContainText("Draft");
  await expect(page.getByTestId("workspace-status")).toContainText(/Draft review generated|already existed/);
  expect(responses.length).toBeGreaterThanOrEqual(1);
  expect(responses[0]).toBe(201);
  expect(responses.every((status) => status === 201 || status === 200)).toBe(true);

  // Exactly one head exists for that Partner-month, and it is a Draft.
  const partnerSnap = await partnersCollection().where("displayName", "==", CANDIDATES[0]!).get();
  expect(partnerSnap.size).toBe(1);
  const candidateRef = partnerSnap.docs[0]!.data().partnerRef as string;
  const headSnap = await partnerReviewsCollection().doc(reviewRefFor(candidateRef, MONTH)).get();
  expect(headSnap.exists).toBe(true);
  expect(headSnap.data()!.display.status).toBe("DRAFT");
  const before = (await partnerReviewsCollection().where("periodKey", "==", MONTH).get()).size;

  // A retry after the fact returns the existing review (200) and creates nothing new.
  const retry = await page.evaluate(async (partnerRef) => {
    const res = await fetch("/api/partner-reviews", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ partnerRef, periodKey: "2014-06" }) });
    return { status: res.status, outcome: res.headers.get("X-Partner-Review-Outcome") };
  }, candidateRef);
  expect(retry).toEqual({ status: 200, outcome: "existing" });
  expect((await partnerReviewsCollection().where("periodKey", "==", MONTH).get()).size).toBe(before);

  // The candidate leaves the Needs Review queue once the review exists.
  await page.reload();
  await expect(rowsOf(page)).toHaveCount(2);

  // The generated review opens as a Draft.
  await page.goto(`/partner-reviews/workspace?filter=drafts&month=${MONTH}`);
  await expect(page.locator("table")).toContainText(CANDIDATES[0]!);
});

test("empty / no-results / error-safe states", async ({ page }) => {
  // No data for the month at all.
  await page.goto("/partner-reviews/workspace?filter=finalized&month=2001-01");
  await expect(page.getByText("No finalized reviews")).toBeVisible();
  // A Partner filter that matches nothing in the month.
  await page.goto(`/partner-reviews/workspace?filter=finalized&month=${MONTH}&partnerRef=${draftPartnerRefs[1]}`);
  await expect(page.getByText("No matching reviews")).toBeVisible();
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(page).not.toHaveURL(/partnerRef=/);
  await expect(rowsOf(page)).toHaveCount(1);
  // A garbage month falls back with a notice; a garbage cursor / filter never crashes.
  await page.goto("/partner-reviews/workspace?month=banana&filter=%3Cscript%3E&partnerRef=%2F..%2Fx");
  await expect(page.getByText("not a valid YYYY-MM month").first()).toBeVisible();
  await expect(page.locator("h1")).toHaveText("Partner Reviews workspace");
});

test("keyboard: filters, the month select and the Partner combobox are operable without a mouse", async ({ page }) => {
  await page.goto(`/partner-reviews/workspace?month=${MONTH}`);
  await filterButton(page, "Drafts / In Review").focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/filter=drafts/);
  await filterButton(page, "Finalized / History").focus();
  await page.keyboard.press("Space");
  await expect(page).toHaveURL(/filter=finalized/);

  const search = page.getByRole("combobox", { name: "Search Partners by name" });
  await search.focus();
  await page.keyboard.type("E2E WS Finalized");
  await expect(page.getByRole("listbox", { name: "Partner search results" }).getByRole("option")).toHaveText(/E2E WS Finalized Partner/);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox", { name: "Partner search results" })).toHaveCount(0);
  await expect(search).toBeFocused();
});

test("a scoped Manager sees only Partners in scope (the hidden-region Partner never appears in the list or the search) and can generate", async ({ page }) => {
  await signInAs(page, "manager");
  await page.goto(`/partner-reviews/workspace?filter=drafts&month=${MONTH}`);
  await expect(rowsOf(page).first()).toBeVisible();
  expect(await page.locator("table").innerText()).not.toContain(hiddenPartnerName);
  const search = page.getByRole("combobox", { name: "Search Partners by name" });
  await search.fill("E2E WS Hidden");
  await expect(page.getByText("No matching Partners in your authorized scope")).toBeVisible();
  await expect(page.getByRole("listbox", { name: "Partner search results" }).getByRole("option")).toHaveCount(0);
  await page.goto(`/partner-reviews/workspace?month=${MONTH}`);
  await expect(page.getByRole("button", { name: /^Generate Review for/ }).first()).toBeVisible();
});

test("a Viewer is read-only: no Generate Review button anywhere, Open review links still work", async ({ page }) => {
  await signInAs(page, "viewer");
  await page.goto(`/partner-reviews/workspace?month=${MONTH}`);
  await expect(rowsOf(page).first()).toBeVisible();
  await expect(page.getByRole("button", { name: /Generate Review/ })).toHaveCount(0);
  await expect(page.getByText("Read only").first()).toBeVisible();
  await page.goto(`/partner-reviews/workspace?filter=finalized&month=${MONTH}`);
  await expect(page.getByRole("link", { name: /Open review for/ }).first()).toBeVisible();
});

for (const width of VIEWPORTS) {
  test(`Workspace has no document-level horizontal overflow at ${width}px (tables scroll inside their own wrapper)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/partner-reviews/workspace?filter=drafts&month=${MONTH}`);
    await expect(rowsOf(page).first()).toBeVisible();
    const { scrollWidth, innerWidth } = await noDocumentOverflow(page);
    expect(scrollWidth, `Workspace overflows at ${width}px`).toBeLessThanOrEqual(innerWidth);
    const wrap = page.locator(".tablewrap").first();
    const { clientWidth } = await wrap.evaluate((el) => ({ clientWidth: el.clientWidth }));
    expect(clientWidth).toBeLessThanOrEqual(innerWidth);
  });
}

test("the Region filter stays one compact line however many regions are selected (no wall of names)", async ({ page }) => {
  await page.goto(`/partner-reviews/workspace?month=${MONTH}&region=Rajasthan&region=Madhya%20Pradesh&region=Gujarat&region=Goa&region=Maharashtra`);
  const trigger = page.getByRole("group", { name: "Region filter" }).getByRole("button");
  await expect(trigger).toHaveText("Rajasthan, Madhya Pradesh +3");
  expect((await trigger.boundingBox())!.height).toBeLessThan(45); // one line, like the other filter controls
  // The dropdown still lists every state (nothing is hidden), and there is no Select all on this page.
  await trigger.click();
  await expect(page.getByRole("group", { name: "Region filter" }).getByLabel("Goa", { exact: true })).toBeChecked();
  await expect(page.getByRole("group", { name: "Region filter" }).getByLabel("Select all", { exact: true })).toHaveCount(0);
  const overflow = await noDocumentOverflow(page);
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.innerWidth);
});
