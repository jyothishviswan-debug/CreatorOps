import type { ActorContext } from "@/server/authz/types";
import { getInvoice, type InvoiceDetailDto } from "@/server/finance-invoices";

import type { PaymentInvoicePin, PaymentPayeeIdentitySnapshot } from "./types";

// Step 17A: how a Payment is pinned to the exact approved-Invoice evidence that justifies it
// (sections 2, 3, 12, 14). Mirrors src/server/finance-invoices/payable-source.ts's own
// resolveInvoicePayableSource exactly.
//
// DEPENDENCY DIRECTION, deliberately one-way: a Payment READS an Invoice, never the other way
// round. The read goes through Invoices' own PUBLISHED, read-only contract (getInvoice) - never
// through its Firestore internals - which applies the `finance` feature gate and the LIVE
// Partner/Vendor Record Scope of the Invoice's own counterparty. Building a Payment from an Invoice
// therefore requires being allowed to read that Invoice.
//
// ELIGIBILITY (section 2): only an APPROVED Invoice can found a Payment - DRAFT/SUBMITTED/
// REJECTED/VOID are all blocked.
//
// WHAT IS PINNED (section 3/12): invoiceRef, the EXACT approved Invoice version (never "the
// latest" - though for an APPROVED invoice they are, by construction, the same version, since
// nothing mutates an Invoice once approved), the Invoice's own pinned payableRef/payableVersion,
// counterpartyType/Ref, commercial period, currency, expectedNetPaymentMinor (payableGrossInvoice-
// ExpectedMinor minus TDS - the Invoice's own already-computed figure, NEVER recomputed here), and
// a safe, already-masked payee-identity snapshot (never a raw restricted value, never re-matched).

export type PaymentInvoiceBlockedCode = "INVOICE_NOT_FOUND" | "INVOICE_NOT_APPROVED" | "INVOICE_AMOUNTS_UNAVAILABLE" | "INVOICE_MISSING_EXPECTED_NET_PAYMENT" | "INVOICE_MISSING_CURRENCY";

export type PaymentInvoiceBlocker = { code: PaymentInvoiceBlockedCode; message: string };

export type ResolvedPaymentInvoiceSource = {
  pin: PaymentInvoicePin;
  payeeIdentity: PaymentPayeeIdentitySnapshot;
  counterpartyDisplayName: string;
  invoiceStatus: InvoiceDetailDto["head"]["status"];
};

export type ResolvePaymentInvoiceOutcome = { ok: true; resolved: ResolvedPaymentInvoiceSource } | { ok: false; blockers: PaymentInvoiceBlocker[] };

const blocked = (code: PaymentInvoiceBlockedCode, message: string): ResolvePaymentInvoiceOutcome => ({ ok: false, blockers: [{ code, message }] });

export async function resolvePaymentInvoiceSource(actor: ActorContext, invoiceRef: string, now: () => Date = () => new Date()): Promise<ResolvePaymentInvoiceOutcome> {
  const result = await getInvoice(actor, invoiceRef);
  if (!result.ok) return blocked("INVOICE_NOT_FOUND", "That invoice could not be found, or is not in your scope.");
  const invoice = result.data;

  if (invoice.head.status !== "APPROVED" || invoice.head.approvedVersion === null) {
    return blocked("INVOICE_NOT_APPROVED", "This invoice is not APPROVED. A payment can only be created against an approved invoice.");
  }
  const version = invoice.selectedVersion;
  if (!version || version.version !== invoice.head.approvedVersion) {
    return blocked("INVOICE_NOT_APPROVED", "The invoice's approved version could not be read.");
  }
  if (!invoice.amountsVisible) {
    return blocked("INVOICE_AMOUNTS_UNAVAILABLE", "You do not hold Finance amounts access, so this invoice's expected net payment cannot be pinned to a Payment.");
  }
  if (version.payablePin.payableExpectedNetPaymentMinor === null) {
    return blocked("INVOICE_MISSING_EXPECTED_NET_PAYMENT", "This invoice's pinned payable has no computed expected net payment yet.");
  }
  if (version.currency === null) {
    return blocked("INVOICE_MISSING_CURRENCY", "This invoice has no declared currency.");
  }

  const bankField = version.payeeIdentity?.fields.find((field) => field.field === "BANK") ?? null;

  return {
    ok: true,
    resolved: {
      counterpartyDisplayName: invoice.head.counterparty.displayName ?? invoice.head.counterparty.ref,
      invoiceStatus: invoice.head.status,
      pin: {
        invoiceRef: invoice.head.invoiceRef,
        invoiceVersion: invoice.head.approvedVersion,
        payableRef: version.payablePin.payableRef,
        payableVersion: version.payablePin.payableVersion,
        counterpartyType: invoice.head.counterparty.type,
        counterpartyRef: invoice.head.counterparty.ref,
        commercialPeriod: invoice.head.commercialPeriod,
        currency: version.currency,
        expectedNetPaymentMinor: version.payablePin.payableExpectedNetPaymentMinor,
        pinnedAt: now().toISOString(),
      },
      payeeIdentity: {
        overallStatusAtApproval: version.payeeIdentity?.overallStatus ?? null,
        bankSafeDisplay: bankField?.safeExpectedDisplay ?? bankField?.safeExtractedDisplay ?? null,
        resolution: version.payeeIdentity?.accepted ? { reason: version.payeeIdentity.accepted.reason, actorUserRef: version.payeeIdentity.accepted.actorUserRef, at: version.payeeIdentity.accepted.at } : null,
        comparedAt: version.payeeIdentity?.comparedAt ?? null,
      },
    },
  };
}

// --- Source-revision warning (read-only, section 14) -------------------------------------------------------------------------
// Compares the payment's PINNED Invoice version against the Invoice's CURRENT approved/latest
// version. Never writes, never recalculates, never re-pins - mirrors
// finance-invoices/source-revision.ts's own compareInvoicePayableRevision exactly, one level up
// the chain.
export type PaymentSourceRevisionComparison = { state: "CURRENT" | "INVOICE_REVISION_AVAILABLE" };

export function comparePaymentInvoiceRevision(pinned: { invoiceVersion: number }, current: { latestVersion: number; status: string } | null): PaymentSourceRevisionComparison {
  if (current === null) return { state: "CURRENT" };
  if (current.latestVersion > pinned.invoiceVersion) return { state: "INVOICE_REVISION_AVAILABLE" };
  return { state: "CURRENT" };
}
