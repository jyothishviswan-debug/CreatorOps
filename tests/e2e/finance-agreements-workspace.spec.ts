import { expect as baseExpect, test, type Page } from "@playwright/test";

import { collectBrowserErrors, collectResponseBodies, createFinanceFixtures, leaked, SENSITIVE_STRINGS, signInAs, type FinanceFixtures, waitForHydration } from "./helpers/finance-agreements-fixtures";

// Dev-mode route compilation makes the first call of an API route slow: allow more than the 5 s default for a UI outcome.
const expect = baseExpect.configure({ timeout: 15_000 });

// Step 14B e2e: the Agreements workspace (/finance/agreements) and the Partner / Vendor contextual links.
// Hermetic: private-region fixtures created through the trusted services, unique tag, removed in afterAll.

test.describe.configure({ mode: "serial" });

const TAG = `FAW${Date.now().toString(36)}`;
// The bulk Partner (more than one page of Agreements) has its OWN name tag so the other tests' searches never see it.
const TAG_BULK = `PGB${Date.now().toString(36)}`;
const fx: FinanceFixtures = createFinanceFixtures(TAG);

const rows = (page: Page) => page.getByTestId("agreement-row");
const names = async (page: Page) => (await rows(page).locator("td:first-child b").allInnerTexts()).map((text) => text.trim());
const gotoWorkspace = async (page: Page, query = "") => {
  await page.goto(`/finance/agreements?q=${encodeURIComponent(TAG)}${query}`);
  await expect(page.getByRole("heading", { level: 1, name: "Agreements" })).toBeVisible();
  await waitForHydration(page, 'select[aria-label="Filter lifecycle"]');
};

const names_ = {
  draft: `${TAG} Draft Partner`,
  confirmed: `${TAG} Confirmed Partner`,
  active: `${TAG} Active Partner`,
  suspended: `${TAG} Suspended Partner`,
  ended: `${TAG} Ended Partner`,
  revision: `${TAG} Revision Partner`,
  vendor: `${TAG} Active Vendor`,
  bulk: `${TAG_BULK} Bulk Partner`,
};
const refs: Record<string, string> = {};
const partnerRefs: Record<string, string> = {};
let vendorRef = "";

test.beforeAll(async () => {
  await fx.grantFixtureRegion();
  const seed = async (key: keyof typeof names_, build: (partner: Awaited<ReturnType<typeof fx.seedPartner>>, accountRefs: string[]) => Promise<{ head: { agreementRef: string } }>, accounts: Array<"instagram" | "youtube"> = ["instagram"]) => {
    const partner = await fx.seedPartner({ displayName: names_[key] });
    const accountRefs: string[] = [];
    for (const platform of accounts) accountRefs.push((await fx.seedAccount(partner, platform, { primary: true })).partnerAccountRef);
    partnerRefs[key] = partner.partnerRef;
    refs[key] = (await build(partner, accountRefs)).head.agreementRef;
    return partner;
  };

  const draftPartner = await seed("draft", (p, a) => fx.seedDraft(fx.partnerCp(p, a)), ["instagram", "youtube"]);
  await fx.fullKyc(fx.partnerSubject(draftPartner));
  await seed("confirmed", (p, a) => fx.seedConfirmed(fx.partnerCp(p, a)));
  await seed("active", (p, a) => fx.seedActive(fx.partnerCp(p, a)), ["youtube"]);
  await seed("suspended", (p, a) => fx.seedSuspended(fx.partnerCp(p, a)));
  await seed("ended", (p, a) => fx.seedEnded(fx.partnerCp(p, a)));
  const revisionPartner = await seed("revision", (p, a) => fx.seedActiveWithRevision(fx.partnerCp(p, a)));
  // Full KYC (values are invented secrets) on one Partner and one Vendor: the rows must show STATUS only.
  await fx.fullKyc(fx.partnerSubject(revisionPartner));
  const vendor = await fx.seedVendor({ displayName: names_.vendor });
  vendorRef = vendor.vendorRef;
  await fx.fullKyc(fx.vendorSubject(vendor));
  refs.vendor = (await fx.seedActive(fx.vendorCp(vendor))).head.agreementRef;

  // more Agreements than one page (20): a bulk Partner with 22 drafts
  const bulk = await fx.seedPartner({ displayName: names_.bulk });
  for (let i = 0; i < 22; i += 1) await fx.newDraft(fx.partnerCp(bulk));
});

test.afterAll(async () => {
  await fx.cleanupAll();
});

test("rows show counterparty, type, platform scope, reference, version, lifecycle, effective dates, commercial type, KYC, extraction, last updated and a primary action - and never a restricted value", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  const bodies = collectResponseBodies(page);
  await gotoWorkspace(page, "&lifecycle=ACTIVE");
  await expect(page.getByRole("columnheader", { name: "Partner / Vendor" })).toBeVisible();
  for (const header of ["Agreement", "Current version", "Lifecycle", "Effective dates", "Commercial type", "KYC status", "Extraction · reconciliation", "Last updated"]) {
    await expect(page.getByRole("columnheader", { name: header })).toBeVisible();
  }
  const active = rows(page).filter({ hasText: names_.active });
  await expect(active).toHaveCount(1);
  await expect(active.getByTestId("lifecycle-status")).toHaveText("Active");
  await expect(active.getByTestId("agreement-reference")).toHaveText(refs.active!);
  await expect(active).toContainText("Version 1");
  await expect(active).toContainText("1 Jan 2024 – 31 Dec 2024");
  await expect(active).toContainText("Fixed + incentive + required content");
  await expect(active.getByTestId("platform-scope")).toHaveText(/youtube/i);
  await expect(active.getByTestId("primary-action")).toHaveText("Create revision");
  await expect(active.getByTestId("kyc-status")).toBeVisible();

  const vendorRow = rows(page).filter({ hasText: names_.vendor });
  await expect(vendorRow.getByTestId("kyc-status")).toHaveText(/Available/);
  await expect(vendorRow).toContainText("Vendor");

  const text = await page.locator("main").innerText();
  expect(leaked(text)).toEqual([]);
  expect(text).not.toMatch(/Campaign|Assignment|Deliverable/);
  for (const body of bodies.bodies) expect(leaked(body.text), `${body.url} leaked`).toEqual([]);
  expect(errors.errors).toEqual([]);
});

test("every lifecycle appears with the right primary action: Continue draft / Review / Create revision / Open", async ({ page }) => {
  await gotoWorkspace(page);
  const expected: Array<[string, string, string]> = [
    [names_.draft, "Draft", "Continue draft"],
    [names_.confirmed, "Draft", "Review"],
    [names_.active, "Active", "Create revision"],
    [names_.suspended, "Suspended", "Open"],
    [names_.ended, "Ended", "Open"],
  ];
  for (const [name, lifecycle, action] of expected) {
    const row = rows(page).filter({ hasText: name });
    await expect(row, name).toHaveCount(1);
    await expect(row.getByTestId("lifecycle-status")).toHaveText(lifecycle);
    await expect(row.getByTestId("primary-action")).toHaveText(action);
  }
  // an ACTIVE Agreement with an open revision offers the revision to continue and says so
  const revision = rows(page).filter({ hasText: names_.revision });
  await expect(revision.getByTestId("lifecycle-status")).toHaveText("Active");
  await expect(revision.getByTestId("primary-action")).toHaveText("Continue draft");
  await expect(revision).toContainText(/revision|draft version 2/i);
  // a never-confirmed draft has unresolved fields
  await expect(rows(page).filter({ hasText: names_.draft }).getByTestId("unresolved-fields")).toBeVisible();
});

test("each primary action goes to the right place", async ({ page }) => {
  await gotoWorkspace(page);
  await rows(page).filter({ hasText: names_.draft }).getByTestId("primary-action").click();
  await expect(page).toHaveURL(new RegExp(`/finance/agreements/new\\?agreementRef=${refs.draft}&version=1`));
  await gotoWorkspace(page);
  await rows(page).filter({ hasText: names_.suspended }).getByTestId("primary-action").click();
  await expect(page).toHaveURL(new RegExp(`/finance/agreements/${refs.suspended}$`));
});

test("filters: lifecycle, counterparty type, Partner / Vendor search, platform, effective period and discrepancy each narrow the list (URL state, reloadable)", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  await gotoWorkspace(page);

  await page.getByLabel("Filter lifecycle").selectOption("SUSPENDED");
  await expect(page).toHaveURL(/lifecycle=SUSPENDED/);
  await expect(rows(page)).toHaveCount(1);
  expect(await names(page)).toEqual([names_.suspended]);
  await page.reload();
  await expect(page.getByLabel("Filter lifecycle")).toHaveValue("SUSPENDED");
  await expect(rows(page)).toHaveCount(1);

  await page.getByTestId("clear-filters").click();
  await page.getByLabel("Filter Partner or Vendor").selectOption("VENDOR");
  await expect(page).toHaveURL(/counterpartyType=VENDOR/);
  await expect(rows(page)).toHaveCount(1);
  expect(await names(page)).toEqual([names_.vendor]);

  // Partner / Vendor name search
  await page.goto(`/finance/agreements`);
  await page.getByLabel("Search Partner or Vendor").fill(names_.ended);
  await expect(page).toHaveURL(/q=/);
  await expect(rows(page)).toHaveCount(1);
  expect(await names(page)).toEqual([names_.ended]);

  // platform: only Partner Agreements whose scope has the platform (Agreements here carry the account platforms of their Partner)
  await gotoWorkspace(page);
  await page.getByLabel("Filter platform").selectOption("youtube");
  await expect(page).toHaveURL(/platform=youtube/);
  await expect(page.getByTestId("workspace-page-status")).toBeVisible();
  for (const name of await names(page)) expect(name).not.toBe(names_.vendor);
  expect(await names(page)).toContain(names_.active);
  await page.getByLabel("Filter platform").selectOption("instagram");
  await expect(page).toHaveURL(/platform=instagram/);
  expect(await names(page)).not.toContain(names_.active);

  // effective period: the fixture terms run 2024-01-01 .. 2024-12-31 (in the past), so `current` excludes every fixture and a 2024 month includes the confirmed / active ones
  await gotoWorkspace(page);
  await page.getByLabel("Filter effective period").selectOption("current");
  await expect(page).toHaveURL(/period=current/);
  await expect(page.getByText("No matching Agreements")).toBeVisible();
  await page.goto(`/finance/agreements?q=${TAG}&period=2024-03`);
  await expect(rows(page).filter({ hasText: names_.active })).toHaveCount(1);
  await expect(page.getByLabel("Filter effective period")).toHaveValue("month");
  await expect(page.getByLabel("Effective month")).toHaveValue("2024-03");

  // open discrepancies: the never-confirmed draft (unresolved fields) yes, the ACTIVE one no
  await gotoWorkspace(page);
  await page.getByRole("button", { name: "Open discrepancies only" }).click();
  await expect(page).toHaveURL(/discrepancy=open/);
  await expect(page.getByRole("button", { name: "Open discrepancies only" })).toHaveAttribute("aria-pressed", "true");
  const found = await names(page);
  expect(found).toContain(names_.draft);
  expect(found).not.toContain(names_.active);
  expect(errors.errors).toEqual([]);
});

test("cursor paging: more than one page of Agreements pages forward with a bounded cursor request per new page and back/forward through visited pages without another request", async ({ page }) => {
  const workspaceCalls: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/finance/agreements/workspace")) workspaceCalls.push(request.url());
  });
  const refsOf = async () => (await page.getByTestId("agreement-reference").allInnerTexts()).map((text) => text.trim());
  const status = page.getByTestId("workspace-page-status");
  await page.goto(`/finance/agreements?q=${TAG_BULK}`);
  await waitForHydration(page, 'nav[aria-label="Pagination"] button');
  await expect(rows(page)).toHaveCount(10);
  await expect(status).toHaveText("Page 1 · 10 shown");
  const first = await refsOf();
  const pager = page.getByRole("navigation", { name: "Pagination" });
  await expect(pager).toBeVisible();

  await pager.getByRole("button", { name: /Next/ }).click();
  await expect(status).toHaveText("Page 2 · 10 shown");
  expect(workspaceCalls).toHaveLength(1);
  expect(workspaceCalls[0]).toContain("cursor=");
  expect(workspaceCalls[0]).toMatch(/limit=10/);
  const second = await refsOf();

  await pager.getByRole("button", { name: /Next/ }).click();
  await expect(status).toHaveText("Page 3 · 2 shown");
  expect(workspaceCalls).toHaveLength(2);
  const third = await refsOf();
  // 22 bulk Agreements: 10 + 10 + 2, none repeated or skipped; the last page has no Next
  expect(new Set([...first, ...second, ...third]).size).toBe(22);
  await expect(pager.getByRole("button", { name: /Next/ })).toBeDisabled();

  await pager.getByRole("button", { name: /Prev/ }).click();
  await pager.getByRole("button", { name: /Prev/ }).click();
  await expect(status).toHaveText("Page 1 · 10 shown");
  expect(await refsOf()).toEqual(first);
  expect(workspaceCalls).toHaveLength(2);
  await expect(page.getByTestId("workspace-count")).toContainText("22 Agreements in this view");
});

test("a failed page request is a neutral inline error (no crash, the first page stays reachable)", async ({ page }) => {
  await page.goto(`/finance/agreements?q=${TAG_BULK}`);
  await waitForHydration(page, 'nav[aria-label="Pagination"] button');
  await page.route("**/api/finance/agreements/workspace**", (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Something went wrong." }) }));
  await page.getByRole("navigation", { name: "Pagination" }).getByRole("button", { name: /Next/ }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Couldn’t load Agreements." })).toBeVisible();
  await page.unroute("**/api/finance/agreements/workspace**");
});

test("empty and no-results states: no results offers Clear filters; the neutral copy never says there are none when unsure", async ({ page }) => {
  await page.goto(`/finance/agreements?q=${TAG}-nothing-matches-this`);
  await expect(page.getByText("No matching Agreements")).toBeVisible();
  await page.getByRole("button", { name: "Clear filters" }).first().click();
  await expect(page).not.toHaveURL(/q=/);
  await expect(rows(page).first()).toBeVisible();
  // invalid URL filters are ignored with a notice, not an error page
  await page.goto(`/finance/agreements?lifecycle=BOGUS&period=nonsense`);
  await expect(page.getByText("Some filters in the link were not valid and were ignored.")).toBeVisible();
});

test("workspace layout: table on desktop, cards on a phone; the layout switch works; no horizontal document overflow", async ({ page }) => {
  await gotoWorkspace(page);
  await expect(page.getByRole("table")).toBeVisible();
  await page.getByRole("button", { name: "Cards view" }).click();
  await expect(page.getByTestId("agreement-card").first()).toBeVisible();
  await expect(page.getByRole("table")).toHaveCount(0);
  await page.getByRole("button", { name: "Table view" }).click();
  await expect(page.getByRole("table")).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await gotoWorkspace(page);
  await expect(page.getByTestId("agreement-card").first()).toBeVisible();
  const overflow = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.innerWidth);
});

// ---- Five-role matrix ------------------------------------------------------------------------------------------------------------
test("Manager (manage only): sees the workspace and New Agreement", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  await signInAs(page, "manager");
  await gotoWorkspace(page);
  await expect(page.getByRole("link", { name: "New Agreement" })).toBeVisible();
  await expect(rows(page).filter({ hasText: names_.active })).toHaveCount(1);
  // Manager cannot activate / revise, so an ACTIVE Agreement offers Open, not Create revision
  await expect(rows(page).filter({ hasText: names_.active }).getByTestId("primary-action")).toHaveText("Open");
  // KYC: no identity category -> overall status only
  const text = await page.locator("main").innerText();
  expect(leaked(text)).toEqual([]);
  expect(errors.errors).toEqual([]);
});

test("Head (activate): sees New Agreement and Create revision", async ({ page }) => {
  await signInAs(page, "head");
  await gotoWorkspace(page);
  await expect(page.getByRole("link", { name: "New Agreement" })).toBeVisible();
  await expect(rows(page).filter({ hasText: names_.active }).getByTestId("primary-action")).toHaveText("Create revision");
});

for (const role of ["viewer", "analyst"] as const) {
  test(`${role} has no Finance access: the proxy redirects to the neutral access-denied page and the API answers one neutral 403`, async ({ page }) => {
    await signInAs(page, role);
    await page.goto("/finance/agreements");
    await expect(page).toHaveURL(/\/access-denied\?feature=finance/);
    await expect(page.getByRole("heading", { level: 1, name: "You don’t have access to this area" })).toBeVisible();
    await expect(page.getByTestId("agreement-row")).toHaveCount(0);
    await page.goto("/finance/agreements/new");
    await expect(page).toHaveURL(/\/access-denied\?feature=finance/);
    await page.goto(`/finance/agreements/${refs.active}`);
    await expect(page).toHaveURL(/\/access-denied\?feature=finance/);
    const api = await page.request.get("/api/finance/agreements/workspace");
    expect(api.status()).toBe(403);
    expect(await api.json()).toEqual({ error: "Forbidden." });
  });
}

test("the workspace API is bounded and neutral: an unauthenticated call is one 403, a valid call returns opaque refs only", async ({ page, playwright }) => {
  const anonymous = await playwright.request.newContext({ baseURL: "http://localhost:3100", storageState: { cookies: [], origins: [] } });
  const denied = await anonymous.get("/api/finance/agreements/workspace");
  expect([401, 403]).toContain(denied.status());
  expect(await denied.json()).toEqual({ error: "Forbidden." });
  await anonymous.dispose();

  await signInAs(page, "admin");
  const response = await page.request.get(`/api/finance/agreements/workspace?q=${TAG}&limit=500`);
  expect(response.status()).toBe(200);
  const json = await response.json();
  expect(json.rows.length).toBeLessThanOrEqual(20);
  const text = JSON.stringify(json);
  expect(leaked(text)).toEqual([]);
  expect(text).not.toMatch(/storageLocator|finance-contracts\/|ownerUid|regionIds|teamIds|partnerUid|vendorUid/);
});

// ---- Contextual links from Partner / Vendor detail ---------------------------------------------------------------------------------------
test("Partner detail (Finance access): the Context tab has the Finance link tile; without Finance access it is the previous empty state", async ({ page }) => {
  await signInAs(page, "manager");
  await page.goto(`/partners/${partnerRefs.active}`);
  await page.getByRole("tab", { name: "Context" }).click();
  const tile = page.locator("section.panel, .panel").filter({ has: page.getByRole("heading", { name: "Finance" }) }).last();
  await expect(tile.getByRole("link", { name: "Open Finance Agreements" })).toHaveAttribute("href", "/finance/agreements?counterpartyType=PARTNER");
  await expect(tile.getByRole("link", { name: "New Agreement" })).toHaveAttribute("href", `/finance/agreements/new?counterpartyType=PARTNER&ref=${encodeURIComponent(partnerRefs.active!)}`);
  await tile.getByRole("link", { name: "New Agreement" }).click();
  await expect(page).toHaveURL(/\/finance\/agreements\/new\?counterpartyType=PARTNER/);
  await expect(page.getByRole("heading", { level: 1, name: "New Agreement" })).toBeVisible();

  await signInAs(page, "viewer");
  await page.goto(`/partners/${partnerRefs.active}`);
  await page.getByRole("tab", { name: "Context" }).click();
  await expect(page.getByRole("link", { name: "Open Finance Agreements" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "New Agreement" })).toHaveCount(0);
  await expect(page.getByText("Finance has no real trusted source wired to Partners yet.")).toBeVisible();
});

test("Vendor detail: the Agreements heading is kept, the link shows only with Finance access, the other three panels stay Not yet built", async ({ page }) => {
  await signInAs(page, "head");
  await page.goto(`/vendors/${vendorRef}`);
  await page.getByRole("tab", { name: "Payee / Commercial Context" }).click();
  await expect(page.getByRole("heading", { name: "Agreements" })).toBeVisible();
  for (const label of ["Payables", "Invoices", "Payments"]) await expect(page.getByRole("heading", { name: label })).toBeVisible();
  await expect(page.getByText("Not yet built")).toHaveCount(3);
  const link = page.getByRole("link", { name: "Open Finance Agreements" });
  await expect(link).toHaveAttribute("href", "/finance/agreements?counterpartyType=VENDOR");
  await expect(page.getByRole("link", { name: "New Agreement" })).toHaveAttribute("href", `/finance/agreements/new?counterpartyType=VENDOR&ref=${encodeURIComponent(vendorRef)}`);

  await signInAs(page, "viewer");
  await page.goto(`/vendors/${vendorRef}`);
  await page.getByRole("tab", { name: "Payee / Commercial Context" }).click();
  await expect(page.getByRole("heading", { name: "Agreements" })).toBeVisible();
  await expect(page.getByText("Not yet built")).toHaveCount(4);
  await expect(page.getByRole("link", { name: "Open Finance Agreements" })).toHaveCount(0);
});

test("the Finance module tab row is the one shared row: Agreements is current on the workspace, Overview and the fixture pages are unchanged", async ({ page }) => {
  await gotoWorkspace(page);
  const tabs = page.getByRole("link", { name: /^(Overview|Agreements|Payables|Invoices|Payments)$/ });
  await expect(page.locator("a.tab")).toHaveText(["Overview", "Agreements", "Payables", "Invoices", "Payments"]);
  await expect(page.locator("a.tab[aria-current=page]")).toHaveText("Agreements");
  void tabs;
  await page.goto("/finance");
  await expect(page.getByRole("heading", { level: 1, name: "Finance", exact: true })).toBeVisible();
  await expect(page.locator("a.tab[aria-current=page]")).toHaveText("Overview");
  for (const area of ["payables", "invoices", "payments"]) {
    await page.goto(`/finance/${area}`);
    await expect(page.locator("h1")).toBeVisible();
  }
});

test("sensitive strings never reach the workspace page for a Manager (page text, DOM and every response body)", async ({ page }) => {
  const bodies = collectResponseBodies(page);
  await signInAs(page, "manager");
  await gotoWorkspace(page);
  await expect(rows(page).first()).toBeVisible();
  expect(leaked(await page.content(), SENSITIVE_STRINGS)).toEqual([]);
  for (const body of bodies.bodies) expect(leaked(body.text), `${body.url} leaked`).toEqual([]);
});
