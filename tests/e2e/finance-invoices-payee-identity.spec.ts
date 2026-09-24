import { expect as baseExpect, test, type Page } from "@playwright/test";

import { collectBrowserErrors, noDocumentOverflow, waitForHydration } from "./helpers/finance-agreements-fixtures";
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

// Step 16C e2e (spec section 25): the Invoice Payee Identity Matching UI, end to end against a real
// browser. Synthetic fixtures only - a real Vendor/Payable/Invoice created through the trusted
// service layer (never raw Firestore writes), a synthetic text-PDF "supplier invoice" (never a real
// user invoice). Runs serially (test.describe.configure + --workers=1 on the CLI).
//
// The payee/supplier name has no manual text input in the Create wizard (Step 16C section 6/18 -
// only ever applied from an extraction proposal), so every scenario below drives it by staging a
// synthetic PDF containing a "Supplier: <name>" line - the same SUPPLIER_LABEL pattern
// extraction/field-extractors.ts already matches - then fills the remaining declared fields by hand
// exactly like the base finance-invoices.spec.ts "matched Invoice" flow does.
//
// GST/tax-registration and bank-identifier evidence are always UNAVAILABLE in this build (no
// restricted-GSTIN/bank extraction pipeline exists yet - see payee-identity/resolve-identity.ts's
// own header comment) - scenario 2 below verifies this is reported HONESTLY (Unavailable, never a
// fabricated match), which is itself the correct, spec-mandated behavior (section 6: "do not invent
// identity values").

test.describe.configure({ mode: "serial" });

const TAG = `FPI${Date.now().toString(36)}`;
const fx: InvoiceFixtures = createInvoiceFixtures(TAG);

async function expectNoOverflow(page: Page, label: string) {
  const { scrollWidth, innerWidth } = await noDocumentOverflow(page);
  expect(scrollWidth, `${label}: document scrolls horizontally (${scrollWidth} > ${innerWidth})`).toBeLessThanOrEqual(innerWidth);
}

const supplierPdf = (supplierName: string) => makeTextPdf([[`Supplier: ${supplierName}`]]);

test.afterAll(async () => {
  await fx.cleanupAll();
});

// Creates a submittable Draft Invoice (number/date/total filled by hand, a synthetic
// "Supplier: <supplierName>" PDF staged so extraction applies the payee name) against a fresh
// READY_FOR_INVOICE Vendor Payable whose display name is `vendorDisplayName`. Returns the created
// Invoice's ref. Signs in as "manager" (manage_invoices) to do it.
async function createDraftWithSupplier(page: Page, vendorDisplayName: string, supplierName: string, invoiceNumberSuffix: string): Promise<string> {
  const basis = await fx.seedReadyVendorPayable(vendorDisplayName);
  await signInAs(page, "manager");
  await page.goto("/finance/invoices/new");
  await page.locator(`[data-testid="eligible-payable-row"][data-payable-ref="${basis.payableRef}"]`).getByTestId("select-payable").click();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Invoice details" })).toBeVisible();

  await page.getByLabel("Invoice number").fill(`${TAG}-${invoiceNumberSuffix}`);
  await page.getByLabel("Invoice date").fill("2024-06-15");
  const totalRupees = (basis.expectedTotalMinorSigned / 100).toString();
  await page.getByLabel("Declared subtotal").fill(totalRupees);
  await page.getByLabel("Declared total").fill(totalRupees);

  await page.getByLabel("Invoice document file").setInputFiles({ name: "supplier-invoice.pdf", mimeType: "application/pdf", buffer: supplierPdf(supplierName) });
  await expect(page.getByTestId("staged-document")).toBeVisible();
  // Wait for extraction to ACTUALLY complete (not just "Extracting…") before continuing - otherwise
  // Continue can race the async applyExtractionPrefill and save the form before payeeName is set.
  await expect(page.getByTestId("extraction-status-banner")).toContainText(/Extraction completed|Manual review required/);
  await expect(page.getByTestId("payee-identity-extraction-note")).toBeVisible();

  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Reconciliation" })).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByTestId("create-invoice-action").click();
  await page.waitForURL(/\/finance\/invoices\/inv_[0-9a-f]{20}$/);
  return new URL(page.url()).pathname.split("/").pop()!;
}

async function submitAsManager(page: Page, invoiceRef: string) {
  await signInAs(page, "manager");
  await page.goto(`/finance/invoices/${invoiceRef}`);
  await page.getByTestId("submit-action").click();
  await page.getByRole("dialog", { name: "Submit Invoice" }).getByRole("button", { name: "Submit" }).click();
  await expect(page.getByText("Submitted", { exact: true }).first()).toBeVisible();
}

test.describe("1. Matching supplier name", () => {
  test("an extracted supplier name identical to the expected Vendor reads Match on the Name row", async ({ page }) => {
    const errors = collectBrowserErrors(page);
    const vendorName = `${TAG} Match Vendor`;
    const invoiceRef = await createDraftWithSupplier(page, vendorName, vendorName, "NAME-01");

    await page.goto(`/finance/invoices/${invoiceRef}`);
    await page.getByRole("tab", { name: "Reconciliation" }).click();
    await expect(page.getByTestId("payee-identity-section")).toBeVisible();
    await expect(page.getByTestId("payee-identity-row-NAME")).toContainText("Match");

    expect(errors.errors).toEqual([]);
  });
});

test.describe("2. GST identity - honestly reported Unavailable (no restricted-GSTIN extraction pipeline in this build)", () => {
  test("the GST / tax registration row never fabricates a match - it reads Unavailable", async ({ page }) => {
    const errors = collectBrowserErrors(page);
    const vendorName = `${TAG} GST Vendor`;
    const invoiceRef = await createDraftWithSupplier(page, vendorName, vendorName, "GST-01");

    await page.goto(`/finance/invoices/${invoiceRef}`);
    await page.getByRole("tab", { name: "Reconciliation" }).click();
    await expect(page.getByTestId("payee-identity-row-TAX_REGISTRATION")).toContainText("Unavailable");

    expect(errors.errors).toEqual([]);
  });
});

test.describe("3. Partial match with missing optional evidence", () => {
  test("a confident name match with GST/address/bank all unavailable reads Overall: Partial match", async ({ page }) => {
    const errors = collectBrowserErrors(page);
    const vendorName = `${TAG} Partial Vendor`;
    const invoiceRef = await createDraftWithSupplier(page, vendorName, vendorName, "PARTIAL-01");

    await page.goto(`/finance/invoices/${invoiceRef}`);
    await page.getByRole("tab", { name: "Reconciliation" }).click();
    await expect(page.getByTestId("payee-identity-row-ADDRESS")).toContainText("Unavailable");
    await expect(page.getByTestId("payee-identity-row-BANK")).toContainText("Unavailable");
    await expect(page.getByTestId("payee-identity-row-overall")).toContainText("Partial match");
    // Summary tab shows the same compact status.
    await page.getByRole("tab", { name: "Summary" }).click();
    await expect(page.getByTestId("summary-payee-identity")).toContainText("Partial match");

    expect(errors.errors).toEqual([]);
  });
});

let mismatchInvoiceRef = "";

test.describe("4. Hard identity mismatch", () => {
  test("a clearly different extracted supplier name reads Overall: Mismatch", async ({ page }) => {
    const errors = collectBrowserErrors(page);
    const vendorName = `${TAG} Mismatch Vendor`;
    mismatchInvoiceRef = await createDraftWithSupplier(page, vendorName, "Totally Different Legal Entity LLC", "MISMATCH-01");

    await page.goto(`/finance/invoices/${mismatchInvoiceRef}`);
    await page.getByRole("tab", { name: "Reconciliation" }).click();
    await expect(page.getByTestId("payee-identity-row-NAME")).toContainText("Mismatch");
    await expect(page.getByTestId("payee-identity-row-overall")).toContainText("Mismatch");
    await expect(page.getByTestId("payee-mismatch-banner")).toBeVisible();

    await submitAsManager(page, mismatchInvoiceRef);

    expect(errors.errors).toEqual([]);
  });
});

test.describe("5. Unauthorized actor cannot resolve mismatch", () => {
  test("Partnership Manager sees no resolve action and the review-required notice instead", async ({ page }) => {
    const errors = collectBrowserErrors(page);
    await signInAs(page, "manager");
    await page.goto(`/finance/invoices/${mismatchInvoiceRef}`);
    await page.getByRole("tab", { name: "Reconciliation" }).click();
    await expect(page.getByTestId("payee-mismatch-banner")).toBeVisible();
    await expect(page.getByTestId("resolve-payee-mismatch-action")).toHaveCount(0);
    await expect(page.getByTestId("payee-mismatch-banner")).toContainText("Requires Partnership Head or Super Admin review.");

    expect(errors.errors).toEqual([]);
  });
});

test.describe("7. Approval blocked before resolution", () => {
  test("Partnership Head's Approve is refused by the server with the payee identity blocker", async ({ page }) => {
    const errors = collectBrowserErrors(page);
    await signInAs(page, "head");
    await page.goto(`/finance/invoices/${mismatchInvoiceRef}`);
    await page.getByTestId("approve-action").click();
    const approveDialog = page.getByRole("dialog", { name: "Approve Invoice" });
    await expect(approveDialog).toBeVisible();
    await approveDialog.getByTestId("confirm-approve").click();
    await expect(approveDialog.getByRole("alert")).toContainText("This invoice cannot be approved yet.");
    await approveDialog.getByRole("button", { name: "Cancel" }).click();
    await expect(approveDialog).toBeHidden();
    // Still submitted, not approved.
    await expect(page.getByText("Submitted", { exact: true }).first()).toBeVisible();

    expect(errors.errors).toEqual([]);
  });
});

test.describe("6. Authorized Head/Admin accepts mismatch with reason", () => {
  test("Partnership Head resolves the payee mismatch, which shows Accepted with reason but preserves the original evidence", async ({ page }) => {
    const errors = collectBrowserErrors(page);
    await signInAs(page, "head");
    await page.goto(`/finance/invoices/${mismatchInvoiceRef}`);
    await page.getByRole("tab", { name: "Reconciliation" }).click();

    await page.getByTestId("resolve-payee-mismatch-action").click();
    const dialog = page.getByRole("dialog", { name: "Resolve payee mismatch" });
    await expect(dialog).toBeVisible();
    await page.getByTestId("payee-mismatch-reason-input").fill("Verified against the signed Agreement; same legal entity under a trading name.");
    await page.getByTestId("confirm-resolve-payee-mismatch").click();
    await expect(dialog).toBeHidden();

    await expect(page.getByTestId("payee-mismatch-accepted-banner")).toBeVisible();
    await expect(page.getByTestId("payee-mismatch-accepted-banner")).toContainText("Verified against the signed Agreement");
    // The ORIGINAL mismatch evidence is preserved on the NAME row, never overwritten (section 16).
    await expect(page.getByTestId("payee-identity-row-NAME")).toContainText("Mismatch");

    expect(errors.errors).toEqual([]);
  });
});

test.describe("8. Approval allowed after resolution", () => {
  test("Partnership Head can now approve the Invoice", async ({ page }) => {
    const errors = collectBrowserErrors(page);
    await signInAs(page, "head");
    await page.goto(`/finance/invoices/${mismatchInvoiceRef}`);
    await page.getByTestId("approve-action").click();
    const approveDialog = page.getByRole("dialog", { name: "Approve Invoice" });
    await expect(approveDialog).toBeVisible();
    await approveDialog.getByTestId("confirm-approve").click();
    await expect(approveDialog).toBeHidden();
    await expect(page.getByText("Approved", { exact: true }).first()).toBeVisible();

    expect(errors.errors).toEqual([]);
  });
});

test.describe("9. History records the resolution", () => {
  test("the History tab lists the payee identity checks and the accepted resolution", async ({ page }) => {
    const errors = collectBrowserErrors(page);
    await signInAs(page, "admin");
    await page.goto(`/finance/invoices/${mismatchInvoiceRef}`);
    await page.getByRole("tab", { name: "History" }).click();
    await expect(page.getByRole("cell", { name: "Payee mismatch accepted" })).toBeVisible();
    await expect(page.getByRole("cell", { name: "Payee identity checked" }).first()).toBeVisible();

    expect(errors.errors).toEqual([]);
  });
});

test.describe("10. No raw sensitive bank/tax data rendered", () => {
  test("the Reconciliation tab never renders a raw GST/bank value - only status text", async ({ page }) => {
    const errors = collectBrowserErrors(page);
    await signInAs(page, "admin");
    await page.goto(`/finance/invoices/${mismatchInvoiceRef}`);
    await page.getByRole("tab", { name: "Reconciliation" }).click();
    await expect(page.getByTestId("payee-identity-row-TAX_REGISTRATION")).toContainText("Unavailable");
    await expect(page.getByTestId("payee-identity-row-BANK")).toContainText("Unavailable");
    const bodyText = await page.locator("body").innerText();
    // No 9+ digit run anywhere on the page (a bare bank account number or similar).
    expect(bodyText).not.toMatch(/\d{9,}/);
    for (const forbidden of ["panNumber", "aadhaarNumber", "gstin", "ifsc"]) expect(bodyText.toLowerCase()).not.toContain(forbidden.toLowerCase());

    expect(errors.errors).toEqual([]);
  });
});

test.describe("11. Mobile 390", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the Payee identity section renders with no horizontal overflow at 390px", async ({ page }) => {
    const errors = collectBrowserErrors(page);
    await signInAs(page, "admin");
    await page.goto(`/finance/invoices/${mismatchInvoiceRef}`);
    await expect(page.getByRole("tab", { name: "Summary" })).toBeVisible();
    await expectNoOverflow(page, "detail 390 (summary)");

    await page.getByRole("tab", { name: "Reconciliation" }).click();
    await expect(page.getByTestId("payee-identity-section")).toBeVisible();
    await expectNoOverflow(page, "detail 390 (reconciliation, payee identity)");

    expect(errors.errors).toEqual([]);
  });
});

test.describe("12. Six-width overflow", () => {
  for (const width of VIEWPORTS) {
    test(`at ${width}px: Invoice detail with Payee identity section has no document-level horizontal overflow`, async ({ page }) => {
      await page.setViewportSize({ width, height: width >= 1200 ? 900 : 844 });
      const errors = collectBrowserErrors(page);
      await signInAs(page, "admin");
      await page.goto(`/finance/invoices/${mismatchInvoiceRef}`);
      await expect(page.getByRole("tab", { name: "Summary" })).toBeVisible();
      await waitForHydration(page, '[data-testid="summary-payee-identity"]');
      await expectNoOverflow(page, `detail ${width} (summary)`);

      await page.getByRole("tab", { name: "Reconciliation" }).click();
      await expect(page.getByTestId("payee-identity-section")).toBeVisible();
      await expectNoOverflow(page, `detail ${width} (reconciliation)`);

      // 13. Zero console errors - enforced on every scenario in this file via collectBrowserErrors;
      // asserted explicitly here too since this loop is the natural place spec section 25 names it.
      expect(errors.errors).toEqual([]);
    });
  }
});
