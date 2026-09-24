import { randomUUID } from "node:crypto";

import { approveInvoice, createInvoiceDraft, reviseInvoiceDraft, submitInvoice, attachInvoiceDocument, type InvoiceDetailDto } from "@/server/finance-invoices";
import { createInvoiceFixtures, emailFor, PASSWORD, VIEWPORTS, type InvoiceFixtures, type RoleName } from "./finance-invoices-fixtures";
import { signInAs } from "./finance-payables-fixtures";

const MINIMAL_PDF = Buffer.from("%PDF-1.4\n%%EOF");

// Step 17B e2e fixtures for the Finance Payments UI. Built on TOP of createInvoiceFixtures (Step
// 16B's own Invoice fixture factory): a READY_FOR_INVOICE Payable is seeded exactly the way
// Invoices' own e2e suite does, then moved all the way to APPROVED through the TRUSTED Invoices
// service directly (never through the Invoices UI) - Payments only ever needs an already-approved
// Invoice ref, one private region per spec tag, everything removed in cleanupAll() (voiding the
// underlying Payable; there is no delete anywhere in this chain).
export { emailFor, PASSWORD, VIEWPORTS, signInAs };
export type { RoleName };

export function createPaymentsFixtures(tag: string) {
  const invoices: InvoiceFixtures = createInvoiceFixtures(tag);
  let counter = 0;

  // A fresh APPROVED Vendor Invoice: a DETERMINISTIC Payable (one BASE_FIXED line) taken all the way
  // through Draft -> declared fields -> document -> Submit -> Approve, so its
  // expectedNetPaymentMinor is unambiguous and Payments' own eligible-Invoices read (APPROVED,
  // outstanding balance) always finds it.
  async function seedApprovedInvoice(displayName: string, as: RoleName = "head"): Promise<{ invoiceRef: string; declaredTotalMinor: number }> {
    const actor = await invoices.payables.finance.actorOf(as);
    const basis = await invoices.seedReadyVendorPayable(displayName, as === "head" ? "manager" : as);
    const declaredTotalMinor = Math.abs(basis.expectedTotalMinorSigned);

    const created = await createInvoiceDraft(actor, { payableRef: basis.payableRef }, randomUUID());
    if (!created.ok) throw new Error(`createInvoiceDraft failed: ${created.code} ${created.message}`);
    let invoice: InvoiceDetailDto = created.data.invoice;

    const revised = await reviseInvoiceDraft(
      actor,
      {
        invoiceRef: invoice.head.invoiceRef,
        expectedDocVersion: invoice.head.docVersion,
        externalInvoiceNumber: `INV-${tag}-${(counter += 1)}`,
        invoiceDate: "2026-03-02",
        currency: "INR",
        declaredTotalMinor,
        reason: "Filling in declared invoice fields for the e2e fixture.",
      },
      randomUUID(),
    );
    if (!revised.ok) throw new Error(`reviseInvoiceDraft failed: ${revised.code} ${revised.message}`);
    invoice = revised.data;

    const withDoc = await attachInvoiceDocument(actor, { invoiceRef: invoice.head.invoiceRef, expectedDocVersion: invoice.head.docVersion, fileName: "invoice.pdf", contentBase64: MINIMAL_PDF.toString("base64") }, randomUUID());
    if (!withDoc.ok) throw new Error(`attachInvoiceDocument failed: ${withDoc.code} ${withDoc.message}`);
    invoice = withDoc.data;

    const submitted = await submitInvoice(actor, { invoiceRef: invoice.head.invoiceRef, expectedDocVersion: invoice.head.docVersion }, randomUUID());
    if (!submitted.ok) throw new Error(`submitInvoice failed: ${submitted.code} ${submitted.message}`);
    invoice = submitted.data;

    const headActor = await invoices.payables.finance.actorOf("head");
    const approved = await approveInvoice(headActor, { invoiceRef: invoice.head.invoiceRef, expectedDocVersion: invoice.head.docVersion }, randomUUID());
    if (!approved.ok) throw new Error(`approveInvoice failed: ${approved.code} ${approved.message}`);
    invoice = approved.data;

    return { invoiceRef: invoice.head.invoiceRef, declaredTotalMinor };
  }

  async function cleanupAll() {
    await invoices.cleanupAll();
  }

  return { invoices, seedApprovedInvoice, actorOf: invoices.payables.finance.actorOf, cleanupAll };
}

export type PaymentsFixtures = ReturnType<typeof createPaymentsFixtures>;
