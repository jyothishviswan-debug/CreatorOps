import { expect as baseExpect, test, type Page } from "@playwright/test";

import { collectBrowserErrors, noDocumentOverflow, waitForHydration } from "./helpers/finance-agreements-fixtures";
import { CANONICAL_IDENTITY, createInvoiceFixtures, PASSWORD, VIEWPORTS, type InvoiceFixtures } from "./helpers/finance-invoices-fixtures";
import { emailFor } from "./helpers/finance-payables-fixtures";
import { makeTextPdf } from "@/server/finance-agreements/testing/pdf-fixtures";

const expect = baseExpect.configure({ timeout: 20_000 });

async function signInAs(page: Page, name: "admin" | "manager" | "head" | "viewer" | "analyst") {
  await page.context().clearCookies();
  await page.goto("/sign-in");
  await page.getByPlaceholder("you@company.com").fill(emailFor(name));
  await page.getByPlaceholder("Enter your password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/dashboard$/);
}

// Step 16D e2e (spec section 23): the LIVE restricted GST/address/bank identity-evidence extraction
// path, end to end against a real browser - proving Step 16C's Reconciliation tab now shows real
// safe comparison states (not always Unavailable) once a Vendor has canonical restricted identity on
// file and a synthetic text-PDF states matching/mismatching evidence near the right labels. Synthetic
// fixtures only (createInvoiceFixtures.seedReadyVendorPayableWithIdentity writes directly into the
// restrictedFinancialIdentities collection through the SAME trusted-test-setup pattern
// finance-agreements-fixtures.ts's own seedKyc already uses - never a real user invoice, never real
// GST/bank values). Runs serially (test.describe.configure + --workers=1 on the CLI, same as
// finance-invoices-payee-identity.spec.ts).

test.describe.configure({ mode: "serial" });

const TAG = `FIE${Date.now().toString(36)}`;
const fx: InvoiceFixtures = createInvoiceFixtures(TAG);

async function expectNoOverflow(page: Page, label: string) {
  const { scrollWidth, innerWidth } = await noDocumentOverflow(page);
  expect(scrollWidth, `${label}: document scrolls horizontally (${scrollWidth} > ${innerWidth})`).toBeLessThanOrEqual(innerWidth);
}

// A synthetic "supplier invoice" text PDF with a supplier name, a multiline address block, a GSTIN
// line and a bank Account Number line - the EXACT label vocabulary restricted-extraction.ts matches.
function supplierEvidencePdf(opts: { supplierName: string; address?: string | null; gst?: string | null; bankAccountNumber?: string | null }) {
  const lines = [`Supplier: ${opts.supplierName}`];
  if (opts.address) lines.push(opts.address);
  if (opts.gst) lines.push(`GSTIN: ${opts.gst}`);
  if (opts.bankAccountNumber) lines.push(`Account Number: ${opts.bankAccountNumber}`);
  return makeTextPdf([lines]);
}

test.afterAll(async () => {
  await fx.cleanupAll();
});

// Creates a submittable Draft Invoice against a fresh READY_FOR_INVOICE Vendor Payable whose Vendor
// has the given canonical restricted identity on file, staging a synthetic PDF with the given
// extracted evidence. Signs in as "manager" (manage_invoices).
async function createDraftWithEvidence(
  page: Page,
  vendorDisplayName: string,
  canonical: { gst?: string | null; bankAccountNumber?: string | null; address?: string | null },
  extracted: { supplierName: string; address?: string | null; gst?: string | null; bankAccountNumber?: string | null },
  invoiceNumberSuffix: string,
): Promise<string> {
  const basis = await fx.seedReadyVendorPayableWithIdentity(vendorDisplayName, canonical);
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

  await page.getByLabel("Invoice document file").setInputFiles({ name: "supplier-invoice.pdf", mimeType: "application/pdf", buffer: supplierEvidencePdf(extracted) });
  await expect(page.getByTestId("staged-document")).toBeVisible();
  await expect(page.getByTestId("extraction-status-banner")).toContainText(/Extraction completed|Manual review required/);
  await expect(page.getByTestId("payee-identity-extraction-note")).toBeVisible();

  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Reconciliation" })).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByTestId("create-invoice-action").click();
  await page.waitForURL(/\/finance\/invoices\/inv_[0-9a-f]{20}$/);
  return new URL(page.url()).pathname.split("/").pop()!;
}

test.describe("1. Supplier name + GST match", () => {
  test("a GSTIN extracted matching the canonical Vendor GST reads Match on the GST row", async ({ page }) => {
    const errors = collectBrowserErrors(page);
    const vendorName = `${TAG} GST Match Vendor`;
    const invoiceRef = await createDraftWithEvidence(page, vendorName, { gst: CANONICAL_IDENTITY.gst }, { supplierName: vendorName, gst: CANONICAL_IDENTITY.gst }, "GSTOK-01");

    await page.goto(`/finance/invoices/${invoiceRef}`);
    await page.getByRole("tab", { name: "Reconciliation" }).click();
    await expect(page.getByTestId("payee-identity-row-NAME")).toContainText("Match");
    await expect(page.getByTestId("payee-identity-row-TAX_REGISTRATION")).toContainText("Match");
    await expect(page.getByTestId("payee-identity-row-overall")).toContainText("Match");

    expect(errors.errors).toEqual([]);
  });
});

let gstMismatchInvoiceRef = "";

test.describe("2. GST mismatch", () => {
  test("an extracted GSTIN that differs from the canonical Vendor GST reads Mismatch, and blocks approval", async ({ page }) => {
    const errors = collectBrowserErrors(page);
    const vendorName = `${TAG} GST Mismatch Vendor`;
    gstMismatchInvoiceRef = await createDraftWithEvidence(page, vendorName, { gst: CANONICAL_IDENTITY.gst }, { supplierName: vendorName, gst: CANONICAL_IDENTITY.gstMismatch }, "GSTBAD-01");

    await page.goto(`/finance/invoices/${gstMismatchInvoiceRef}`);
    await page.getByRole("tab", { name: "Reconciliation" }).click();
    await expect(page.getByTestId("payee-identity-row-TAX_REGISTRATION")).toContainText("Mismatch");
    await expect(page.getByTestId("payee-identity-row-overall")).toContainText("Mismatch");
    await expect(page.getByTestId("payee-mismatch-banner")).toBeVisible();

    // 8. Hard mismatch blocks approval.
    await signInAs(page, "manager");
    await page.goto(`/finance/invoices/${gstMismatchInvoiceRef}`);
    await page.getByTestId("submit-action").click();
    await page.getByRole("dialog", { name: "Submit Invoice" }).getByRole("button", { name: "Submit" }).click();
    await expect(page.getByText("Submitted", { exact: true }).first()).toBeVisible();

    await signInAs(page, "head");
    await page.goto(`/finance/invoices/${gstMismatchInvoiceRef}`);
    await page.getByTestId("approve-action").click();
    const approveDialog = page.getByRole("dialog", { name: "Approve Invoice" });
    await expect(approveDialog).toBeVisible();
    await approveDialog.getByTestId("confirm-approve").click();
    await expect(approveDialog.getByRole("alert")).toContainText("This invoice cannot be approved yet.");
    await approveDialog.getByRole("button", { name: "Cancel" }).click();

    expect(errors.errors).toEqual([]);
  });
});

test.describe("9. Authorized resolution unblocks approval (GST-mismatch driven)", () => {
  test("Partnership Head resolves the GST mismatch with a reason, then can approve", async ({ page }) => {
    const errors = collectBrowserErrors(page);
    await signInAs(page, "head");
    await page.goto(`/finance/invoices/${gstMismatchInvoiceRef}`);
    await page.getByRole("tab", { name: "Reconciliation" }).click();
    await page.getByTestId("resolve-payee-mismatch-action").click();
    const dialog = page.getByRole("dialog", { name: "Resolve payee mismatch" });
    await expect(dialog).toBeVisible();
    await page.getByTestId("payee-mismatch-reason-input").fill("Vendor confirmed a GST registration change; verified by phone.");
    await page.getByTestId("confirm-resolve-payee-mismatch").click();
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId("payee-mismatch-accepted-banner")).toBeVisible();
    // The ORIGINAL mismatch evidence is preserved, never overwritten (section 16).
    await expect(page.getByTestId("payee-identity-row-TAX_REGISTRATION")).toContainText("Mismatch");

    await page.getByTestId("approve-action").click();
    const approveDialog = page.getByRole("dialog", { name: "Approve Invoice" });
    await expect(approveDialog).toBeVisible();
    await approveDialog.getByTestId("confirm-approve").click();
    await expect(approveDialog).toBeHidden();
    await expect(page.getByText("Approved", { exact: true }).first()).toBeVisible();

    expect(errors.errors).toEqual([]);
  });
});

test.describe("3. Address match", () => {
  test("an extracted supplier address identical to the canonical address reads Match on the Address row", async ({ page }) => {
    const errors = collectBrowserErrors(page);
    const vendorName = `${TAG} Address Match Vendor`;
    const invoiceRef = await createDraftWithEvidence(page, vendorName, { address: CANONICAL_IDENTITY.address }, { supplierName: vendorName, address: CANONICAL_IDENTITY.address }, "ADDROK-01");

    await page.goto(`/finance/invoices/${invoiceRef}`);
    await page.getByRole("tab", { name: "Reconciliation" }).click();
    await expect(page.getByTestId("payee-identity-row-ADDRESS")).toContainText("Match");

    expect(errors.errors).toEqual([]);
  });
});

test.describe("4. Address partial/review", () => {
  test("an extracted address that only partially overlaps the canonical address reads Review required, never a silent Match", async ({ page }) => {
    const errors = collectBrowserErrors(page);
    const vendorName = `${TAG} Address Partial Vendor`;
    const invoiceRef = await createDraftWithEvidence(
      page,
      vendorName,
      { address: CANONICAL_IDENTITY.address },
      { supplierName: vendorName, address: "12 MG Road, near the metro station, Bengaluru" },
      "ADDRREV-01",
    );

    await page.goto(`/finance/invoices/${invoiceRef}`);
    await page.getByRole("tab", { name: "Reconciliation" }).click();
    await expect(page.getByTestId("payee-identity-row-ADDRESS")).not.toContainText("Mismatch");
    await expect(page.getByTestId("payee-identity-row-ADDRESS")).toContainText("Review required");

    expect(errors.errors).toEqual([]);
  });
});

test.describe("5. Bank match using masked UI", () => {
  test("an extracted bank account matching the canonical account reads Match, showing only a masked last-4 display", async ({ page }) => {
    const errors = collectBrowserErrors(page);
    const vendorName = `${TAG} Bank Match Vendor`;
    const invoiceRef = await createDraftWithEvidence(page, vendorName, { bankAccountNumber: CANONICAL_IDENTITY.bankAccountNumber }, { supplierName: vendorName, bankAccountNumber: CANONICAL_IDENTITY.bankAccountNumber }, "BANKOK-01");

    await page.goto(`/finance/invoices/${invoiceRef}`);
    await page.getByRole("tab", { name: "Reconciliation" }).click();
    await expect(page.getByTestId("payee-identity-row-BANK")).toContainText("Match");
    await expect(page.getByTestId("payee-identity-row-BANK")).toContainText("••••");
    await expect(page.getByTestId("payee-identity-row-BANK")).toContainText(CANONICAL_IDENTITY.bankAccountNumber.slice(-4));
    const bodyText = await page.locator("body").innerText();
    expect(bodyText).not.toContain(CANONICAL_IDENTITY.bankAccountNumber);

    expect(errors.errors).toEqual([]);
  });
});

let bankMismatchInvoiceRef = "";

test.describe("6. Bank mismatch using masked UI", () => {
  test("an extracted bank account that differs from the canonical account reads Mismatch, still only ever showing a masked display", async ({ page }) => {
    const errors = collectBrowserErrors(page);
    const vendorName = `${TAG} Bank Mismatch Vendor`;
    bankMismatchInvoiceRef = await createDraftWithEvidence(
      page,
      vendorName,
      { bankAccountNumber: CANONICAL_IDENTITY.bankAccountNumber },
      { supplierName: vendorName, bankAccountNumber: CANONICAL_IDENTITY.bankAccountMismatch },
      "BANKBAD-01",
    );

    await page.goto(`/finance/invoices/${bankMismatchInvoiceRef}`);
    await page.getByRole("tab", { name: "Reconciliation" }).click();
    await expect(page.getByTestId("payee-identity-row-BANK")).toContainText("Mismatch");
    await expect(page.getByTestId("payee-identity-row-BANK")).toContainText("••••");
    const bodyText = await page.locator("body").innerText();
    expect(bodyText).not.toContain(CANONICAL_IDENTITY.bankAccountNumber);
    expect(bodyText).not.toContain(CANONICAL_IDENTITY.bankAccountMismatch);

    expect(errors.errors).toEqual([]);
  });
});

test.describe("7. No raw GST/bank value anywhere in the DOM or serialized response", () => {
  test("neither the GST-mismatch nor the bank-mismatch Invoice ever renders or serializes a raw restricted value", async ({ page }) => {
    const errors = collectBrowserErrors(page);
    await signInAs(page, "admin");

    for (const ref of [gstMismatchInvoiceRef, bankMismatchInvoiceRef]) {
      await page.goto(`/finance/invoices/${ref}`);
      await page.getByRole("tab", { name: "Reconciliation" }).click();

      const responseBodies: string[] = [];
      page.on("response", async (response) => {
        if (response.url().includes("/api/finance/invoices/")) {
          try {
            responseBodies.push(await response.text());
          } catch {
            // ignore non-text bodies
          }
        }
      });
      await page.reload();
      await page.getByRole("tab", { name: "Reconciliation" }).click();
      await expect(page.getByTestId("payee-identity-section")).toBeVisible();

      const bodyText = await page.locator("body").innerText();
      for (const raw of [CANONICAL_IDENTITY.gst, CANONICAL_IDENTITY.gstMismatch, CANONICAL_IDENTITY.bankAccountNumber, CANONICAL_IDENTITY.bankAccountMismatch]) {
        expect(bodyText).not.toContain(raw);
        for (const body of responseBodies) expect(body).not.toContain(raw);
      }
      for (const forbidden of ["panNumber", "aadhaarNumber", "gstin", "ifsc", "accountNumber", "accountHolderName"]) {
        expect(bodyText.toLowerCase()).not.toContain(forbidden.toLowerCase());
      }
    }

    expect(errors.errors).toEqual([]);
  });
});

test.describe("10. Document replacement recomputes the identity match", () => {
  test("replacing the attached document with one that now states a matching GSTIN turns the GST row from Unavailable to Match, on a NEW version", async ({ page }) => {
    const errors = collectBrowserErrors(page);
    const vendorName = `${TAG} Replace Vendor`;
    const invoiceRef = await createDraftWithEvidence(page, vendorName, { gst: CANONICAL_IDENTITY.gst }, { supplierName: vendorName }, "REPLACE-01");

    await page.goto(`/finance/invoices/${invoiceRef}`);
    await page.getByRole("tab", { name: "Reconciliation" }).click();
    await expect(page.getByTestId("payee-identity-row-TAX_REGISTRATION")).toContainText("Unavailable");

    await page.getByRole("tab", { name: "Document" }).click();
    await expect(page.getByTestId("replace-document")).toBeVisible();
    await page.getByTestId("replace-document").click();
    await page.getByLabel("Invoice document file").setInputFiles({ name: "supplier-invoice-v2.pdf", mimeType: "application/pdf", buffer: supplierEvidencePdf({ supplierName: vendorName, gst: CANONICAL_IDENTITY.gst }) });
    await expect(page.getByTestId("replace-document")).toBeEnabled();

    await page.getByRole("tab", { name: "Reconciliation" }).click();
    await expect(page.getByTestId("payee-identity-row-TAX_REGISTRATION")).toContainText("Match");

    // The attached-version marker on the Document tab moved forward, proving this landed on a NEW
    // immutable version rather than mutating the first one.
    await page.getByRole("tab", { name: "Document" }).click();
    await expect(page.getByText("v2", { exact: false }).first()).toBeVisible();

    expect(errors.errors).toEqual([]);
  });
});

test.describe("11. Mobile 390", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("live GST/address/bank rows render with no horizontal overflow at 390px", async ({ page }) => {
    const errors = collectBrowserErrors(page);
    await signInAs(page, "admin");
    await page.goto(`/finance/invoices/${bankMismatchInvoiceRef}`);
    await expect(page.getByRole("tab", { name: "Summary" })).toBeVisible();
    await expectNoOverflow(page, "identity-evidence detail 390 (summary)");

    await page.getByRole("tab", { name: "Reconciliation" }).click();
    await expect(page.getByTestId("payee-identity-section")).toBeVisible();
    await expectNoOverflow(page, "identity-evidence detail 390 (reconciliation, payee identity)");

    expect(errors.errors).toEqual([]);
  });
});

test.describe("12. Six-width overflow", () => {
  for (const width of VIEWPORTS) {
    test(`at ${width}px: Invoice detail with live GST/address/bank rows has no document-level horizontal overflow`, async ({ page }) => {
      await page.setViewportSize({ width, height: width >= 1200 ? 900 : 844 });
      const errors = collectBrowserErrors(page);
      await signInAs(page, "admin");
      await page.goto(`/finance/invoices/${bankMismatchInvoiceRef}`);
      await expect(page.getByRole("tab", { name: "Summary" })).toBeVisible();
      await waitForHydration(page, '[data-testid="summary-payee-identity"]');
      await expectNoOverflow(page, `identity-evidence detail ${width} (summary)`);

      await page.getByRole("tab", { name: "Reconciliation" }).click();
      await expect(page.getByTestId("payee-identity-section")).toBeVisible();
      await expectNoOverflow(page, `identity-evidence detail ${width} (reconciliation)`);

      // 13. Zero console errors - enforced on every scenario in this file via collectBrowserErrors;
      // asserted explicitly here too, same as finance-invoices-payee-identity.spec.ts.
      expect(errors.errors).toEqual([]);
    });
  }
});
