import type { ActorContext } from "@/server/authz/types";
import { getPayable, type PayableDetailDto } from "@/server/finance-payables";

import type { InvoicePayablePin } from "./types";

// Step 16A: how an Invoice is pinned to the exact Payable evidence that justifies it (sections 4, 7
// and 15).
//
// DEPENDENCY DIRECTION, deliberately one-way: an Invoice READS a Payable, never the other way
// round. The read goes through Payables' own PUBLISHED, read-only contract (getPayable) - never
// through its Firestore internals - which applies the `finance` feature gate and the LIVE
// Partner/Vendor Record Scope of the Payable's own counterparty. Building an Invoice from a Payable
// therefore requires being allowed to read that Payable.
//
// WHAT IS PINNED (section 4): payableRef, the EXACT payable version (never "the latest" - the one
// version READY_FOR_INVOICE named), counterpartyType/Ref, agreementRef/Version, the Review ref/
// version when the Payable carries one, and the commercial period - all copied VERBATIM from the
// Payable at the moment of creation/refresh. The browser never supplies any of these; only
// `payableRef` is ever client-named (types.ts's createInvoiceDraftInputSchema).
//
// A Payable is eligible to found an Invoice only while READY_FOR_INVOICE (section 7) - a DRAFT
// Payable has no pinned amount to invoice against yet, and a VOID Payable is retired history. Since
// moving a Payable to READY_FOR_INVOICE always pins `readyVersion === latestVersion` (any revision
// immediately returns it to DRAFT - see payable-lifecycle-service.ts), the ready version IS the
// Payable's current default (latest) version; there is never an ambiguity about which one to pin.

export type InvoicePayableBlockedCode = "PAYABLE_NOT_FOUND" | "PAYABLE_NOT_READY" | "PAYABLE_AMOUNTS_UNAVAILABLE";

export type InvoicePayableBlocker = { code: InvoicePayableBlockedCode; message: string };

export type ResolvedInvoicePayableSource = {
  pin: InvoicePayablePin;
  counterpartyDisplayName: string;
  payableStatus: PayableDetailDto["head"]["status"];
};

export type ResolveInvoicePayableOutcome = { ok: true; resolved: ResolvedInvoicePayableSource } | { ok: false; blockers: InvoicePayableBlocker[] };

const blocked = (code: InvoicePayableBlockedCode, message: string): ResolveInvoicePayableOutcome => ({ ok: false, blockers: [{ code, message }] });

// Resolves and pins the READY_FOR_INVOICE Payable's evidence. Rejects a DRAFT/VOID Payable, a
// missing/out-of-scope Payable (the same neutral phrasing Payables itself uses), and the case where
// the calling actor cannot see the Payable's amounts (an Invoice cannot be built without knowing
// what it reconciles against).
export async function resolveInvoicePayableSource(actor: ActorContext, payableRef: string, now: () => Date = () => new Date()): Promise<ResolveInvoicePayableOutcome> {
  const result = await getPayable(actor, payableRef);
  if (!result.ok) return blocked("PAYABLE_NOT_FOUND", "That payable could not be found, or is not in your scope.");
  const payable = result.data;

  if (payable.head.status !== "READY_FOR_INVOICE" || payable.head.readyVersion === null) {
    return blocked("PAYABLE_NOT_READY", "This payable is not READY_FOR_INVOICE yet. Move it to ready before creating an Invoice from it.");
  }
  const version = payable.selectedVersion;
  if (!version || version.version !== payable.head.readyVersion) return blocked("PAYABLE_NOT_READY", "The payable's ready version could not be read.");
  if (!payable.amountsVisible || version.totalAmountMinorSigned === null) {
    return blocked("PAYABLE_AMOUNTS_UNAVAILABLE", "You do not hold Finance amounts access, so this payable's amount cannot be pinned to an Invoice.");
  }

  return {
    ok: true,
    resolved: {
      counterpartyDisplayName: payable.head.counterparty.displayName ?? payable.head.counterparty.ref,
      payableStatus: payable.head.status,
      pin: {
        payableRef: payable.head.payableRef,
        payableVersion: payable.head.readyVersion,
        counterpartyType: payable.head.counterparty.type,
        counterpartyRef: payable.head.counterparty.ref,
        agreementRef: payable.head.agreementRef,
        agreementVersion: payable.head.agreementVersion,
        reviewRef: payable.head.reviewRef,
        reviewVersion: payable.head.reviewVersion,
        commercialPeriod: payable.head.commercialPeriod,
        payableCurrency: payable.head.currency,
        // Step 15C: the full payout sum stays as read-only context; every reconciliation-relevant
        // figure is one of the five distinct tax/proration totals, copied verbatim.
        payableTotalAmountMinorSigned: version.totalAmountMinorSigned,
        payableServiceBaseMinor: version.serviceBaseMinor,
        payableGstMinor: version.gstMinor ?? 0,
        payableGrossInvoiceExpectedMinor: version.grossInvoiceExpectedMinor,
        payableTdsMinor: version.tdsMinor ?? 0,
        payableExpectedNetPaymentMinor: version.expectedNetPaymentMinor,
        payableCalculationRuleVersion: version.calculationRuleVersion,
        pinnedAt: now().toISOString(),
      },
    },
  };
}
