import { expect as baseExpect, test, type Page } from "@playwright/test";

import { createPayable } from "@/server/finance-payables";

import { collectBrowserErrors, noDocumentOverflow, waitForHydration } from "./helpers/finance-agreements-fixtures";
import { createPayablesFixtures, signInAs, VIEWPORTS, type PayablesFixtures } from "./helpers/finance-payables-fixtures";

// Dev-mode route compilation makes the first call of an API route slow: allow more than the 5 s default.
const expect = baseExpect.configure({ timeout: 20_000 });

// Step 15B e2e: the focused Payables UI suite.
//   - Workspace: loads, summary strip, filters, Create Payable action.
//   - Create: a deterministic Vendor Payable (Agreement-only, no unresolved items) and a
//     FINANCE_REVIEW_REQUIRED Partner Payable (under-delivered qualifying content + an unmeasured
//     incentive slab), including a manual adjustment applied mid-wizard.
//   - Detail: all four tabs, Ready for invoice, Void (read-only afterward).
//   - Six-width responsive certification + no console errors.
// Hermetic: private-region fixtures created through the TRUSTED Finance Agreements / Partner Reviews
// services, unique tag, removed in afterAll. Uses the admin identity (holds every Payables permission).

test.describe.configure({ mode: "serial" });

const TAG = `FPB${Date.now().toString(36)}`;
const fx: PayablesFixtures = createPayablesFixtures(TAG);

let vendorPayableRef = "";
let partnerPayableRef = "";

async function expectNoOverflow(page: Page, label: string) {
  const { scrollWidth, innerWidth } = await noDocumentOverflow(page);
  expect(scrollWidth, `${label}: document scrolls horizontally (${scrollWidth} > ${innerWidth})`).toBeLessThanOrEqual(innerWidth);
}

test.afterAll(async () => {
  await fx.cleanupAll();
});

test.describe("Workspace", () => {
  test("loads, shows the summary strip, filter controls, and a Create Payable action", async ({ page }) => {
    const errors = collectBrowserErrors(page);
    await signInAs(page, "admin");
    await page.goto("/finance/payables");
    await expect(page.getByRole("heading", { level: 1, name: "Payables" })).toBeVisible();
    await expect(page.getByTestId("workspace-summary-strip")).toBeVisible();
    await expect(page.getByRole("link", { name: "Create Payable" })).toBeVisible();
    await waitForHydration(page, 'select[aria-label="Filter status"]');
    for (const label of ["Filter status", "Filter Partner or Vendor", "Search counterparty", "Filter commercial period"]) {
      await expect(page.getByLabel(label)).toBeVisible();
    }
    expect(errors.errors).toEqual([]);
  });
});

test.describe("Create Payable", () => {
  test("Source -> Review amount -> Confirm -> Create: a deterministic Vendor Payable", async ({ page }) => {
    const errors = collectBrowserErrors(page);
    const displayName = `${TAG} Deterministic Vendor`;
    const basis = await fx.seedDeterministicVendorBasis(displayName);

    await signInAs(page, "admin");
    await page.goto("/finance/payables/new");
    await expect(page.getByRole("heading", { level: 1, name: "Create Payable" })).toBeVisible();

    await page.getByLabel("Counterparty type").selectOption("VENDOR");
    await page.getByLabel("Counterparty", { exact: true }).fill(displayName);
    await expect(page.getByRole("option", { name: displayName })).toBeVisible();
    await page.getByRole("option", { name: displayName }).click();

    await page.getByLabel("Commercial period").fill(basis.commercialPeriod);
    await expect(page.getByLabel("Agreement")).toBeEnabled();
    await page.getByLabel("Agreement").selectOption(basis.agreementRef);

    await expect(page.getByText("Deterministic", { exact: true })).toBeVisible();
    await expectNoOverflow(page, "create source stage");

    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Amount breakdown" })).toBeVisible();
    await expect(page.getByTestId("breakdown-line").first()).toContainText("Base fixed amount");
    await expect(page.getByTestId("breakdown-unresolved")).toHaveCount(0);

    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Readiness" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Create Payable" })).toBeEnabled();
    await page.getByRole("button", { name: "Create Payable" }).click();

    await page.waitForURL(/\/finance\/payables\/pay_[0-9a-f]{20}$/);
    vendorPayableRef = new URL(page.url()).pathname.split("/").pop()!;
    await expect(page.getByRole("heading", { level: 1, name: displayName })).toBeVisible();
    await expect(page.getByText("Draft", { exact: true }).first()).toBeVisible();

    expect(errors.errors).toEqual([]);
  });

  test("Source -> Review amount (manual adjustment) -> Confirm -> Create: a FINANCE_REVIEW_REQUIRED Partner Payable", async ({ page }) => {
    const errors = collectBrowserErrors(page);
    const displayName = `${TAG} Review Required Partner`;
    const basis = await fx.seedReviewRequiredPartnerBasis(displayName);

    await signInAs(page, "admin");
    await page.goto("/finance/payables/new");

    await page.getByLabel("Counterparty type").selectOption("PARTNER");
    await page.getByLabel("Counterparty", { exact: true }).fill(displayName);
    await expect(page.getByRole("option", { name: displayName })).toBeVisible();
    await page.getByRole("option", { name: displayName }).click();
    await page.getByLabel("Commercial period").fill(basis.commercialPeriod);

    await expect(page.getByText("Finance review required", { exact: true })).toBeVisible();
    await expect(page.getByText(/Finance review will be needed/)).toBeVisible();

    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Amount breakdown" })).toBeVisible();
    await expect(page.getByTestId("breakdown-unresolved").first()).toBeVisible();

    // Manual adjustment: this lazily creates the DRAFT Payable (the dialog action needs a real payableRef).
    await page.getByRole("button", { name: "Add manual adjustment" }).click();
    const dialog = page.getByRole("dialog", { name: "Add manual adjustment" });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Label").fill("Advance recovery for the period");
    await dialog.getByLabel("Amount").fill("-1500");
    await dialog.getByLabel("Reason").fill("Recovering a prior advance against this period per the finance note.");
    await dialog.getByRole("button", { name: "Add adjustment" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText(/created as Draft/)).toBeVisible();
    await expect(page.getByTestId("breakdown-line").filter({ hasText: "Manual adjustment" })).toBeVisible();

    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Readiness" })).toBeVisible();
    await page.getByRole("button", { name: /Payable$/ }).click();

    await page.waitForURL(/\/finance\/payables\/pay_[0-9a-f]{20}$/);
    partnerPayableRef = new URL(page.url()).pathname.split("/").pop()!;
    await expect(page.getByRole("heading", { level: 1, name: displayName })).toBeVisible();

    expect(errors.errors).toEqual([]);
  });
});

test.describe("Payable detail", () => {
  test("Summary / Amount breakdown / Source evidence / History tabs render, then Ready for invoice", async ({ page }) => {
    const errors = collectBrowserErrors(page);
    await signInAs(page, "admin");
    await page.goto(`/finance/payables/${vendorPayableRef}`);
    await expect(page.getByRole("tab", { name: "Summary" })).toBeVisible();

    await expect(page.getByRole("heading", { level: 2, name: "Payable summary" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Readiness / status" })).toBeVisible();

    await page.getByRole("tab", { name: "Amount breakdown" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Amount breakdown" })).toBeVisible();
    await expect(page.getByTestId("breakdown-line").first()).toBeVisible();

    await page.getByRole("tab", { name: "Source evidence" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Agreement" })).toBeVisible();

    await page.getByRole("tab", { name: "History" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "History" })).toBeVisible();
    await expect(page.getByRole("cell", { name: "Created", exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Ready for invoice" }).click();
    const readyDialog = page.getByRole("dialog", { name: "Mark ready for invoice" });
    await expect(readyDialog).toBeVisible();
    await readyDialog.getByRole("button", { name: "Confirm" }).click();
    await expect(readyDialog).toBeHidden();
    await expect(page.getByText("Ready for invoice", { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Ready for invoice" })).toHaveCount(0);

    expect(errors.errors).toEqual([]);
  });

  // Step 15C.1 section 10: GST applicability is never guessed - a fresh Partner-Review Payable
  // whose fixed amount applies in full (no proration/incentive ambiguity - seedGstOpenPartnerBasis)
  // opens with GST applicability as its ONE open Finance-review item, resolved only through the
  // dedicated "Confirm GST" control on this same Review Amount flow.
  test("Confirm GST: resolves the open GST review item via the dedicated dialog, never a generic manual adjustment", async ({ page }) => {
    const errors = collectBrowserErrors(page);
    const displayName = `${TAG} GST Open Partner`;
    const basis = await fx.seedGstOpenPartnerBasis(displayName);
    const actor = await fx.finance.actorOf("head");
    const created = await createPayable(actor, { counterpartyType: "PARTNER", counterpartyRef: basis.counterpartyRef, commercialPeriod: basis.commercialPeriod }, "req-gst-e2e");
    if (!created.ok) throw new Error(`createPayable failed: ${created.code} ${created.message}`);
    const gstPayableRef = created.data.payable.head.payableRef;
    expect(created.data.payable.selectedVersion?.openReviewCodes).toEqual(["GST_APPLICABILITY_UNCONFIRMED"]);

    await signInAs(page, "admin");
    await page.goto(`/finance/payables/${gstPayableRef}`);
    await page.getByRole("tab", { name: "Amount breakdown" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Amount breakdown" })).toBeVisible();

    await expect(page.getByTestId("breakdown-unresolved").filter({ hasText: "GST" })).toHaveCount(1);

    await page.getByRole("button", { name: "Confirm GST" }).click();
    const gstDialog = page.getByRole("dialog", { name: "Confirm GST" });
    await expect(gstDialog).toBeVisible();
    await gstDialog.getByLabel("Is GST applicable?").selectOption("no");
    await gstDialog.getByRole("button", { name: "Confirm" }).click();
    await expect(gstDialog).toBeHidden();

    await expect(page.getByTestId("breakdown-unresolved").filter({ hasText: "GST" })).toHaveCount(0);
    await expect(page.getByTestId("calculation-summary-row").filter({ hasText: "GST" })).toBeVisible();

    expect(errors.errors).toEqual([]);
  });

  test("Void: terminal, read-only afterward", async ({ page }) => {
    const errors = collectBrowserErrors(page);
    await signInAs(page, "admin");
    await page.goto(`/finance/payables/${partnerPayableRef}`);

    await page.getByTestId("void-action").click();
    const voidDialog = page.getByRole("dialog", { name: "Void this Payable" });
    await expect(voidDialog).toBeVisible();
    await voidDialog.getByLabel("Reason").fill("Voided for the e2e fixture cleanup path.");
    await voidDialog.getByRole("button", { name: "Void Payable" }).click();
    await expect(voidDialog).toBeHidden();

    await expect(page.getByText("Void", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("This Payable is void and read-only.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Ready for invoice" })).toHaveCount(0);
    await expect(page.getByTestId("void-action")).toHaveCount(0);

    expect(errors.errors).toEqual([]);
  });
});

for (const width of VIEWPORTS) {
  test.describe(`at ${width}px`, () => {
    test.use({ viewport: { width, height: width >= 1200 ? 900 : 844 } });

    test(`Workspace + a Payable detail: no document-level horizontal overflow, table on wide / cards on narrow`, async ({ page }) => {
      const errors = collectBrowserErrors(page);
      await signInAs(page, "admin");

      await page.goto("/finance/payables");
      await expect(page.getByRole("heading", { level: 1, name: "Payables" })).toBeVisible();
      await waitForHydration(page, 'select[aria-label="Filter status"]');
      await expect(page.getByTestId("payable-row").or(page.getByTestId("payable-card")).first()).toBeVisible();
      await expectNoOverflow(page, `workspace ${width}`);
      if (width <= 760) await expect(page.getByTestId("payable-card").first()).toBeVisible();
      else await expect(page.getByRole("table")).toBeVisible();

      await page.goto(`/finance/payables/${vendorPayableRef}`);
      await expect(page.getByRole("tab", { name: "Summary" })).toBeVisible();
      await expectNoOverflow(page, `detail ${width}`);

      expect(errors.errors).toEqual([]);
    });
  });
}
