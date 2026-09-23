import { randomUUID } from "node:crypto";

import { createPayable, getPayable, markPayableReadyForInvoice } from "@/server/finance-payables";
import type { PayableCounterpartyType } from "@/server/finance-payables/types";

import { createPayablesFixtures, emailFor, PASSWORD, VIEWPORTS, type PayablesFixtures, type RoleName } from "./finance-payables-fixtures";

// Step 16B e2e fixtures for the Finance Invoices UI. Built on TOP of createPayablesFixtures (Step
// 15B's own Payables fixture factory): a Payable basis is seeded exactly the way Payables' own e2e
// suite does, then moved to READY_FOR_INVOICE through the TRUSTED Payables service directly (never
// through the UI) - Invoices only ever needs an already-eligible Payable ref, one private region
// per spec tag, everything removed in cleanupAll() (voiding the Payable; there is no delete).
export { emailFor, PASSWORD, VIEWPORTS };
export type { RoleName };

export function createInvoiceFixtures(tag: string) {
  const payables: PayablesFixtures = createPayablesFixtures(tag);

  // A READY_FOR_INVOICE Vendor Payable basis: DETERMINISTIC (one BASE_FIXED line, nothing to
  // review) so the eligible-Payables list and the pinned expected total are unambiguous.
  async function seedReadyVendorPayable(displayName: string, as: RoleName = "manager"): Promise<{ payableRef: string; commercialPeriod: string; expectedTotalMinorSigned: number }> {
    const basis = await payables.seedDeterministicVendorBasis(displayName);
    return finishReady(basis, as);
  }

  // Pins a seeded Payable basis READY_FOR_INVOICE, mirroring Payables' own e2e "mark ready" path
  // exactly, but through the trusted service directly rather than the Payables UI.
  async function finishReady(
    basis: { counterpartyType: PayableCounterpartyType; counterpartyRef: string; displayName: string; commercialPeriod: string; agreementRef: string },
    as: RoleName,
  ): Promise<{ payableRef: string; commercialPeriod: string; expectedTotalMinorSigned: number }> {
    const actor = await payables.finance.actorOf(as);
    const created = await createPayable(actor, { counterpartyType: basis.counterpartyType, counterpartyRef: basis.counterpartyRef, commercialPeriod: basis.commercialPeriod, agreementRef: basis.agreementRef }, randomUUID());
    if (!created.ok) throw new Error(`createPayable failed: ${created.code} ${created.message}`);
    const payableRef = created.data.payable.head.payableRef;

    const readyActor = await payables.finance.actorOf("head");
    const ready = await markPayableReadyForInvoice(readyActor, { payableRef, expectedDocVersion: created.data.payable.head.docVersion }, randomUUID());
    if (!ready.ok) throw new Error(`markPayableReadyForInvoice failed: ${ready.code} ${ready.message}`);

    const reloaded = await getPayable(readyActor, payableRef);
    if (!reloaded.ok) throw new Error(`getPayable failed after marking ready: ${reloaded.code}`);
    const total = reloaded.data.selectedVersion?.totalAmountMinorSigned ?? null;
    if (total === null) throw new Error("Expected a resolved total on the READY_FOR_INVOICE Payable.");

    return { payableRef, commercialPeriod: basis.commercialPeriod, expectedTotalMinorSigned: total };
  }

  async function cleanupAll() {
    await payables.cleanupAll();
  }

  return { payables, seedReadyVendorPayable, cleanupAll };
}

export type InvoiceFixtures = ReturnType<typeof createInvoiceFixtures>;
