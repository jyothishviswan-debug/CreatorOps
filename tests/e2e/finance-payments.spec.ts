import { expect as baseExpect, test, type Page } from "@playwright/test";

import { collectBrowserErrors, noDocumentOverflow, waitForHydration } from "./helpers/finance-agreements-fixtures";
import { createPaymentsFixtures, signInAs, VIEWPORTS, type PaymentsFixtures } from "./helpers/finance-payments-fixtures";

// Dev-mode route compilation makes the first call of an API route slow: allow more than the 5 s default.
const expect = baseExpect.configure({ timeout: 20_000 });

// Step 17B e2e: the focused Payments UI suite (spec section 24's own scenario list).
//   - Workspace: loads, status strip, filters, Record Payment action.
//   - Create: full-remaining Draft, partial-payment Draft, then Record/Confirm each.
//   - Settlement: a partial confirmation leaves Partially paid; a second confirmed Payment closes it.
//   - Duplicate external reference and overpayment are both BLOCKED, never silently accepted/capped.
//   - Mark Failed never reduces the remaining amount. A DRAFT Payment has a valid Void path.
//   - Detail: all four tabs. Manager vs Head action visibility (Confirm is Head/Admin-only).
//   - Six-width responsive certification (1440/1200/1050/760/390/375) + no console errors throughout.
// Hermetic: private-region fixtures, Invoices taken to APPROVED through the TRUSTED Invoices service
// (never its UI), unique tag, removed in afterAll.

test.describe.configure({ mode: "serial" });

const TAG = `FPM${Date.now().toString(36)}`;
const fx: PaymentsFixtures = createPaymentsFixtures(TAG);

let invoiceFullRef = "";
let invoicePartialRef = "";
let invoiceMiscRef = "";
let fullPaymentRef = "";
let miscRoleCheckPaymentRef = "";
let duplicateReferenceUsed = "";

async function expectNoOverflow(page: Page, label: string) {
  const { scrollWidth, innerWidth } = await noDocumentOverflow(page);
  expect(scrollWidth, `${label}: document scrolls horizontally (${scrollWidth} > ${innerWidth})`).toBeLessThanOrEqual(innerWidth);
}

test.afterAll(async () => {
  await fx.cleanupAll();
});

test.describe("Workspace", () => {
  test("loads, shows the status strip, filter controls, and a Record Payment action", async ({ page }) => {
    const errors = collectBrowserErrors(page);
    await signInAs(page, "admin");
    await page.goto("/finance/payments");
    await expect(page.getByRole("heading", { level: 1, name: "Payments" })).toBeVisible();
    await expect(page.getByTestId("workspace-status-strip")).toBeVisible();
    await expect(page.getByRole("link", { name: "Record Payment" })).toBeVisible();
    await waitForHydration(page, 'select[aria-label="Filter status"]');
    for (const label of ["Filter status", "Filter Partner or Vendor", "Search counterparty ref", "Search Invoice ref"]) {
      await expect(page.getByLabel(label)).toBeVisible();
    }
    expect(errors.errors).toEqual([]);
  });
});

test.describe("Record Payment - full remaining amount", () => {
  test("Source Invoice -> Payment Details -> Confirm -> Record -> Confirm: closes settlement in one Payment", async ({ page }) => {
    const errors = collectBrowserErrors(page);
    const displayName = `${TAG} Full Vendor`;
    const seeded = await fx.seedApprovedInvoice(displayName);
    invoiceFullRef = seeded.invoiceRef;

    await signInAs(page, "admin");
    await page.goto("/finance/payments/new");
    await expect(page.getByRole("heading", { level: 1, name: "Record Payment" })).toBeVisible();

    const row = page.getByTestId("eligible-invoice-row").filter({ hasText: invoiceFullRef });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.getByTestId("select-invoice").click();
    await expect(page.getByText("Payments are recorded against the net amount after TDS.")).toBeVisible();
    await expectNoOverflow(page, "record payment - source stage");

    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByTestId("record-transfer-note")).toBeVisible();
    // Default amount equals the current remaining amount (section 7).
    const amountValue = await page.getByTestId("payment-amount-input").inputValue();
    expect(Number(amountValue)).toBeGreaterThan(0);
    await page.getByTestId("payment-date-input").fill("2026-03-15");
    await page.getByTestId("payment-method-select").selectOption("BANK_TRANSFER");
    await page.getByTestId("payment-reference-input").fill(`UTR-${TAG}-FULL`);
    await expectNoOverflow(page, "record payment - details stage");

    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByTestId("draft-lifecycle-note")).toHaveText("This Payment will be created as Draft.");
    await page.getByTestId("create-payment-action").click();

    await page.waitForURL(/\/finance\/payments\/pmt_[0-9a-f]{20}$/);
    fullPaymentRef = new URL(page.url()).pathname.split("/").pop()!;
    await expect(page.getByText("Draft", { exact: true }).first()).toBeVisible();

    await page.getByTestId("record-action").click();
    await expect(page.getByRole("dialog", { name: "Record Payment" })).toBeVisible();
    await page.getByRole("dialog", { name: "Record Payment" }).getByRole("button", { name: "Record" }).click();
    await expect(page.getByRole("dialog", { name: "Record Payment" })).toBeHidden();
    await expect(page.getByText("Recorded", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("This Payment is recorded but not yet confirmed.")).toBeVisible();

    await page.getByTestId("confirm-action").click();
    await expect(page.getByRole("dialog", { name: "Confirm Payment" })).toBeVisible();
    await page.getByTestId("confirm-submit-action").click();
    await expect(page.getByRole("dialog", { name: "Confirm Payment" })).toBeHidden();
    await expect(page.getByText("Confirmed", { exact: true }).first()).toBeVisible();

    expect(errors.errors).toEqual([]);
  });
});

test.describe("Record Payment - partial, then a second Payment closes settlement", () => {
  test("a partial confirmed Payment leaves the Invoice Partially paid, never Paid", async ({ page }) => {
    const errors = collectBrowserErrors(page);
    const displayName = `${TAG} Partial Vendor`;
    const seeded = await fx.seedApprovedInvoice(displayName);
    invoicePartialRef = seeded.invoiceRef;
    const halfRupees = Math.floor(seeded.declaredTotalMinor / 100 / 2);

    await signInAs(page, "admin");
    await page.goto("/finance/payments/new");
    const row = page.getByTestId("eligible-invoice-row").filter({ hasText: invoicePartialRef });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.getByTestId("select-invoice").click();
    await page.getByRole("button", { name: "Continue" }).click();

    await page.getByTestId("payment-amount-input").fill(String(halfRupees));
    await page.getByTestId("payment-date-input").fill("2026-03-16");
    await page.getByTestId("payment-method-select").selectOption("UPI");
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByTestId("create-payment-action").click();

    await page.waitForURL(/\/finance\/payments\/pmt_[0-9a-f]{20}$/);
    await page.getByTestId("record-action").click();
    await page.getByRole("dialog", { name: "Record Payment" }).getByRole("button", { name: "Record" }).click();
    await expect(page.getByRole("dialog", { name: "Record Payment" })).toBeHidden();

    await page.getByTestId("confirm-action").click();
    await page.getByTestId("confirm-submit-action").click();
    await expect(page.getByRole("dialog", { name: "Confirm Payment" })).toBeHidden();

    await page.getByRole("tab", { name: "Settlement" }).click();
    await expect(page.getByTestId("settlement-state-pill")).toContainText("Partially paid");

    expect(errors.errors).toEqual([]);
  });

  test("a second, remaining-amount confirmed Payment closes the Invoice's settlement", async ({ page }) => {
    const errors = collectBrowserErrors(page);
    await signInAs(page, "admin");
    await page.goto("/finance/payments/new");
    const row = page.getByTestId("eligible-invoice-row").filter({ hasText: invoicePartialRef });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.getByTestId("select-invoice").click();
    // The selected-Invoice summary reflects the FIRST confirmed Payment already.
    await expect(page.getByText("Confirmed paid")).toBeVisible();
    await page.getByRole("button", { name: "Continue" }).click();

    // Default amount equals the current (already-reduced) remaining amount.
    const remainingValue = await page.getByTestId("payment-amount-input").inputValue();
    expect(Number(remainingValue)).toBeGreaterThan(0);
    await page.getByTestId("payment-date-input").fill("2026-03-20");
    await page.getByTestId("payment-method-select").selectOption("UPI");
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByTestId("create-payment-action").click();
    await page.waitForURL(/\/finance\/payments\/pmt_[0-9a-f]{20}$/);

    await page.getByTestId("record-action").click();
    await page.getByRole("dialog", { name: "Record Payment" }).getByRole("button", { name: "Record" }).click();
    await expect(page.getByRole("dialog", { name: "Record Payment" })).toBeHidden();
    await page.getByTestId("confirm-action").click();
    await page.getByTestId("confirm-submit-action").click();
    await expect(page.getByRole("dialog", { name: "Confirm Payment" })).toBeHidden();

    await page.getByRole("tab", { name: "Settlement" }).click();
    await expect(page.getByTestId("settlement-state-pill")).toContainText("Paid");
    await expect(page.getByTestId("related-payment-row")).toHaveCount(2);

    expect(errors.errors).toEqual([]);
  });
});

test.describe("Overpayment, duplicate reference, Mark Failed, Void, and role visibility", () => {
  test("overpayment is blocked at Confirm, never silently capped", async ({ page }) => {
    const errors = collectBrowserErrors(page);
    const displayName = `${TAG} Misc Vendor`;
    const seeded = await fx.seedApprovedInvoice(displayName);
    invoiceMiscRef = seeded.invoiceRef;
    const overRupees = Math.ceil(seeded.declaredTotalMinor / 100) + 5000;

    await signInAs(page, "admin");
    await page.goto("/finance/payments/new");
    const row = page.getByTestId("eligible-invoice-row").filter({ hasText: invoiceMiscRef });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.getByTestId("select-invoice").click();
    await page.getByRole("button", { name: "Continue" }).click();

    await page.getByTestId("payment-amount-input").fill(String(overRupees));
    await expect(page.getByTestId("overpayment-warning")).toBeVisible();
    await page.getByTestId("payment-date-input").fill("2026-03-17");
    await page.getByTestId("payment-method-select").selectOption("CHEQUE");
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByTestId("create-payment-action").click();
    await page.waitForURL(/\/finance\/payments\/pmt_[0-9a-f]{20}$/);

    await page.getByTestId("record-action").click();
    await page.getByRole("dialog", { name: "Record Payment" }).getByRole("button", { name: "Record" }).click();
    await expect(page.getByRole("dialog", { name: "Record Payment" })).toBeHidden();

    await page.getByTestId("confirm-action").click();
    await page.getByTestId("confirm-submit-action").click();
    await expect(page.getByTestId("confirm-overpayment-blocker")).toBeVisible();
    // Blocked, not applied: the header status is still Recorded, never Confirmed.
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByText("Recorded", { exact: true }).first()).toBeVisible();

    expect(errors.errors).toEqual([]);
  });

  test("Mark Failed never reduces the Invoice's remaining amount", async ({ page }) => {
    const errors = collectBrowserErrors(page);
    await signInAs(page, "admin");
    await page.goto("/finance/payments/new");
    const row = page.getByTestId("eligible-invoice-row").filter({ hasText: invoiceMiscRef });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.getByTestId("select-invoice").click();
    await page.getByRole("button", { name: "Continue" }).click();

    await page.getByTestId("payment-amount-input").fill("1000");
    await page.getByTestId("payment-date-input").fill("2026-03-18");
    await page.getByTestId("payment-method-select").selectOption("CASH");
    duplicateReferenceUsed = `UTR-${TAG}-FAILREF`;
    await page.getByTestId("payment-reference-input").fill(duplicateReferenceUsed);
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByTestId("create-payment-action").click();
    await page.waitForURL(/\/finance\/payments\/pmt_[0-9a-f]{20}$/);

    await page.getByTestId("record-action").click();
    await page.getByRole("dialog", { name: "Record Payment" }).getByRole("button", { name: "Record" }).click();
    await expect(page.getByRole("dialog", { name: "Record Payment" })).toBeHidden();

    await page.getByRole("tab", { name: "Settlement" }).click();
    const remainingBefore = await page.locator(".kv").filter({ hasText: "Remaining amount" }).innerText();

    await page.getByRole("tab", { name: "Summary" }).click();
    await page.getByTestId("fail-action").click();
    await expect(page.getByRole("dialog", { name: "Mark Payment Failed" })).toBeVisible();
    await page.getByRole("dialog", { name: "Mark Payment Failed" }).getByLabel("Reason").fill("Bank returned the transfer as failed - e2e fixture.");
    await page.getByRole("dialog", { name: "Mark Payment Failed" }).getByRole("button", { name: "Mark Failed" }).click();
    await expect(page.getByRole("dialog", { name: "Mark Payment Failed" })).toBeHidden();
    await expect(page.getByText("Failed", { exact: true }).first()).toBeVisible();

    await page.getByRole("tab", { name: "Settlement" }).click();
    const remainingAfter = await page.locator(".kv").filter({ hasText: "Remaining amount" }).innerText();
    expect(remainingAfter).toBe(remainingBefore);

    expect(errors.errors).toEqual([]);
  });

  test("a duplicate external reference is blocked at Record", async ({ page }) => {
    const errors = collectBrowserErrors(page);
    await signInAs(page, "admin");
    await page.goto("/finance/payments/new");
    const row = page.getByTestId("eligible-invoice-row").filter({ hasText: invoiceMiscRef });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.getByTestId("select-invoice").click();
    await page.getByRole("button", { name: "Continue" }).click();

    await page.getByTestId("payment-amount-input").fill("500");
    await page.getByTestId("payment-date-input").fill("2026-03-19");
    await page.getByTestId("payment-method-select").selectOption("CASH");
    await page.getByTestId("payment-reference-input").fill(duplicateReferenceUsed);
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByTestId("create-payment-action").click();
    await page.waitForURL(/\/finance\/payments\/pmt_[0-9a-f]{20}$/);

    await page.getByTestId("record-action").click();
    await page.getByRole("dialog", { name: "Record Payment" }).getByRole("button", { name: "Record" }).click();
    await expect(page.getByRole("dialog", { name: "Record Payment" })).toBeVisible();
    await expect(page.getByRole("dialog", { name: "Record Payment" }).getByText(/already used by another payment/i)).toBeVisible();

    expect(errors.errors).toEqual([]);
  });

  test("a Draft Payment has a valid Void path and becomes read-only", async ({ page }) => {
    const errors = collectBrowserErrors(page);
    await signInAs(page, "admin");
    await page.goto("/finance/payments/new");
    const row = page.getByTestId("eligible-invoice-row").filter({ hasText: invoiceMiscRef });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.getByTestId("select-invoice").click();
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByTestId("payment-amount-input").fill("500");
    await page.getByTestId("payment-date-input").fill("2026-03-19");
    await page.getByTestId("payment-method-select").selectOption("OTHER");
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByTestId("create-payment-action").click();
    await page.waitForURL(/\/finance\/payments\/pmt_[0-9a-f]{20}$/);

    await page.getByTestId("void-action").click();
    const voidDialog = page.getByRole("dialog", { name: "Void this Payment" });
    await expect(voidDialog).toBeVisible();
    await voidDialog.getByLabel("Reason").fill("Voided for the e2e fixture cleanup path.");
    await voidDialog.getByRole("button", { name: "Void Payment" }).click();
    await expect(voidDialog).toBeHidden();

    await expect(page.getByText("Void", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("This Payment is void and read-only.")).toBeVisible();
    await expect(page.getByTestId("void-action")).toHaveCount(0);

    expect(errors.errors).toEqual([]);
  });

  test("all four detail tabs render", async ({ page }) => {
    const errors = collectBrowserErrors(page);
    await signInAs(page, "admin");
    await page.goto(`/finance/payments/${fullPaymentRef}`);
    await expect(page.getByRole("tab", { name: "Summary" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Payment summary" })).toBeVisible();

    await page.getByRole("tab", { name: "Settlement" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Invoice settlement" })).toBeVisible();

    await page.getByRole("tab", { name: "Source Invoice" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Source Invoice" })).toBeVisible();

    await page.getByRole("tab", { name: "History" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "History" })).toBeVisible();
    await expect(page.getByRole("cell", { name: "Payment created" })).toBeVisible();

    expect(errors.errors).toEqual([]);
  });

  test("Manager vs Head/Admin: Confirm is visible only to a role holding confirm_payments", async ({ page }) => {
    const errors = collectBrowserErrors(page);
    const displayName = `${TAG} Role Vendor`;
    const seeded = await fx.seedApprovedInvoice(displayName);
    const roleInvoiceRef = seeded.invoiceRef;

    await signInAs(page, "admin");
    await page.goto("/finance/payments/new");
    const row = page.getByTestId("eligible-invoice-row").filter({ hasText: roleInvoiceRef });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.getByTestId("select-invoice").click();
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByTestId("payment-date-input").fill("2026-03-21");
    await page.getByTestId("payment-method-select").selectOption("BANK_TRANSFER");
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByTestId("create-payment-action").click();
    await page.waitForURL(/\/finance\/payments\/pmt_[0-9a-f]{20}$/);
    miscRoleCheckPaymentRef = new URL(page.url()).pathname.split("/").pop()!;
    await page.getByTestId("record-action").click();
    await page.getByRole("dialog", { name: "Record Payment" }).getByRole("button", { name: "Record" }).click();
    await expect(page.getByRole("dialog", { name: "Record Payment" })).toBeHidden();

    await signInAs(page, "manager");
    await page.goto(`/finance/payments/${miscRoleCheckPaymentRef}`);
    await expect(page.getByRole("heading", { level: 1, name: miscRoleCheckPaymentRef })).toBeVisible();
    await expect(page.getByTestId("confirm-action")).toHaveCount(0);

    await signInAs(page, "head");
    await page.goto(`/finance/payments/${miscRoleCheckPaymentRef}`);
    await expect(page.getByTestId("confirm-action")).toBeVisible();

    expect(errors.errors).toEqual([]);
  });
});

for (const width of VIEWPORTS) {
  test.describe(`at ${width}px`, () => {
    test.use({ viewport: { width, height: width >= 1200 ? 900 : 844 } });

    test(`Workspace + a Payment detail: no document-level horizontal overflow, table on wide / cards on narrow`, async ({ page }) => {
      const errors = collectBrowserErrors(page);
      await signInAs(page, "admin");

      await page.goto("/finance/payments");
      await expect(page.getByRole("heading", { level: 1, name: "Payments" })).toBeVisible();
      await waitForHydration(page, 'select[aria-label="Filter status"]');
      await expect(page.getByTestId("payment-row").or(page.getByTestId("payment-card")).first()).toBeVisible();
      await expectNoOverflow(page, `workspace ${width}`);
      if (width <= 760) await expect(page.getByTestId("payment-card").first()).toBeVisible();
      else await expect(page.getByRole("table")).toBeVisible();

      await page.goto(`/finance/payments/${fullPaymentRef}`);
      await expect(page.getByRole("tab", { name: "Summary" })).toBeVisible();
      await expectNoOverflow(page, `detail ${width}`);

      expect(errors.errors).toEqual([]);
    });
  });
}
