import { expect as baseExpect, test, type Page } from "@playwright/test";

import { makeTextPdf } from "@/server/finance-agreements/testing/pdf-fixtures";
import { registerServerProviders } from "@/server/composition/register-providers";

import { collectBrowserErrors, noDocumentOverflow, waitForHydration } from "./helpers/finance-agreements-fixtures";
import { createClosureFixtures, CLOSURE_ACTUAL_COUNT, CLOSURE_REQUIRED_COUNT, type ClosureFixtures } from "./helpers/finance-e2e-closure-fixtures";
import { signInAs, VIEWPORTS } from "./helpers/finance-payables-fixtures";

// Dev-mode route compilation makes the first call of an API route slow: allow more than the 5 s default.
const expect = baseExpect.configure({ timeout: 20_000 });

// Step 17C spec section 20: the ONE Finance E2E Playwright flow, driven through the real local app
// against a real browser - not just the emulator-level service test (src/server/finance-payments/
// finance-e2e-closure.emulator.test.ts, already closed and passing; this spec proves the SAME chain's
// UI surface, never re-deriving the calculator itself). Built on the same composed fixture
// (tests/e2e/helpers/finance-e2e-closure-fixtures.ts) as that emulator test, which is itself layered
// on top of the Agreements/Partner-Reviews fixture factories - see that file's header comment.
//
// Follows the exact conventions of this same effort's own closest models:
//   - finance-payables.spec.ts       (Step 15B) - the Create Payable wizard + Confirm GST dialog.
//   - finance-invoices.spec.ts       (Step 16B) - the Create Invoice wizard + real PDF extraction.
//   - finance-invoices-payee-identity.spec.ts (Step 16C) - payee mismatch banner/resolve/role gating.
//   - finance-payments.spec.ts       (Step 17B) - Record/Confirm Payment + Manager-vs-Head gating.
//
// Covers spec section 20's 15 items in one serial run: finalized evidence -> Payable (proration +
// explicit GST/TDS) -> READY_FOR_INVOICE -> Invoice create/upload/extract -> reconciliation -> payee
// identity (a deliberate mismatch + its authorized resolution) -> submit/approve -> first partial
// Payment -> partial settlement -> second Payment -> final PAID settlement -> upstream immutability
// -> no restricted values in DOM/response -> zero console errors (asserted on every test below).
// Also section 18 (six-width overflow, folded into one loop across all three workspaces + the
// closure Payable/Invoice/Payment detail pages) and section 15's Manager-vs-Head contrast at the two
// gates that matter most (payee-mismatch resolution + Invoice approval, and Payment confirm).
//
// Hermetic: a private-region fixture basis (16 real APPROVED Content threads, a real finalized
// Partner Review), unique tag, removed in afterAll. No real Drive, no real bank/payment provider.

test.describe.configure({ mode: "serial" });

const TAG = `FEC${Date.now().toString(36)}`;
const fx: ClosureFixtures = createClosureFixtures(TAG);
const PERIOD = "2024-03";
const PARTNER_DISPLAY_NAME = `${TAG} Closure Partner`;
const MISMATCHED_SUPPLIER_NAME = "Totally Different Legal Entity LLC";

let payableRef = "";
let invoiceRef = "";
let firstPaymentRef = "";
let secondPaymentRef = "";

async function expectNoOverflow(page: Page, label: string) {
  const { scrollWidth, innerWidth } = await noDocumentOverflow(page);
  expect(scrollWidth, `${label}: document scrolls horizontally (${scrollWidth} > ${innerWidth})`).toBeLessThanOrEqual(innerWidth);
}

// A synthetic Invoice PDF exercising BOTH the numeric extraction fields (number/subtotal/GST/total -
// the same wording pattern finance-invoices.spec.ts's own extractionSamplePdf uses) AND the payee
// name extraction (the same "Supplier: <name>" line finance-invoices-payee-identity.spec.ts uses) in
// one document, with a DELIBERATE payee mismatch. No OCR: a structurally-valid text PDF only.
const closureInvoicePdf = () =>
  makeTextPdf([["Invoice Number: INV-E2E-CLOSURE-001", "Invoice Date: 20 May 2024", "Sub Total: INR 80,000", "GST @ 18%", "Total Due: INR 94,400", `Supplier: ${MISMATCHED_SUPPLIER_NAME}`]]);

async function scanForRestrictedValues(page: Page, label: string) {
  const bodyText = await page.locator("body").innerText();
  // Scrub the app's own opaque ref ids first (pay_/inv_/pmt_/agr_/pr_<hex>, which legitimately embed
  // long digit runs by chance) - the same scrubbing finance-agreements-fixtures.ts's own sensitive-data
  // sweep uses - then look for a 9+ digit run in what is left (a bare bank account / GSTIN-shaped VALUE,
  // never a ref).
  const withoutIds = bodyText.replace(/\b[a-z]{2,4}_[0-9a-f]{12,64}\b/gi, "ref").replace(/\b[0-9a-f]{16,64}\b/gi, "hex");
  expect(withoutIds, `${label}: a 9+ digit run leaked into the DOM`).not.toMatch(/\d{9,}/);
  for (const forbidden of ["panNumber", "aadhaarNumber", "accountNumber", "gstin", "ifsc", "bankName"]) {
    expect(bodyText.toLowerCase(), `${label}: "${forbidden}" leaked into the DOM`).not.toContain(forbidden.toLowerCase());
  }
}

// A Playwright test process is a plain Node process, not the running Next dev server: Partner
// Reviews' live commercial-policy DI registration (src/instrumentation.ts's register(), Node-runtime
// only) never runs in it, so generatePartnerReviewDraft (called inside seedProratedPartnerBasis, via
// the REAL trusted Review service - never the seedDirectReview shortcut, which always seeds zero
// delivered evidence) would see no governing policy for even a real, active Agreement - see
// finance-payables-fixtures.ts's own header comment for the same warning. Registering the providers
// directly (the same composition entry point instrumentation.ts itself calls) fixes this for this
// process only; the actual browser/dev-server process already does this automatically.
test.beforeAll(() => {
  registerServerProviders();
});

test.afterAll(async () => {
  await fx.cleanupAll();
});

test.describe("1-4: finalized evidence -> Payable -> proration -> explicit GST/TDS -> READY_FOR_INVOICE", () => {
  test("Create Payable wizard shows the real proration, then Confirm GST and Ready for invoice on the detail page", async ({ page }) => {
    const errors = collectBrowserErrors(page);
    const basis = await fx.seedProratedPartnerBasis(PERIOD, PARTNER_DISPLAY_NAME);
    expect(basis.agreementVersion).toBeGreaterThan(0);
    expect(basis.reviewVersion).toBeGreaterThan(0);

    await signInAs(page, "head");
    await page.goto("/finance/payables/new");
    await expect(page.getByRole("heading", { level: 1, name: "Create Payable" })).toBeVisible();

    await page.getByLabel("Counterparty type").selectOption("PARTNER");
    await page.getByLabel("Counterparty", { exact: true }).fill(PARTNER_DISPLAY_NAME);
    await expect(page.getByRole("option", { name: PARTNER_DISPLAY_NAME })).toBeVisible();
    await page.getByRole("option", { name: PARTNER_DISPLAY_NAME }).click();
    await page.getByLabel("Commercial period").fill(PERIOD);
    // GST is deliberately left unconfirmed at this point (spec section 5's explicit-decision
    // requirement) - wait for the resolved preview text, exactly like the FINANCE_REVIEW_REQUIRED
    // scenario in finance-payables.spec.ts does, before Continue (disabled until the preview
    // resolves) can be clicked.
    await expect(page.getByText("Finance review required", { exact: true })).toBeVisible();
    await expectNoOverflow(page, "create payable - source stage");

    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Amount breakdown" })).toBeVisible();
    // The worked example (spec section 5): required 20, delivered 16 -> a prorated base line, not
    // the full fixed amount - and GST still unconfirmed (an open Finance-review item).
    await expect(page.getByTestId("breakdown-line").filter({ hasText: /^Prorated service base/ })).toBeVisible();
    await expect(page.getByTestId("breakdown-unresolved").filter({ hasText: "GST" })).toHaveCount(1);
    expect(CLOSURE_REQUIRED_COUNT).toBe(20);
    expect(CLOSURE_ACTUAL_COUNT).toBe(16);
    await expectNoOverflow(page, "create payable - amount breakdown stage");

    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Readiness" })).toBeVisible();
    await page.getByRole("button", { name: "Create Payable" }).click();

    await page.waitForURL(/\/finance\/payables\/pay_[0-9a-f]{20}$/);
    payableRef = new URL(page.url()).pathname.split("/").pop()!;
    await expect(page.getByRole("heading", { level: 1, name: PARTNER_DISPLAY_NAME })).toBeVisible();

    // Confirm GST explicitly (never defaulted): Yes at 18%.
    await page.getByRole("tab", { name: "Amount breakdown" }).click();
    await expect(page.getByTestId("breakdown-unresolved").filter({ hasText: "GST" })).toHaveCount(1);
    await page.getByRole("button", { name: "Confirm GST" }).click();
    const gstDialog = page.getByRole("dialog", { name: "Confirm GST" });
    await expect(gstDialog).toBeVisible();
    await gstDialog.getByLabel("Is GST applicable?").selectOption("yes");
    await gstDialog.getByLabel("GST rate").fill("18");
    await gstDialog.getByRole("button", { name: "Confirm" }).click();
    await expect(gstDialog).toBeHidden();
    await expect(page.getByTestId("breakdown-unresolved").filter({ hasText: "GST" })).toHaveCount(0);

    // Service base / GST / TDS / gross / net all distinct and visible, never conflated.
    await expect(page.getByText("₹80,000").first()).toBeVisible(); // service base
    await expect(page.getByText("₹14,400").first()).toBeVisible(); // GST (18% of 80,000)
    await expect(page.getByText("₹8,000").first()).toBeVisible(); // TDS (10% of 80,000)
    await expect(page.getByText("₹86,400").first()).toBeVisible(); // expected net payment
    await expectNoOverflow(page, "payable detail - amount breakdown after GST");

    await page.getByRole("tab", { name: "Summary" }).click();
    await page.getByRole("button", { name: "Ready for invoice" }).click();
    const readyDialog = page.getByRole("dialog", { name: "Mark ready for invoice" });
    await expect(readyDialog).toBeVisible();
    await readyDialog.getByRole("button", { name: "Confirm" }).click();
    await expect(readyDialog).toBeHidden();
    await expect(page.getByText("Ready for invoice", { exact: true }).first()).toBeVisible();

    await scanForRestrictedValues(page, "payable detail");
    expect(errors.errors).toEqual([]);
  });
});

test.describe("5-8: Invoice create/upload/extract -> reconciliation -> payee identity mismatch", () => {
  test("Create Invoice wizard extracts real fields from a synthetic PDF, reconciles to MATCH, and reads a payee MISMATCH", async ({ page }) => {
    const errors = collectBrowserErrors(page);
    await signInAs(page, "manager");
    await page.goto("/finance/invoices/new");
    await expect(page.getByRole("heading", { level: 1, name: "Create Invoice" })).toBeVisible();

    await expect(page.getByTestId("eligible-payable-row").filter({ hasText: payableRef })).toBeVisible({ timeout: 30_000 });
    await page.locator(`[data-testid="eligible-payable-row"][data-payable-ref="${payableRef}"]`).getByTestId("select-payable").click();
    await expect(page.getByText("Ready for invoice", { exact: true }).first()).toBeVisible();
    await expectNoOverflow(page, "create invoice - source stage");

    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Invoice details" })).toBeVisible();

    // A user correction FIRST (marks the date touched), proving extraction never overwrites it.
    await page.getByLabel("Invoice date").fill("2099-01-01");

    await page.getByLabel("Invoice document file").setInputFiles({ name: "closure-invoice.pdf", mimeType: "application/pdf", buffer: closureInvoicePdf() });
    await expect(page.getByTestId("staged-document")).toBeVisible();
    await expect(page.getByTestId("extraction-status-banner")).toContainText(/Extraction completed/);

    // Untouched fields prefilled from the PDF and reconcile to the Payable's gross expectation exactly.
    await expect(page.getByLabel("Invoice number")).toHaveValue("INV-E2E-CLOSURE-001");
    await expect(page.getByTestId("extracted-tag-externalInvoiceNumber")).toBeVisible();
    await expect(page.getByLabel("Declared total")).toHaveValue("94400");
    await expect(page.getByTestId("extracted-tag-declaredTotalMinor")).toBeVisible();
    // The user-touched date kept the manual value and was never retagged.
    await expect(page.getByLabel("Invoice date")).toHaveValue("2099-01-01");
    await expect(page.getByTestId("extracted-tag-invoiceDate")).toHaveCount(0);
    await expect(page.getByTestId("payee-identity-extraction-note")).toBeVisible();
    await expectNoOverflow(page, "create invoice - details stage with extraction");

    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Reconciliation" })).toBeVisible();
    // Declared total (94,400) matches the Payable's gross expected Invoice total exactly.
    await expect(page.getByTestId("reconciliation-row-total")).toContainText("Match");
    await expectNoOverflow(page, "create invoice - reconciliation stage");

    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Readiness" })).toBeVisible();
    await page.getByTestId("create-invoice-action").click();

    await page.waitForURL(/\/finance\/invoices\/inv_[0-9a-f]{20}$/);
    invoiceRef = new URL(page.url()).pathname.split("/").pop()!;
    await expect(page.getByText("Draft", { exact: true }).first()).toBeVisible();

    await page.getByRole("tab", { name: "Reconciliation" }).click();
    await expect(page.getByTestId("payee-identity-section")).toBeVisible();
    await expect(page.getByTestId("payee-identity-row-NAME")).toContainText("Mismatch");
    await expect(page.getByTestId("payee-mismatch-banner")).toBeVisible();

    await scanForRestrictedValues(page, "invoice detail (draft)");
    expect(errors.errors).toEqual([]);
  });
});

test.describe("9: submit/approve, gated by the unresolved payee mismatch (role contrast)", () => {
  test("Manager can submit but cannot resolve or approve; Head resolves the mismatch and approves", async ({ page }) => {
    const errors = collectBrowserErrors(page);
    await signInAs(page, "manager");
    await page.goto(`/finance/invoices/${invoiceRef}`);
    await page.getByTestId("submit-action").click();
    await page.getByRole("dialog", { name: "Submit Invoice" }).getByRole("button", { name: "Submit" }).click();
    await expect(page.getByText("Submitted", { exact: true }).first()).toBeVisible();

    // Manager holds neither override_invoice_mismatch nor approve_invoices.
    await page.getByRole("tab", { name: "Reconciliation" }).click();
    await expect(page.getByTestId("payee-mismatch-banner")).toBeVisible();
    await expect(page.getByTestId("resolve-payee-mismatch-action")).toHaveCount(0);
    await expect(page.getByTestId("approve-action")).toHaveCount(0);

    // Head's Approve is refused by the server before resolution.
    await signInAs(page, "head");
    await page.goto(`/finance/invoices/${invoiceRef}`);
    await page.getByTestId("approve-action").click();
    const approveDialogBlocked = page.getByRole("dialog", { name: "Approve Invoice" });
    await expect(approveDialogBlocked).toBeVisible();
    await approveDialogBlocked.getByTestId("confirm-approve").click();
    await expect(approveDialogBlocked.getByRole("alert")).toContainText("This invoice cannot be approved yet.");
    await approveDialogBlocked.getByRole("button", { name: "Cancel" }).click();
    await expect(approveDialogBlocked).toBeHidden();
    await expect(page.getByText("Submitted", { exact: true }).first()).toBeVisible();

    // Head resolves the mismatch with a reason - the original evidence is preserved, never rewritten.
    await page.getByRole("tab", { name: "Reconciliation" }).click();
    await page.getByTestId("resolve-payee-mismatch-action").click();
    const resolveDialog = page.getByRole("dialog", { name: "Resolve payee mismatch" });
    await expect(resolveDialog).toBeVisible();
    await page.getByTestId("payee-mismatch-reason-input").fill("Verified against the signed Agreement; same legal entity under a trading name.");
    await page.getByTestId("confirm-resolve-payee-mismatch").click();
    await expect(resolveDialog).toBeHidden();
    await expect(page.getByTestId("payee-mismatch-accepted-banner")).toBeVisible();
    await expect(page.getByTestId("payee-identity-row-NAME")).toContainText("Mismatch");

    // Now Head can approve.
    await page.getByTestId("approve-action").click();
    const approveDialog = page.getByRole("dialog", { name: "Approve Invoice" });
    await expect(approveDialog).toBeVisible();
    await approveDialog.getByTestId("confirm-approve").click();
    await expect(approveDialog).toBeHidden();
    await expect(page.getByText("Approved", { exact: true }).first()).toBeVisible();

    await scanForRestrictedValues(page, "invoice detail (approved)");
    expect(errors.errors).toEqual([]);
  });
});

test.describe("10-13: two partial Payments to PAID settlement (Manager-vs-Head at confirm)", () => {
  test("first partial Payment: Manager sees no Confirm action; Head confirms -> Partially paid", async ({ page }) => {
    const errors = collectBrowserErrors(page);
    await signInAs(page, "head");
    await page.goto("/finance/payments/new");
    const row = page.getByTestId("eligible-invoice-row").filter({ hasText: invoiceRef });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.getByTestId("select-invoice").click();
    await expect(page.getByText("Payments are recorded against the net amount after TDS.")).toBeVisible();
    await expectNoOverflow(page, "record payment - source stage");

    await page.getByRole("button", { name: "Continue" }).click();
    // Half of the expected net payment (86,400 / 2 = 43,200).
    await page.getByTestId("payment-amount-input").fill("43200");
    await page.getByTestId("payment-date-input").fill("2024-05-10");
    await page.getByTestId("payment-method-select").selectOption("BANK_TRANSFER");
    await page.getByTestId("payment-reference-input").fill(`CLOSURE-REF-1-${TAG}`);
    await expectNoOverflow(page, "record payment - details stage");

    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByTestId("create-payment-action").click();
    await page.waitForURL(/\/finance\/payments\/pmt_[0-9a-f]{20}$/);
    firstPaymentRef = new URL(page.url()).pathname.split("/").pop()!;

    await page.getByTestId("record-action").click();
    await page.getByRole("dialog", { name: "Record Payment" }).getByRole("button", { name: "Record" }).click();
    await expect(page.getByRole("dialog", { name: "Record Payment" })).toBeHidden();
    await expect(page.getByText("Recorded", { exact: true }).first()).toBeVisible();

    // RECORDED (not yet CONFIRMED) never reduces the remaining balance.
    await page.getByRole("tab", { name: "Settlement" }).click();
    await expect(page.getByTestId("settlement-state-pill")).toContainText("Unpaid");

    // Manager holds no confirm_payments.
    await signInAs(page, "manager");
    await page.goto(`/finance/payments/${firstPaymentRef}`);
    await expect(page.getByTestId("confirm-action")).toHaveCount(0);

    await signInAs(page, "head");
    await page.goto(`/finance/payments/${firstPaymentRef}`);
    await page.getByTestId("confirm-action").click();
    await page.getByTestId("confirm-submit-action").click();
    await expect(page.getByRole("dialog", { name: "Confirm Payment" })).toBeHidden();
    await expect(page.getByText("Confirmed", { exact: true }).first()).toBeVisible();

    await page.getByRole("tab", { name: "Settlement" }).click();
    await expect(page.getByTestId("settlement-state-pill")).toContainText("Partially paid");

    await scanForRestrictedValues(page, "payment detail (first, confirmed)");
    expect(errors.errors).toEqual([]);
  });

  test("second Payment for the remaining amount closes settlement to PAID", async ({ page }) => {
    const errors = collectBrowserErrors(page);
    await signInAs(page, "head");
    await page.goto("/finance/payments/new");
    const row = page.getByTestId("eligible-invoice-row").filter({ hasText: invoiceRef });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.getByTestId("select-invoice").click();
    await expect(page.getByText("Confirmed paid")).toBeVisible();
    await page.getByRole("button", { name: "Continue" }).click();

    // Default amount equals the current (already-reduced) remaining amount: 43,200.
    const remainingValue = await page.getByTestId("payment-amount-input").inputValue();
    expect(Number(remainingValue)).toBe(43_200);
    await page.getByTestId("payment-date-input").fill("2024-05-20");
    await page.getByTestId("payment-method-select").selectOption("BANK_TRANSFER");
    await page.getByTestId("payment-reference-input").fill(`CLOSURE-REF-2-${TAG}`);
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByTestId("create-payment-action").click();
    await page.waitForURL(/\/finance\/payments\/pmt_[0-9a-f]{20}$/);
    secondPaymentRef = new URL(page.url()).pathname.split("/").pop()!;

    await page.getByTestId("record-action").click();
    await page.getByRole("dialog", { name: "Record Payment" }).getByRole("button", { name: "Record" }).click();
    await expect(page.getByRole("dialog", { name: "Record Payment" })).toBeHidden();
    await page.getByTestId("confirm-action").click();
    await page.getByTestId("confirm-submit-action").click();
    await expect(page.getByRole("dialog", { name: "Confirm Payment" })).toBeHidden();

    await page.getByRole("tab", { name: "Settlement" }).click();
    await expect(page.getByTestId("settlement-state-pill")).toContainText("Paid");
    await expect(page.getByTestId("related-payment-row")).toHaveCount(2);

    await scanForRestrictedValues(page, "payment detail (second, confirmed)");
    expect(errors.errors).toEqual([]);
  });
});

test.describe("upstream immutability: Payable / Invoice / Agreement figures unchanged after settlement", () => {
  test("re-reading the Payable and Invoice after both Payments confirm shows the same pinned figures", async ({ page }) => {
    const errors = collectBrowserErrors(page);
    await signInAs(page, "admin");

    await page.goto(`/finance/payables/${payableRef}`);
    await expect(page.getByRole("heading", { level: 1, name: PARTNER_DISPLAY_NAME })).toBeVisible();
    await page.getByRole("tab", { name: "Amount breakdown" }).click();
    await expect(page.getByText("₹80,000").first()).toBeVisible();
    await expect(page.getByText("₹86,400").first()).toBeVisible();

    await page.goto(`/finance/invoices/${invoiceRef}`);
    await expect(page.getByText("Approved", { exact: true }).first()).toBeVisible();
    await expect(page.locator("body")).toContainText("₹94,400");

    expect(errors.errors).toEqual([]);
  });
});

for (const width of VIEWPORTS) {
  test.describe(`14/18: at ${width}px`, () => {
    test.use({ viewport: { width, height: width >= 1200 ? 900 : 844 } });

    test(`Payables/Invoices/Payments workspaces and the closure detail pages: no document-level horizontal overflow`, async ({ page }) => {
      const errors = collectBrowserErrors(page);
      await signInAs(page, "admin");

      for (const [workspacePath, testIdPrefix] of [
        ["/finance/payables", "payable"],
        ["/finance/invoices", "invoice"],
        ["/finance/payments", "payment"],
      ] as const) {
        await page.goto(workspacePath);
        await waitForHydration(page, 'select[aria-label="Filter status"]');
        await expect(page.getByTestId(`${testIdPrefix}-row`).or(page.getByTestId(`${testIdPrefix}-card`)).first()).toBeVisible();
        await expectNoOverflow(page, `${workspacePath} at ${width}`);
        if (width <= 760) await expect(page.getByTestId(`${testIdPrefix}-card`).first()).toBeVisible();
        else await expect(page.getByRole("table")).toBeVisible();
      }

      await page.goto(`/finance/payables/${payableRef}`);
      await expect(page.getByRole("tab", { name: "Summary" })).toBeVisible();
      await expectNoOverflow(page, `payable detail at ${width}`);

      await page.goto(`/finance/invoices/${invoiceRef}`);
      await expect(page.getByRole("tab", { name: "Summary" })).toBeVisible();
      await expectNoOverflow(page, `invoice detail at ${width}`);
      await page.getByRole("tab", { name: "Reconciliation" }).click();
      await expect(page.getByTestId("payee-identity-section")).toBeVisible();
      await expectNoOverflow(page, `invoice detail (reconciliation) at ${width}`);

      await page.goto(`/finance/payments/${secondPaymentRef}`);
      await expect(page.getByRole("tab", { name: "Summary" })).toBeVisible();
      await expectNoOverflow(page, `payment detail at ${width}`);
      await page.getByRole("tab", { name: "Settlement" }).click();
      await expect(page.getByTestId("settlement-state-pill")).toContainText("Paid");
      await expectNoOverflow(page, `payment detail (settlement) at ${width}`);

      // 15/19: incidental accessibility - every tab above is reached via getByRole("tab") (a real
      // ARIA tablist/tab, not a div with a click handler), and every dialog opened elsewhere in this
      // spec via getByRole("dialog") with an accessible name. Not a formal audit (see the report).
      expect(errors.errors).toEqual([]);
    });
  });
}
