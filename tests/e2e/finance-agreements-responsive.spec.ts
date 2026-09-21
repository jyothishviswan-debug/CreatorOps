import { expect as baseExpect, test, type Page } from "@playwright/test";

import { collectBrowserErrors, createFinanceFixtures, noDocumentOverflow, signInAs, VIEWPORTS, waitForHydration, type FinanceFixtures } from "./helpers/finance-agreements-fixtures";

// Dev-mode route compilation makes the first call of a route slow: allow more than the 5 s default for a UI outcome.
const expect = baseExpect.configure({ timeout: 15_000 });

// Step 14B e2e: RESPONSIVE + accessibility certification of the Workspace, the Intake (with a draft, an attached extraction and
// cross-verification rows) and the Agreement detail (every tab) at 1440 / 1200 / 1050 / 760 / 390 / 375, measured on
// document.documentElement. Also: dropdowns stay in the viewport, dialogs stay usable, no console error / pageerror on any page,
// and the review screenshots (saved under SHOTS_DIR when the env var is set).

test.describe.configure({ mode: "serial" });

const TAG = `FAR${Date.now().toString(36)}`;
const fx: FinanceFixtures = createFinanceFixtures(TAG);
const SHOTS_DIR = process.env.SHOTS_DIR ?? "";

const REFS: Record<string, string> = {};
let partnerRef = "";
let vendorRef = "";

test.beforeAll(async () => {
  await fx.grantFixtureRegion();
  const long = `${TAG} A Partner With A Deliberately Very Long Display Name To Prove Long Names Wrap Instead Of Widening The Page`;
  const partner = await fx.seedPartner({ displayName: long, email: "a-very-long-email-address-for-wrapping-checks@a-very-long-domain-name-example.test", phone: null });
  partnerRef = partner.partnerRef;
  const ig = await fx.seedAccount(partner, "instagram", { handle: "a_very_long_handle_for_wrapping_checks_on_narrow_screens", primary: true });
  const yt = await fx.seedAccount(partner, "youtube", { handle: "yt_handle", primary: true });
  // the intake fixture: a draft with the sample contract extracted + attached: Match / Mismatch / Missing / Restricted / Unavailable rows
  REFS.intake = (await fx.attachContract(await fx.newDraft(fx.partnerCp(partner, [ig.partnerAccountRef, yt.partnerAccountRef])))).head.agreementRef;

  const active = await fx.seedPartner({ displayName: `${TAG} Active Partner` });
  const activeIg = await fx.seedAccount(active, "instagram", { primary: true });
  await fx.fullKyc(fx.partnerSubject(active));
  REFS.active = (await fx.seedActiveWithRevision(fx.partnerCp(active, [activeIg.partnerAccountRef]))).head.agreementRef;

  const vendor = await fx.seedVendor({ displayName: `${TAG} Active Vendor` });
  vendorRef = vendor.vendorRef;
  REFS.vendor = (await fx.seedActive(fx.vendorCp(vendor))).head.agreementRef;
  for (const [key, build] of [
    ["suspended", (cp: ReturnType<FinanceFixtures["partnerCp"]>) => fx.seedSuspended(cp)],
    ["ended", (cp: ReturnType<FinanceFixtures["partnerCp"]>) => fx.seedEnded(cp)],
    ["confirmed", (cp: ReturnType<FinanceFixtures["partnerCp"]>) => fx.seedConfirmed(cp)],
    ["draft", (cp: ReturnType<FinanceFixtures["partnerCp"]>) => fx.seedDraft(cp)],
  ] as const) {
    const p = await fx.seedPartner({ displayName: `${TAG} ${key} Partner` });
    const a = await fx.seedAccount(p, "instagram", { primary: true });
    REFS[key] = (await build(fx.partnerCp(p, [a.partnerAccountRef]))).head.agreementRef;
  }
});

test.afterAll(async () => {
  await fx.cleanupAll();
});

const shot = async (page: Page, name: string) => {
  if (!SHOTS_DIR) return;
  await page.addStyleTag({ content: ".topbar{position:static !important}" });
  await page.screenshot({ path: `${SHOTS_DIR}/${name}.png` });
};
const shotOf = async (page: Page, locatorTestId: string, name: string) => {
  if (!SHOTS_DIR) return;
  await page.addStyleTag({ content: ".topbar{position:static !important}" });
  await page.getByTestId(locatorTestId).screenshot({ path: `${SHOTS_DIR}/${name}.png` });
};

async function expectNoOverflow(page: Page, label: string) {
  const { scrollWidth, innerWidth } = await noDocumentOverflow(page);
  expect(scrollWidth, `${label}: document scrolls horizontally (${scrollWidth} > ${innerWidth})`).toBeLessThanOrEqual(innerWidth);
}

// The elements that stick out of the viewport on the right (outside a horizontally scrolling table wrapper): diagnostics + a strict check.
async function protrudingElements(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const width = window.innerWidth;
    const bad: string[] = [];
    document.querySelectorAll("main *").forEach((element) => {
      const el = element as HTMLElement;
      if (el.closest(".tablewrap") || el.closest("[hidden]") || el.closest("dialog:not([open])")) return;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      if (rect.right > width + 1) bad.push(`${el.tagName.toLowerCase()}.${el.className}: right=${Math.round(rect.right)} > ${width}`);
    });
    return bad.slice(0, 8);
  });
}

async function gotoIntake(page: Page) {
  await page.goto(`/finance/agreements/new?agreementRef=${REFS.intake}&version=1`);
  await expect(page.getByRole("heading", { level: 1, name: "Agreement draft" })).toBeVisible();
  await waitForHydration(page, '[data-testid="agreement-intake"] button');
  await expect(page.getByTestId("cross-verification-summary")).toContainText(/fields? need/);
}

for (const width of VIEWPORTS) {
  test.describe(`at ${width}px`, () => {
    test.use({ viewport: { width, height: width >= 1200 ? 900 : 844 } });

    test(`Workspace: no document-level horizontal overflow, table on wide / cards on narrow, filters fit, dropdown stays inside`, async ({ page }) => {
      const errors = collectBrowserErrors(page);
      await page.goto(`/finance/agreements?q=${TAG}`);
      await expect(page.getByRole("heading", { level: 1, name: "Agreements" })).toBeVisible();
      await waitForHydration(page, 'select[aria-label="Filter lifecycle"]');
      await expect(page.getByTestId("agreement-row").or(page.getByTestId("agreement-card")).first()).toBeVisible();
      await expectNoOverflow(page, `workspace ${width}`);
      expect(await protrudingElements(page)).toEqual([]);
      if (width <= 760) await expect(page.getByTestId("agreement-card").first()).toBeVisible();
      else await expect(page.getByRole("table")).toBeVisible();
      // every filter control is within the viewport
      for (const label of ["Search Partner or Vendor", "Filter Partner or Vendor", "Filter lifecycle", "Filter platform", "Filter effective period"]) {
        const box = await page.getByLabel(label).boundingBox();
        expect(box, label).not.toBeNull();
        expect(box!.x + box!.width, `${label} inside the viewport at ${width}`).toBeLessThanOrEqual(width + 1);
        expect(box!.x).toBeGreaterThanOrEqual(0);
      }
      if (width === 1440) {
        await shot(page, "workspace-1440");
        await page.getByLabel("Filter lifecycle").selectOption("ACTIVE");
        await expect(page).toHaveURL(/lifecycle=ACTIVE/);
      }
      if (width === 390) await shot(page, "workspace-390");
      expect(errors.errors).toEqual([]);
    });

    test(`Intake: New Agreement (no draft) fits; the counterparty dropdown list stays inside the viewport`, async ({ page }) => {
      const errors = collectBrowserErrors(page);
      await page.goto("/finance/agreements/new");
      await expect(page.getByRole("heading", { level: 1, name: "New Agreement" })).toBeVisible();
      await waitForHydration(page, '[role="radio"]');
      await page.getByRole("radio", { name: /^Instagram \+ YouTube Partner/ }).click();
      const box = page.getByRole("combobox", { name: "Search Partner" });
      await box.click();
      await box.fill(TAG);
      const list = page.getByRole("listbox", { name: "Partner search results" });
      await expect(list.getByRole("option").first()).toBeVisible();
      const rect = (await list.boundingBox())!;
      expect(rect.x).toBeGreaterThanOrEqual(0);
      expect(rect.x + rect.width, `dropdown inside the viewport at ${width}`).toBeLessThanOrEqual(width + 1);
      await expectNoOverflow(page, `new intake ${width}`);
      // pick the long-named Partner: the long name wraps and never widens the page
      await list.getByRole("option", { name: /Deliberately Very Long/ }).click();
      await expect(page.getByTestId("existing-details")).toBeVisible();
      await expectNoOverflow(page, `new intake with a long name ${width}`);
      expect(await protrudingElements(page)).toEqual([]);
      expect(errors.errors).toEqual([]);
    });

    test(`Intake: a draft with an attached extraction and cross-verification rows - no overflow, grids collapse, cross-verification is a table (>1050) or stacked cards`, async ({ page }) => {
      const errors = collectBrowserErrors(page);
      await gotoIntake(page);
      await expectNoOverflow(page, `intake ${width}`);
      const offenders = await protrudingElements(page);
      expect(offenders, `elements sticking out at ${width}`).toEqual([]);

      const wide = width > 1050;
      const cv = page.getByTestId("intake-cross_verification");
      if (wide) {
        await expect(cv.locator("tr[data-state]").first()).toBeVisible();
        await expect(cv.locator("li.record[data-state]")).toHaveCount(0);
      } else {
        await expect(cv.locator("li.record[data-state]").first()).toBeVisible();
        await expect(cv.locator("tr[data-state]")).toHaveCount(0);
        // stacked: each card shows the four facts one below the other
        const card = cv.locator("li.record[data-state]", { hasText: "Email address" });
        await expect(card).toContainText("CreatorOps value");
        await expect(card).toContainText("Agreement value");
        await expect(card.getByRole("button", { name: /Use Agreement value for Email address/ })).toBeVisible();
      }
      // a status chip never forces its column / the page wider: every row is inside the viewport
      const rows = cv.locator(wide ? "tr[data-state]" : "li.record[data-state]");
      const count = await rows.count();
      expect(count).toBeGreaterThan(8);
      for (let i = 0; i < Math.min(count, 12); i += 1) {
        const rect = (await rows.nth(i).boundingBox())!;
        expect(rect.x + rect.width, `row ${i} inside the viewport at ${width}`).toBeLessThanOrEqual(width + 1);
      }
      // the form / aside grid collapses: one column at <= 760 (the progress aside comes first)
      const layout = await page.evaluate(() => {
        const form = document.querySelector('[data-testid="agreement-intake"]') as HTMLElement;
        return getComputedStyle(form).gridTemplateColumns.split(" ").length;
      });
      if (width <= 760) expect(layout).toBe(1);
      else expect(layout).toBe(2);

      if (width === 1440) {
        await page.getByTestId("intake-agreement_for").scrollIntoViewIfNeeded();
        await shot(page, "intake-1440-top");
        await page.getByTestId("intake-cross_verification").getByRole("heading", { name: "Contact details" }).scrollIntoViewIfNeeded();
        await shotOf(page, "intake-cross_verification", "intake-1440-cross-verification");
        await shotOf(page, "intake-commercial_terms", "intake-1440-commercial-terms");
        await shotOf(page, "intake-kyc", "intake-1440-kyc");
        await shotOf(page, "intake-review", "intake-1440-review-confirm");
      }
      if (width === 1440) {
        // a Partner with KYC on record (revision draft): the CreatorOps identity values print MASKED and the KYC section reads Available
        await page.goto(`/finance/agreements/new?agreementRef=${REFS.active}&version=2`);
        await expect(page.getByRole("heading", { level: 1, name: "Agreement revision" })).toBeVisible();
        await expect(page.getByTestId("intake-kyc").getByText("Available").first()).toBeVisible();
        await expect(page.getByTestId("intake-cross_verification").locator("tr[data-state]").first()).toBeVisible();
        await shotOf(page, "intake-cross_verification", "intake-1440-cross-verification-kyc-on-record");
        await shotOf(page, "intake-kyc", "intake-1440-kyc-available");
      }
      if (width === 390) await shotOf(page, "intake-cross_verification", "intake-390-cross-verification-stacked");
      expect(errors.errors).toEqual([]);
    });

    test(`No first-paint layout flash: the Workspace and Cross-verification never render the wrong layout first (no table-then-cards, no cards-then-table)`, async ({ page }) => {
      await page.addInitScript(() => {
        const seen = { workspaceTable: false, workspaceCards: false, cvTable: false, cvCards: false };
        (window as unknown as { __seen: typeof seen }).__seen = seen;
        const check = () => {
          if (document.querySelector('[data-testid="agreement-row"]')) seen.workspaceTable = true;
          if (document.querySelector('[data-testid="agreement-card"]')) seen.workspaceCards = true;
          if (document.querySelector("tr[data-state]")) seen.cvTable = true;
          if (document.querySelector("li.record[data-state]")) seen.cvCards = true;
        };
        new MutationObserver(check).observe(document, { childList: true, subtree: true });
      });
      const seen = () => page.evaluate(() => (window as unknown as { __seen: Record<string, boolean> }).__seen);

      await page.goto(`/finance/agreements?q=${TAG}`);
      await expect(page.getByTestId("agreement-row").or(page.getByTestId("agreement-card")).first()).toBeVisible();
      let flags = await seen();
      if (width <= 760) expect({ table: flags.workspaceTable, cards: flags.workspaceCards }, `workspace at ${width}`).toEqual({ table: false, cards: true });
      else expect({ table: flags.workspaceTable, cards: flags.workspaceCards }, `workspace at ${width}`).toEqual({ table: true, cards: false });

      await page.goto(`/finance/agreements/new?agreementRef=${REFS.intake}&version=1`);
      await expect(page.getByTestId("intake-cross_verification").locator("tr[data-state], li.record[data-state]").first()).toBeVisible();
      flags = await seen();
      if (width > 1050) expect({ table: flags.cvTable, cards: flags.cvCards }, `cross-verification at ${width}`).toEqual({ table: true, cards: false });
      else expect({ table: flags.cvTable, cards: flags.cvCards }, `cross-verification at ${width}`).toEqual({ table: false, cards: true });
    });

    test(`Intake: dialogs stay inside the viewport and are accessible (KYC upload dialog, Update Partner dialog, Confirm dialog)`, async ({ page }) => {
      await gotoIntake(page);
      // Update Partner dialog (a mismatch row first needs the Agreement's own decision)
      await page.getByTestId("intake-cross_verification").getByRole("button", { name: "Use Agreement value for Email address" }).click();
      await expect(page.getByTestId("intake-cross_verification").getByRole("button", { name: /^Update Partner.* after confirmation for Email address/ })).toBeVisible();
      await page.getByTestId("intake-cross_verification").getByRole("button", { name: /^Update Partner.* after confirmation for Email address/ }).click();
      let dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      let rect = (await dialog.boundingBox())!;
      expect(rect.x).toBeGreaterThanOrEqual(-1);
      expect(rect.x + rect.width).toBeLessThanOrEqual(width + 1);
      expect(rect.y).toBeGreaterThanOrEqual(-1);
      await expect(dialog).toHaveAttribute("aria-labelledby", /.+/);
      await expectNoOverflow(page, `update dialog ${width}`);
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();

      // KYC dialog (missing KYC on this Partner; the Admin holds the identity category)
      await page.getByTestId("intake-kyc").getByRole("button", { name: "Upload / Update KYC for PAN" }).click();
      dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      rect = (await dialog.boundingBox())!;
      expect(rect.x + rect.width).toBeLessThanOrEqual(width + 1);
      await expect(dialog.getByRole("button", { name: "Close dialog" })).toBeVisible();
      await expectNoOverflow(page, `kyc dialog ${width}`);
      if (width === 375) await shot(page, "intake-375-kyc-dialog");
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
    });

    test(`Agreement detail: every tab has no horizontal overflow, panels stack, the tab strip is reachable`, async ({ page }) => {
      const errors = collectBrowserErrors(page);
      for (const [key, tabName] of [
        ["overview", ""],
        ["terms", "terms"],
        ["verification", "verification"],
        ["kyc", "kyc"],
        ["versions", "versions"],
        ["activity", "activity"],
      ] as const) {
        await page.goto(`/finance/agreements/${REFS.active}${tabName ? `?tab=${tabName}` : ""}`);
        await expect(page.getByRole("tablist", { name: "Agreement sections" })).toBeVisible();
        await waitForHydration(page, '[role="tab"]');
        await expect(page.locator("main .panel").first()).toBeVisible();
        await expectNoOverflow(page, `detail ${key} ${width}`);
        expect(await protrudingElements(page), `detail ${key} ${width}`).toEqual([]);
        // the six tabs are all reachable (visible or scrollable inside their own strip - never pushing the document)
        await expect(page.getByRole("tab")).toHaveCount(6);
        if (width === 1440 && ["overview", "terms", "verification", "versions"].includes(key)) await shot(page, `detail-${key}-1440`);
        if (width === 390 && key === "overview") await shot(page, "detail-overview-390");
      }
      // long text (services mandated, incentive lines) wraps on the Terms tab
      await page.goto(`/finance/agreements/${REFS.vendor}?tab=terms`);
      await expect(page.getByRole("heading", { name: "Payment-affecting terms" })).toBeVisible();
      await expectNoOverflow(page, `vendor terms ${width}`);
      expect(errors.errors).toEqual([]);
    });

    test(`Lifecycle dialogs on the detail page stay inside the viewport (Suspend needs a reason; Escape restores focus)`, async ({ page }) => {
      await signInAs(page, "head");
      await page.goto(`/finance/agreements/${REFS.active}`);
      await waitForHydration(page, '[role="tab"]');
      const trigger = page.getByRole("button", { name: "Suspend Agreement", exact: true });
      await trigger.click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      const rect = (await dialog.boundingBox())!;
      expect(rect.x + rect.width).toBeLessThanOrEqual(width + 1);
      expect(rect.x).toBeGreaterThanOrEqual(-1);
      await expectNoOverflow(page, `lifecycle dialog ${width}`);
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(trigger).toBeFocused();
    });
  });
}

test("review screenshots: Partner detail Context tab tile and the Vendor detail Agreements panel", async ({ page }) => {
  test.skip(!SHOTS_DIR, "screenshots only when SHOTS_DIR is set");
  await page.setViewportSize({ width: 1440, height: 900 });
  await signInAs(page, "head");
  await page.goto(`/partners/${partnerRef}`);
  await page.getByRole("tab", { name: "Context" }).click();
  await expect(page.getByRole("link", { name: "Open Finance Agreements" })).toBeVisible();
  await page.addStyleTag({ content: ".topbar{position:static !important}" });
  await page.screenshot({ path: `${SHOTS_DIR}/partner-context-finance-tile.png` });
  await page.goto(`/vendors/${vendorRef}`);
  await page.getByRole("tab", { name: "Payee / Commercial Context" }).click();
  await expect(page.getByRole("link", { name: "Open Finance Agreements" })).toBeVisible();
  await page.addStyleTag({ content: ".topbar{position:static !important}" });
  await page.screenshot({ path: `${SHOTS_DIR}/vendor-agreements-panel.png` });
});
