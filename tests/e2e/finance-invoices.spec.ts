import { expect as baseExpect, test, type Page } from "@playwright/test";

import { collectBrowserErrors, noDocumentOverflow, PDFS, SAMPLE_PDF_NAME, waitForHydration } from "./helpers/finance-agreements-fixtures";
import { createInvoiceFixtures, PASSWORD, VIEWPORTS, type InvoiceFixtures } from "./helpers/finance-invoices-fixtures";
import { emailFor } from "./helpers/finance-payables-fixtures";
import { makeTextPdf } from "@/server/finance-agreements/testing/pdf-fixtures";

// Dev-mode route compilation makes the first call of an API route slow: allow more than the 5 s default.
const expect = baseExpect.configure({ timeout: 20_000 });

async function signInAs(page: Page, name: "admin" | "manager" | "head" | "viewer" | "analyst") {
  await page.context().clearCookies();
  await page.goto("/sign-in");
  await page.getByPlaceholder("you@company.com").fill(emailFor(name));
  await page.getByPlaceholder("Enter your password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/dashboard$/);
}

// Step 16B e2e: the focused Invoices UI suite.
//   - Workspace: loads, status strip, filters, Create Invoice action.
//   - Create: 4-stage wizard (Source Payable -> Invoice Details -> Reconciliation -> Confirm) for a
//     MATCH scenario, landing on the new Invoice's Draft detail page.
//   - Detail: all four tabs (Summary / Reconciliation / Document / History).
//   - Submit -> Approve (match scenario, Partnership Head).
//   - A second Invoice: Submit -> Reject -> Reopen (back to Draft).
//   - A third Invoice: Void (terminal, read-only afterward).
//   - Six-width responsive certification + no console errors.
// Hermetic: private-region fixtures created through the TRUSTED Finance Payables service (a
// READY_FOR_INVOICE Vendor Payable), unique tag, removed in afterAll.

test.describe.configure({ mode: "serial" });

const TAG = `FIV${Date.now().toString(36)}`;
const fx: InvoiceFixtures = createInvoiceFixtures(TAG);

let matchInvoiceRef = "";
let rejectInvoiceRef = "";
let voidInvoiceRef = "";

async function expectNoOverflow(page: Page, label: string) {
  const { scrollWidth, innerWidth } = await noDocumentOverflow(page);
  expect(scrollWidth, `${label}: document scrolls horizontally (${scrollWidth} > ${innerWidth})`).toBeLessThanOrEqual(innerWidth);
}

// Step 15C section 34: a real, Invoice-shaped text PDF (distinct from PDFS.sample(), which is an
// Agreement contract fixture) - the same wording pattern the backend emulator suite's own
// extraction-preview tests use, so this exercises the identical extraction path end to end through
// a real browser upload.
const EXTRACTION_PDF_NAME = "supplier-invoice.pdf";
const extractionSamplePdf = () => makeTextPdf([["Invoice Number: INV-E2E-777", "Invoice Date: 20 June 2024", "Sub Total: INR 10,000", "GST @ 18%", "Total Due: INR 11,800"]]);

test.afterAll(async () => {
  await fx.cleanupAll();
});

test.describe("Workspace", () => {
  test("loads, shows the status strip, filter controls, and a Create Invoice action", async ({ page }) => {
    const errors = collectBrowserErrors(page);
    await signInAs(page, "admin");
    await page.goto("/finance/invoices");
    await expect(page.getByRole("heading", { level: 1, name: "Invoices" })).toBeVisible();
    await expect(page.getByTestId("workspace-status-strip")).toBeVisible();
    await expect(page.getByRole("link", { name: "Create Invoice" })).toBeVisible();
    await waitForHydration(page, 'select[aria-label="Filter status"]');
    for (const label of ["Filter status", "Filter reconciliation", "Filter Partner or Vendor", "Search counterparty", "Filter commercial period"]) {
      await expect(page.getByLabel(label)).toBeVisible();
    }
    expect(errors.errors).toEqual([]);
  });
});

test.describe("Create Invoice", () => {
  test("Source Payable -> Invoice Details -> Reconciliation -> Confirm: a matched Invoice", async ({ page }) => {
    const errors = collectBrowserErrors(page);
    const displayName = `${TAG} Match Vendor`;
    const basis = await fx.seedReadyVendorPayable(displayName);

    await signInAs(page, "manager");
    await page.goto("/finance/invoices/new");
    await expect(page.getByRole("heading", { level: 1, name: "Create Invoice" })).toBeVisible();

    await expect(page.getByTestId("eligible-payable-row").filter({ hasText: basis.payableRef })).toBeVisible();
    await page.locator(`[data-testid="eligible-payable-row"][data-payable-ref="${basis.payableRef}"]`).getByTestId("select-payable").click();
    await expect(page.getByText("Ready for invoice", { exact: true }).first()).toBeVisible();
    await expectNoOverflow(page, "create source stage");

    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Invoice details" })).toBeVisible();

    await page.getByLabel("Invoice number").fill(`${TAG}-MATCH-001`);
    await page.getByLabel("Invoice date").fill("2024-06-15");
    const totalRupees = (basis.expectedTotalMinorSigned / 100).toString();
    await page.getByLabel("Declared subtotal").fill(totalRupees);
    await page.getByLabel("Declared total").fill(totalRupees);
    await page.getByLabel("Invoice document file").setInputFiles({ name: SAMPLE_PDF_NAME, mimeType: "application/pdf", buffer: PDFS.sample() });
    await expect(page.getByTestId("staged-document")).toBeVisible();
    await expectNoOverflow(page, "create details stage");

    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Reconciliation" })).toBeVisible();
    await expect(page.getByTestId("reconciliation-row-total")).toContainText("Match");
    await expectNoOverflow(page, "create reconciliation stage");

    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Readiness" })).toBeVisible();
    await expect(page.getByTestId("create-invoice-action")).toBeEnabled();
    await page.getByTestId("create-invoice-action").click();

    await page.waitForURL(/\/finance\/invoices\/inv_[0-9a-f]{20}$/);
    matchInvoiceRef = new URL(page.url()).pathname.split("/").pop()!;
    await expect(page.getByText("Draft", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Match", { exact: true }).first()).toBeVisible();

    expect(errors.errors).toEqual([]);
  });
});

test.describe("Invoice extraction", () => {
  test("uploading a real Invoice PDF extracts and prefills fields, and a user-edited field survives", async ({ page }) => {
    const errors = collectBrowserErrors(page);
    const displayName = `${TAG} Extraction Vendor`;
    const basis = await fx.seedReadyVendorPayable(displayName);

    await signInAs(page, "manager");
    await page.goto("/finance/invoices/new");
    await page.locator(`[data-testid="eligible-payable-row"][data-payable-ref="${basis.payableRef}"]`).getByTestId("select-payable").click();
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Invoice details" })).toBeVisible();

    // Manually set the invoice date FIRST (marks it touched) - proves extraction, which would
    // otherwise propose a different date from the PDF text below, never overwrites it.
    await page.getByLabel("Invoice date").fill("2099-01-01");

    await page.getByLabel("Invoice document file").setInputFiles({ name: EXTRACTION_PDF_NAME, mimeType: "application/pdf", buffer: extractionSamplePdf() });
    await expect(page.getByTestId("staged-document")).toBeVisible();
    await expect(page.getByTestId("extraction-status-banner")).toBeVisible();
    await expect(page.getByTestId("extraction-status-banner")).toContainText(/Extraction completed/);

    // Untouched fields were prefilled from the PDF and carry the "Extracted" tag.
    await expect(page.getByLabel("Invoice number")).toHaveValue("INV-E2E-777");
    await expect(page.getByTestId("extracted-tag-externalInvoiceNumber")).toBeVisible();
    await expect(page.getByLabel("Declared total")).toHaveValue("11800");
    await expect(page.getByTestId("extracted-tag-declaredTotalMinor")).toBeVisible();

    // The user-touched field kept the manual value, and was never retagged as extracted.
    await expect(page.getByLabel("Invoice date")).toHaveValue("2099-01-01");
    await expect(page.getByTestId("extracted-tag-invoiceDate")).toHaveCount(0);
    await expectNoOverflow(page, "create details stage with extraction");

    expect(errors.errors).toEqual([]);
  });
});

test.describe("Invoice detail", () => {
  test("Summary / Reconciliation / Document / History tabs render", async ({ page }) => {
    const errors = collectBrowserErrors(page);
    await signInAs(page, "admin");
    await page.goto(`/finance/invoices/${matchInvoiceRef}`);
    await expect(page.getByRole("tab", { name: "Summary" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Invoice summary" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Approval / readiness" })).toBeVisible();

    await page.getByRole("tab", { name: "Reconciliation" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Reconciliation" })).toBeVisible();
    await expect(page.getByTestId("reconciliation-row-total")).toBeVisible();

    await page.getByRole("tab", { name: "Document" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Invoice Document" })).toBeVisible();

    await page.getByRole("tab", { name: "History" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "History" })).toBeVisible();
    await expect(page.getByRole("cell", { name: "Invoice created" })).toBeVisible();

    expect(errors.errors).toEqual([]);
  });

  test("Submit then Approve (Partnership Head)", async ({ page }) => {
    const errors = collectBrowserErrors(page);
    await signInAs(page, "manager");
    await page.goto(`/finance/invoices/${matchInvoiceRef}`);

    await page.getByTestId("submit-action").click();
    const submitDialog = page.getByRole("dialog", { name: "Submit Invoice" });
    await expect(submitDialog).toBeVisible();
    await submitDialog.getByRole("button", { name: "Submit" }).click();
    await expect(submitDialog).toBeHidden();
    await expect(page.getByText("Submitted", { exact: true }).first()).toBeVisible();
    await expect(page.getByTestId("approve-action")).toHaveCount(0);

    await signInAs(page, "head");
    await page.goto(`/finance/invoices/${matchInvoiceRef}`);
    await page.getByTestId("approve-action").click();
    const approveDialog = page.getByRole("dialog", { name: "Approve Invoice" });
    await expect(approveDialog).toBeVisible();
    await approveDialog.getByTestId("confirm-approve").click();
    await expect(approveDialog).toBeHidden();
    await expect(page.getByText("Approved", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Approved Invoice is ready for the Payments module.")).toBeVisible();
    await expect(page.getByTestId("submit-action")).toHaveCount(0);
    await expect(page.getByTestId("void-action")).toHaveCount(0);

    expect(errors.errors).toEqual([]);
  });

  test("Submit -> Reject -> Reopen (back to Draft)", async ({ page }) => {
    const errors = collectBrowserErrors(page);
    const displayName = `${TAG} Reject Vendor`;
    const basis = await fx.seedReadyVendorPayable(displayName);

    await signInAs(page, "manager");
    await page.goto("/finance/invoices/new");
    await page.locator(`[data-testid="eligible-payable-row"][data-payable-ref="${basis.payableRef}"]`).getByTestId("select-payable").click();
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByLabel("Invoice number").fill(`${TAG}-REJECT-001`);
    await page.getByLabel("Invoice date").fill("2024-06-15");
    const totalRupees = (basis.expectedTotalMinorSigned / 100).toString();
    await page.getByLabel("Declared subtotal").fill(totalRupees);
    await page.getByLabel("Declared total").fill(totalRupees);
    await page.getByLabel("Invoice document file").setInputFiles({ name: SAMPLE_PDF_NAME, mimeType: "application/pdf", buffer: PDFS.sample() });
    await expect(page.getByTestId("staged-document")).toBeVisible();
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Reconciliation" })).toBeVisible();
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByTestId("create-invoice-action").click();
    await page.waitForURL(/\/finance\/invoices\/inv_[0-9a-f]{20}$/);
    rejectInvoiceRef = new URL(page.url()).pathname.split("/").pop()!;

    await page.getByTestId("submit-action").click();
    await page.getByRole("dialog", { name: "Submit Invoice" }).getByRole("button", { name: "Submit" }).click();
    await expect(page.getByText("Submitted", { exact: true }).first()).toBeVisible();

    await signInAs(page, "head");
    await page.goto(`/finance/invoices/${rejectInvoiceRef}`);
    await page.getByTestId("reject-action").click();
    const rejectDialog = page.getByRole("dialog", { name: "Reject Invoice" });
    await expect(rejectDialog).toBeVisible();
    await rejectDialog.getByLabel("Reason").fill("Supplier invoice total needs correction before resubmission.");
    await rejectDialog.getByRole("button", { name: "Reject Invoice" }).click();
    await expect(rejectDialog).toBeHidden();
    await expect(page.getByText("Rejected", { exact: true }).first()).toBeVisible();

    await page.getByTestId("reopen-action").click();
    const reopenDialog = page.getByRole("dialog", { name: "Reopen Invoice" });
    await expect(reopenDialog).toBeVisible();
    await reopenDialog.getByLabel("Reason").fill("Reopening to correct the declared total.");
    await reopenDialog.getByRole("button", { name: "Reopen" }).click();
    await expect(reopenDialog).toBeHidden();
    await expect(page.getByText("Draft", { exact: true }).first()).toBeVisible();
    await expect(page.getByTestId("submit-action")).toBeVisible();

    expect(errors.errors).toEqual([]);
  });

  test("Void: terminal, read-only afterward", async ({ page }) => {
    const errors = collectBrowserErrors(page);
    const displayName = `${TAG} Void Vendor`;
    const basis = await fx.seedReadyVendorPayable(displayName);

    await signInAs(page, "manager");
    await page.goto("/finance/invoices/new");
    await page.locator(`[data-testid="eligible-payable-row"][data-payable-ref="${basis.payableRef}"]`).getByTestId("select-payable").click();
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByLabel("Invoice number").fill(`${TAG}-VOID-001`);
    await page.getByRole("button", { name: "Continue" }).click();
    // Wait for Stage 3 to actually render before clicking Continue again - firing both clicks
    // back-to-back risks the second one landing on Stage 2's own "Continue" a second time (a real
    // double-submit race: two concurrent saves against the same optimistic-concurrency docVersion,
    // one of which fails and strands the flow on Stage 2) - the same wait the "matched Invoice"
    // test above already uses between its own two Continue clicks.
    await expect(page.getByRole("heading", { level: 2, name: "Reconciliation" })).toBeVisible();
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByTestId("create-invoice-action").click();
    await page.waitForURL(/\/finance\/invoices\/inv_[0-9a-f]{20}$/);
    voidInvoiceRef = new URL(page.url()).pathname.split("/").pop()!;

    await signInAs(page, "head");
    await page.goto(`/finance/invoices/${voidInvoiceRef}`);
    await page.getByTestId("void-action").click();
    const voidDialog = page.getByRole("dialog", { name: "Void this Invoice" });
    await expect(voidDialog).toBeVisible();
    await voidDialog.getByLabel("Reason").fill("Voided for the e2e fixture cleanup path.");
    await voidDialog.getByRole("button", { name: "Void Invoice" }).click();
    await expect(voidDialog).toBeHidden();

    await expect(page.getByText("Void", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("This Invoice is void and read-only.")).toBeVisible();
    await expect(page.getByTestId("submit-action")).toHaveCount(0);
    await expect(page.getByTestId("void-action")).toHaveCount(0);

    expect(errors.errors).toEqual([]);
  });
});

for (const width of VIEWPORTS) {
  test.describe(`at ${width}px`, () => {
    test.use({ viewport: { width, height: width >= 1200 ? 900 : 844 } });

    test(`Workspace + an Invoice detail: no document-level horizontal overflow, table on wide / cards on narrow`, async ({ page }) => {
      const errors = collectBrowserErrors(page);
      await signInAs(page, "admin");

      await page.goto("/finance/invoices");
      await expect(page.getByRole("heading", { level: 1, name: "Invoices" })).toBeVisible();
      await waitForHydration(page, 'select[aria-label="Filter status"]');
      await expect(page.getByTestId("invoice-row").or(page.getByTestId("invoice-card")).first()).toBeVisible();
      await expectNoOverflow(page, `workspace ${width}`);
      if (width <= 760) await expect(page.getByTestId("invoice-card").first()).toBeVisible();
      else await expect(page.getByRole("table")).toBeVisible();

      await page.goto(`/finance/invoices/${matchInvoiceRef}`);
      await expect(page.getByRole("tab", { name: "Summary" })).toBeVisible();
      await expectNoOverflow(page, `detail ${width}`);

      expect(errors.errors).toEqual([]);
    });
  });
}
