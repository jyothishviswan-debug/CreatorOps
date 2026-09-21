import { test, expect, type Locator, type Page } from "@playwright/test";

import { DISCOVERY_REGIONS } from "@/server/discovery/types";
import { reviewRefFor } from "@/server/partner-reviews/period";

import { createFixtures, noDocumentOverflow, signInAs, VIEWPORTS } from "./helpers/partner-reviews-fixtures";

// Partner Reviews CLOSURE CERTIFICATION (R9) - the browser evidence the four surface specs do not already carry:
//   * the Workspace Region closed field is ONE compact line at every width (incl. 390 and 375) and reads "All regions" ONLY for
//     the full canonical list, otherwise "A, B +N";
//   * the local tab rows of the Workspace (Overview | Workspace switch and the review filter) are usable at every width;
//   * dialogs are keyboard accessible (focus moves in, is not lost to the page behind, Escape / Cancel / close restore focus to
//     the invoking control, Enter confirms) and are labelled by their OWN title;
//   * disabled action buttons are visibly disabled (not just `disabled`);
//   * unavailable values are announced (role="img" aria-label="Unavailable", or the word "Unavailable") and never read as 0;
//   * screen-reader-only text uses the corrected shared `.sr` utility (still in the accessibility tree, never display:none);
//   * the Partner-wise page's link back to the Workspace targets that Partner and month.
// (The four surfaces' document-level overflow at 1440/1200/1050/760/390/375 is already measured on
// document.documentElement by the Overview / Workspace / Detail / Partner-history specs.)
//
// Data: PAST month 2008-04 (this spec's own), private region, reviews created through the TRUSTED services. Runs in the default
// `chromium` project (pre-authed Super Admin); other identities sign in explicitly. Every fixture is removed in afterAll.
const fx = createFixtures("e2e13cl");
const MONTH = "2008-04";
const NAME = {
  draftA: "E2E CL Draft Alpha",
  draftB: "E2E CL Draft Bravo",
  candidate: "E2E CL Candidate",
  dialogOne: "E2E CL Dialog One",
  dialogTwo: "E2E CL Dialog Two",
  revisionDialog: "E2E CL Revision Dialog",
  busy: "E2E CL Busy Draft",
  twoVersions: "E2E CL Two Versions",
  history: "E2E CL History Partner",
};

let refDialogOne = "";
let refDialogTwo = "";
let refRevisionDialog = "";
let refBusy = "";
let refTwoVersions = "";
let historyPartnerRef = "";
let historyReviewRef = "";
let candidatePartnerRef = "";
let finalizedPartnerRef = "";
let openRevisionPartnerRef = "";

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  await fx.grantFixtureRegion();

  // Workspace rows: two Drafts and one Needs Review candidate.
  for (const name of [NAME.draftA, NAME.draftB]) {
    const partner = await fx.seedPartner({ displayName: name });
    await fx.seedDirectReview(partner, MONTH, { status: "DRAFT" });
  }
  candidatePartnerRef = (await fx.seedRich({ month: MONTH, displayName: NAME.candidate })).partner.partnerRef;

  // Two In Review reviews (Head finalizes): one for the open/close/focus checks, one finalized from the keyboard alone.
  const one = await fx.seedRich({ month: MONTH, displayName: NAME.dialogOne });
  refDialogOne = (await fx.generateInReview(one.partner.partnerRef, MONTH)).reviewRef;
  const two = await fx.seedRich({ month: MONTH, displayName: NAME.dialogTwo });
  refDialogTwo = (await fx.generateInReview(two.partner.partnerRef, MONTH)).reviewRef;

  // Finalized, then upstream changes => "Revision available" (the Create revision dialog).
  const rev = await fx.seedRich({ month: MONTH, displayName: NAME.revisionDialog, threadStatus: "APPROVED" });
  finalizedPartnerRef = rev.partner.partnerRef;
  refRevisionDialog = (await fx.generateFinalized(rev.partner.partnerRef, MONTH)).reviewRef;
  await fx.seedAnalytics(rev.partner.partnerRef, { contentRef: null, likes: 9, month: MONTH });

  // A Draft the Manager can act on (busy / disabled checks).
  const busy = await fx.seedRich({ month: MONTH, displayName: NAME.busy });
  refBusy = (await fx.generate(busy.partner.partnerRef, MONTH)).head.reviewRef;

  // Finalized v1 + an open Draft revision v2 (Version History has a "View version 1" button while v2 is being edited).
  const two2 = await fx.seedRich({ month: MONTH, displayName: NAME.twoVersions, threadStatus: "APPROVED" });
  openRevisionPartnerRef = two2.partner.partnerRef;
  const finalized = await fx.generateFinalized(two2.partner.partnerRef, MONTH);
  refTwoVersions = finalized.reviewRef;
  await fx.seedAnalytics(two2.partner.partnerRef, { contentRef: null, likes: 5, month: MONTH });
  await fx.revise(finalized.reviewRef, finalized.review.head.docVersion);

  // Partner-wise history: one review whose Analytics reported Views only (Likes / Comments / Engagement are gaps).
  const history = await fx.seedPartner({ displayName: NAME.history });
  historyPartnerRef = history.partnerRef;
  const assignment = await fx.seedAssignment(history.partnerRef, { dueAt: `${MONTH}-10` });
  const thread = await fx.seedThread(assignment, { month: MONTH, status: "APPROVED", approvedAt: `${MONTH}-09T00:00:00.000Z` });
  await fx.seedAnalytics(history.partnerRef, { contentRef: thread.contentRef, likes: null, views: 500, month: MONTH });
  await fx.generate(history.partnerRef, MONTH);
  historyReviewRef = reviewRefFor(history.partnerRef, MONTH);
});

test.afterAll(async () => {
  await fx.cleanupAll();
});

const regionTrigger = (page: Page) => page.getByRole("group", { name: "Region filter" }).getByRole("button").first();

// ---- Region closed field -------------------------------------------------------------------------------------------------------
const FIRST_TWO = [DISCOVERY_REGIONS[0]!, DISCOVERY_REGIONS[1]!];
const REGION_CASES: Array<{ label: string; regions: string[]; text: string }> = [
  { label: "no region", regions: [], text: "Select regions…" },
  { label: "one region", regions: ["Kerala"], text: "Kerala" },
  { label: "two regions", regions: ["Kerala", "Goa"], text: "Kerala, Goa" },
  { label: "five regions", regions: DISCOVERY_REGIONS.slice(0, 5), text: `${FIRST_TWO.join(", ")} +3` },
  { label: "all but one canonical region", regions: DISCOVERY_REGIONS.slice(0, DISCOVERY_REGIONS.length - 1), text: `${FIRST_TWO.join(", ")} +${DISCOVERY_REGIONS.length - 3}` },
  { label: "every canonical region", regions: [...DISCOVERY_REGIONS], text: "All regions" },
];

for (const width of VIEWPORTS) {
  test(`Region filter: the closed field is ONE compact line at ${width}px for 0, 1, 2, 5 and 34 regions, and only the full canonical list reads "All regions"`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    for (const { label, regions, text } of REGION_CASES) {
      const params = regions.map((region) => `region=${encodeURIComponent(region)}`).join("&");
      await page.goto(`/partner-reviews/workspace?month=${MONTH}&filter=drafts${params ? `&${params}` : ""}`);
      const trigger = regionTrigger(page);
      await expect(trigger, `${label} at ${width}px`).toHaveText(text);
      const box = (await trigger.boundingBox())!;
      expect(box.height, `${label}: closed field is one line at ${width}px`).toBeLessThan(45);
      expect(box.x, `${label}: inside the viewport (left) at ${width}px`).toBeGreaterThanOrEqual(-1);
      expect(box.x + box.width, `${label}: inside the viewport (right) at ${width}px`).toBeLessThanOrEqual(width + 1);
      // The label is a single truncated line - never wrapped, never taller than its box.
      const line = await trigger.evaluate((button) => {
        const span = button.querySelector("span")!;
        const style = getComputedStyle(span);
        // One line of this control's 14px / 1.5 text is ~21px; a wrapped label would be at least two lines tall.
        return { whiteSpace: style.whiteSpace, wrapped: span.getBoundingClientRect().height > 30 };
      });
      expect(line.whiteSpace, `${label}: no wrapping at ${width}px`).toBe("nowrap");
      expect(line.wrapped, `${label}: one text line at ${width}px`).toBe(false);
      const overflow = await noDocumentOverflow(page);
      expect(overflow.scrollWidth, `${label}: no document overflow at ${width}px`).toBeLessThanOrEqual(overflow.innerWidth);
    }
  });
}

// ---- Local tab rows on the Workspace ---------------------------------------------------------------------------------------------
for (const width of VIEWPORTS) {
  test(`Workspace local tab rows (Overview | Workspace and the review filter) are usable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/partner-reviews/workspace?month=${MONTH}`);
    await expect(page.locator("h1")).toHaveText("Partner Reviews workspace");
    const inside = async (locator: Locator, name: string) => {
      await locator.scrollIntoViewIfNeeded();
      const box = await locator.boundingBox();
      expect(box, `${name} has a box at ${width}px`).not.toBeNull();
      expect(box!.x, `${name} left edge at ${width}px`).toBeGreaterThanOrEqual(-1);
      expect(box!.x + box!.width, `${name} right edge at ${width}px`).toBeLessThanOrEqual(width + 1);
      await locator.click({ trial: true }); // actionable: visible, stable, not covered
    };
    await expect(page.locator(".tabs .tab")).toHaveText(["Overview", "Workspace"]);
    for (const tab of await page.locator(".tabs .tab").all()) await inside(tab, `module tab ${await tab.innerText()}`);
    const filters = page.locator('.segment[aria-label="Review filter"] button');
    await expect(filters).toHaveText(["Needs Review", "Drafts / In Review", "Finalized / History"]);
    for (const button of await filters.all()) await inside(button, `filter ${await button.innerText()}`);

    // The selected filter is real, keyboard-operable state at this width.
    await filters.nth(1).click();
    await expect(filters.nth(1)).toHaveAttribute("aria-pressed", "true");
    await expect(page).toHaveURL(/filter=drafts/);
    const { scrollWidth, innerWidth } = await noDocumentOverflow(page);
    expect(scrollWidth, `Workspace overflows at ${width}px`).toBeLessThanOrEqual(innerWidth);
  });
}

// ---- Partner-wise page -> Workspace link (Step 13C.1: context-preserving) -----------------------------------------------------------
// The back link carries the Partner and the month and opens the EXISTING Workspace filter that lists the review:
// Draft / In Review (also an open revision over a finalized version) -> Drafts / In Review; finalized -> Finalized / History;
// no review yet (a Needs Review candidate) -> the default Needs Review view. No new state, no browser-side filtering.
const backCases = () => [
  { label: "a Draft", partnerRef: historyPartnerRef, name: NAME.history, filter: "drafts", activeButton: "Drafts / In Review" },
  { label: "an open revision over a finalized version", partnerRef: openRevisionPartnerRef, name: NAME.twoVersions, filter: "drafts", activeButton: "Drafts / In Review" },
  { label: "a finalized review", partnerRef: finalizedPartnerRef, name: NAME.revisionDialog, filter: "finalized", activeButton: "Finalized / History" },
  { label: "no review yet (a Needs Review candidate)", partnerRef: candidatePartnerRef, name: NAME.candidate, filter: null, activeButton: "Needs Review" },
];

for (const index of [0, 1, 2, 3]) {
  test(`Partner history 'Back to workspace' keeps the Partner + month and opens the filter that lists the review (case ${index + 1})`, async ({ page }) => {
    const item = backCases()[index]!;
    await page.goto(`/partner-reviews/partner/${item.partnerRef}?month=${MONTH}`);
    await expect(page.locator("h1")).toHaveText(item.name);
    const link = page.getByRole("link", { name: "Back to workspace" });
    const url = new URL((await link.getAttribute("href"))!, "http://localhost");
    expect(url.pathname, item.label).toBe("/partner-reviews/workspace");
    expect(url.searchParams.get("month")).toBe(MONTH);
    expect(url.searchParams.get("partnerRef")).toBe(item.partnerRef);
    expect(url.searchParams.get("filter"), `${item.label}: filter`).toBe(item.filter);
    expect([...url.searchParams.keys()].sort(), "only the existing Workspace URL contract").toEqual(item.filter ? ["filter", "month", "partnerRef"] : ["month", "partnerRef"]);

    await link.click();
    await expect(page).toHaveURL(new RegExp(`/partner-reviews/workspace\\?.*partnerRef=${item.partnerRef}`));
    await expect(page.getByTestId("partner-chip")).toContainText(item.name);
    // The destination is the view that actually contains this Partner's month (never an empty default for a Partner who has a review).
    await expect(page.locator('.segment[aria-label="Review filter"]').getByRole("button", { name: item.activeButton })).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("table tbody tr")).toHaveCount(1);
    await expect(page.locator("table tbody tr")).toContainText(item.name);
    if (item.filter !== null) await expect(page.getByRole("link", { name: /^Open review for/ })).toBeVisible();
    else await expect(page.getByRole("button", { name: /Generate Review/ })).toBeVisible();
  });
}

test("Partner history 'Back to workspace' for a Partner with a review still opens that review's own Review Detail from the row", async ({ page }) => {
  await page.goto(`/partner-reviews/partner/${historyPartnerRef}?month=${MONTH}`);
  await page.getByRole("link", { name: "Back to workspace" }).click();
  await expect(page.getByRole("link", { name: /^Open review for/ })).toHaveAttribute("href", `/partner-reviews/${historyReviewRef}`);
});

// ---- Version History column heading (Step 13C.1) ----------------------------------------------------------------------------------------
test("Version History labels the currentness column 'Review version status' - never 'Currency'", async ({ page }) => {
  await page.goto(`/partner-reviews/${refTwoVersions}?tab=history`);
  const headers = page.locator("table thead th");
  await expect(headers.filter({ hasText: /^Review version status$/ })).toHaveCount(1);
  await expect(headers.filter({ hasText: /currency/i })).toHaveCount(0);
  await expect(page.locator("main, #main").getByText(/^Currency$/)).toHaveCount(0);
});

// ---- Dialogs: keyboard accessibility ------------------------------------------------------------------------------------------
async function focusState(page: Page) {
  return page.evaluate(() => {
    const active = document.activeElement;
    return { insideDialog: Boolean(active?.closest("dialog[open]")), tag: active?.tagName ?? null };
  });
}

test("Finalize dialog is keyboard accessible: focus moves in, Tab never reaches the page behind it, and Cancel / the close button / Escape each restore focus to the invoking control", async ({ page }) => {
  await signInAs(page, "head");
  await page.goto(`/partner-reviews/${refDialogOne}`);
  await page.waitForLoadState("networkidle"); // a keypress does not retry like a click: let the page hydrate first
  const finalize = page.getByRole("button", { name: "Finalize", exact: true });
  await expect(finalize).toBeVisible();

  for (const closeWith of ["cancel", "close", "escape"] as const) {
    await finalize.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Finalize this review?" });
    await expect(dialog).toBeVisible();
    // Focus moved INTO the modal.
    expect((await focusState(page)).insideDialog, "focus starts inside the dialog").toBe(true);
    // Tabbing (forwards and backwards) never lands on an element behind the modal.
    let sawInside = false;
    for (let i = 0; i < 8; i += 1) {
      await page.keyboard.press(i < 6 ? "Tab" : "Shift+Tab");
      const state = await focusState(page);
      sawInside ||= state.insideDialog;
      expect(state.insideDialog || state.tag === "BODY", `Tab #${i + 1} stays in the modal (was ${state.tag})`).toBe(true);
    }
    expect(sawInside).toBe(true);

    if (closeWith === "cancel") await dialog.getByRole("button", { name: "Cancel" }).click();
    else if (closeWith === "close") await dialog.getByRole("button", { name: "Close dialog" }).click();
    else await page.keyboard.press("Escape");
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await expect(finalize, `focus is restored to Finalize after ${closeWith}`).toBeFocused();
    // Closing without confirming changed nothing.
    await expect(page.locator(".detailcontext .pill").first()).toHaveText("In review");
  }
});

test("Finalize dialog: the confirm button is operable with the keyboard alone (Enter finalizes)", async ({ page }) => {
  await signInAs(page, "head");
  await page.goto(`/partner-reviews/${refDialogTwo}`);
  await page.waitForLoadState("networkidle"); // a keypress does not retry like a click: let the page hydrate first
  await page.getByRole("button", { name: "Finalize", exact: true }).focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Finalize this review?" });
  await expect(dialog).toBeVisible();
  const confirm = dialog.getByRole("button", { name: "Finalize review" });
  await confirm.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Review finalized.")).toBeVisible();
  await expect(page.locator(".detailcontext .pill").first()).toHaveText("Finalized");
  await expect(page.locator("dialog[open]")).toHaveCount(0);
});

test("Create revision dialog is labelled by its OWN title and dialog title ids are unique (no duplicate id in the DOM)", async ({ page }) => {
  await signInAs(page, "manager");
  await page.goto(`/partner-reviews/${refRevisionDialog}`);
  await page.waitForLoadState("networkidle"); // a keypress does not retry like a click: let the page hydrate first
  const create = page.getByRole("button", { name: "Create revision" });
  await create.focus();
  await page.keyboard.press("Enter");
  // The accessible name of the open dialog is its own heading - not another (closed) dialog's title.
  await expect(page.getByRole("dialog", { name: "Create a revision?" })).toBeVisible();
  const allIdsUnique = await page.evaluate(() => {
    const seen = new Map<string, number>();
    for (const el of document.querySelectorAll("[id]")) seen.set(el.id, (seen.get(el.id) ?? 0) + 1);
    return [...seen.entries()].filter(([, count]) => count > 1).map(([id]) => id);
  });
  expect(allIdsUnique, "no duplicate id anywhere on the Review Detail page").toEqual([]);
  await page.keyboard.press("Escape");
  await expect(create).toBeFocused();
});

// ---- Disabled buttons are VISIBLY disabled --------------------------------------------------------------------------------------
type Look = { disabled: boolean; cursor: string; background: string; color: string };
const lookOf = (locator: Locator): Promise<Look> =>
  locator.evaluate((el) => {
    const style = getComputedStyle(el);
    return { disabled: (el as HTMLButtonElement).disabled, cursor: style.cursor, background: style.backgroundColor, color: style.color };
  });

// Holds a request open until `release()` so the UI stays in its busy state while the assertions run.
function holdRequests(page: Page, pattern: string | RegExp, method: string) {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = page.route(pattern, async (route) => {
    if (route.request().method() !== method) return route.continue();
    await gate;
    return route.continue();
  });
  return { release, ready };
}

test("while an action runs, every action button is visibly disabled (disabled, not-allowed cursor, muted fill) - and returns to normal afterwards", async ({ page }) => {
  await signInAs(page, "manager");
  await page.goto(`/partner-reviews/${refBusy}`);
  // The label changes while the action runs ("Refreshing…" / "Submitting…"), so match both states of the SAME button.
  const refresh = page.getByRole("button", { name: /^(Refresh evidence|Refreshing…)$/ });
  const submit = page.getByRole("button", { name: /^(Submit for review|Submitting…)$/ });
  await expect(refresh).toBeEnabled();
  const enabledLook = await lookOf(submit);
  expect(enabledLook.disabled).toBe(false);

  const hold = holdRequests(page, "**/api/partner-reviews/*/refresh", "POST");
  await hold.ready;
  await refresh.click();
  for (const [name, button] of [
    ["Refresh evidence", refresh],
    ["Submit for review", submit],
  ] as const) {
    await expect(button, `${name} is disabled while busy`).toBeDisabled();
    const look = await lookOf(button);
    expect(look.cursor, `${name} shows the not-allowed cursor`).toBe("not-allowed");
    expect(look.background, `${name} is visibly muted`).toBe("rgb(236, 239, 242)");
    expect(look.background).not.toBe(enabledLook.background);
  }
  hold.release();
  await expect(page.getByText("Evidence refreshed.")).toBeVisible();
  await expect(submit).toBeEnabled();
  expect((await lookOf(submit)).cursor).not.toBe("not-allowed");
});

test("Version History: 'View version' is visibly disabled while an action runs (not just the disabled attribute)", async ({ page }) => {
  await signInAs(page, "manager");
  await page.goto(`/partner-reviews/${refTwoVersions}?tab=history`);
  await expect(page.locator(".detailcontext")).toContainText("Version 2 of 2");
  const view = page.getByRole("button", { name: "View version 1" });
  await expect(view).toBeEnabled();
  const hold = holdRequests(page, "**/api/partner-reviews/*/refresh", "POST");
  await hold.ready;
  await page.getByRole("button", { name: "Refresh evidence" }).click();
  await expect(view).toBeDisabled();
  const look = await lookOf(view);
  expect(look.cursor, "View version shows the not-allowed cursor while busy").toBe("not-allowed");
  expect(look.background, "View version is visibly muted while busy").toBe("rgb(236, 239, 242)");
  hold.release();
  await expect(page.getByText("Evidence refreshed.")).toBeVisible();
  await expect(view).toBeEnabled();
});

test("Workspace: Generate Review is disabled, aria-disabled and visibly muted while the review is being generated", async ({ page }) => {
  await signInAs(page, "manager");
  await page.goto(`/partner-reviews/workspace?month=${MONTH}`);
  const row = page.locator("table tbody tr").filter({ hasText: NAME.candidate });
  const generate = row.getByRole("button", { name: /^Generate Review for/ });
  await expect(generate).toBeEnabled();
  const hold = holdRequests(page, "**/api/partner-reviews", "POST");
  await hold.ready;
  await generate.click();
  await expect(generate).toBeDisabled();
  await expect(generate).toHaveAttribute("aria-disabled", "true");
  const look = await lookOf(generate);
  expect(look.cursor).toBe("not-allowed");
  expect(look.background).toBe("rgb(236, 239, 242)");
  hold.release();
  await expect(row.getByRole("link", { name: /Open review for/ })).toBeVisible();
});

// ---- Unavailable values are announced, never zero -------------------------------------------------------------------------------
test("Partner history: metric gaps are announced as Unavailable (role=img) and never read as 0; the real value stays a number", async ({ page }) => {
  await page.goto(`/partner-reviews/partner/${historyPartnerRef}?tab=performance`);
  const table = page.getByRole("table", { name: "Instagram performance by month" });
  await expect(table).toBeVisible();
  const row = table.locator("tbody tr").filter({ hasText: "April 2008" });
  await expect(row).toHaveCount(1);
  const cells = await row.locator("td").evaluateAll((tds) =>
    tds.map((td) => ({ text: td.textContent!.trim(), announcedUnavailable: Boolean(td.querySelector('[role="img"][aria-label="Unavailable"]')) })),
  );
  // Month | Views | Engagement | Likes | Comments | Follower snapshots | Targets
  expect(cells[1]).toEqual({ text: "500", announcedUnavailable: false });
  for (const index of [2, 3, 4]) expect(cells[index], `metric column ${index} is an announced gap`).toEqual({ text: "—", announcedUnavailable: true });
  expect(cells.slice(1, 5).some((cell) => cell.text === "0")).toBe(false);
  // The gap is announced by name, not just drawn.
  for (const index of [2, 3, 4]) await expect(row.locator("td").nth(index).getByRole("img", { name: "Unavailable" })).toHaveCount(1);
});

test("Review Detail: missing Performance metrics read the word 'Unavailable' (never 0), and only the reported metric is a number", async ({ page }) => {
  await page.goto(`/partner-reviews/${historyReviewRef}?tab=performance`);
  const table = page.getByRole("table", { name: "Source-reported metrics by platform" });
  await expect(table).toBeVisible();
  const cells = await table.locator("tbody tr").first().locator("td").allInnerTexts();
  expect(cells[0]).toBe("Instagram");
  expect(cells[1]).toBe("500");
  for (const index of [2, 3, 4]) expect(cells[index], `column ${index}`).toMatch(/^Unavailable/);
  expect(cells.includes("0")).toBe(false);
  await expect(page.getByText(/Follower growth needs at least two comparable verified snapshots\./)).toBeVisible();
});

// ---- Screen-reader-only text --------------------------------------------------------------------------------------------------
async function expectCorrectedSr(page: Page, name: string) {
  const sr = await page.locator(".sr").evaluateAll((els) =>
    els.map((el) => {
      const style = getComputedStyle(el);
      return { display: style.display, visibility: style.visibility, position: style.position, width: style.width, height: style.height, clipPath: style.clipPath, text: (el.textContent ?? "").trim() };
    }),
  );
  expect(sr.length, `${name} uses .sr`).toBeGreaterThan(0);
  for (const item of sr) {
    expect(item.display, `${name}: .sr is never display:none`).not.toBe("none");
    expect(item.visibility, `${name}: .sr is never visibility:hidden`).not.toBe("hidden");
    expect(item.position).toBe("absolute");
    expect(item.width).toBe("1px");
    expect(item.height).toBe("1px");
    expect(item.clipPath).toMatch(/inset\(50%\)/);
    expect(item.text.length, `${name}: .sr carries text`).toBeGreaterThan(0);
  }
}

test("screen-reader-only captions use the corrected .sr utility on all four surfaces: still in the accessibility tree (named tables), never display:none", async ({ page }) => {
  // Workspace
  await page.goto(`/partner-reviews/workspace?month=${MONTH}&filter=drafts`);
  await expect(page.getByRole("table", { name: "Partner Reviews workspace" })).toBeVisible();
  await expectCorrectedSr(page, "Workspace");
  // Partner-wise history
  await page.goto(`/partner-reviews/partner/${historyPartnerRef}?month=${MONTH}`);
  await expect(page.getByRole("table", { name: "Monthly trend by review month" })).toBeVisible();
  await expectCorrectedSr(page, "Partner history");
  // Review Detail (Production and Version History tables)
  await page.goto(`/partner-reviews/${historyReviewRef}?tab=production`);
  await expect(page.getByRole("table", { name: "Included Assignments and their Content" })).toBeVisible();
  await expectCorrectedSr(page, "Review Detail / Production");
  await page.goto(`/partner-reviews/${historyReviewRef}?tab=history`);
  await expect(page.getByRole("table", { name: "Review versions" })).toBeVisible();
  await expectCorrectedSr(page, "Review Detail / Version History");
});
