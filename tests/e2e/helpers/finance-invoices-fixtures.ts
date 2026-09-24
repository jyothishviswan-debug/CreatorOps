import { randomUUID } from "node:crypto";

import { createPayable, getPayable, markPayableReadyForInvoice } from "@/server/finance-payables";
import type { PayableCounterpartyType } from "@/server/finance-payables/types";
import { restrictedFinancialIdentitiesCollection, restrictedFinancialIdentityDocSchema, restrictedIdentityDocId } from "@/server/shared/restricted-financial-identity";
import { getVendorDocByRef } from "@/server/vendors/firestore";

import { createPayablesFixtures, emailFor, PASSWORD, VIEWPORTS, type PayablesFixtures, type RoleName } from "./finance-payables-fixtures";

// Step 16B e2e fixtures for the Finance Invoices UI. Built on TOP of createPayablesFixtures (Step
// 15B's own Payables fixture factory): a Payable basis is seeded exactly the way Payables' own e2e
// suite does, then moved to READY_FOR_INVOICE through the TRUSTED Payables service directly (never
// through the UI) - Invoices only ever needs an already-eligible Payable ref, one private region
// per spec tag, everything removed in cleanupAll() (voiding the Payable; there is no delete).
export { emailFor, PASSWORD, VIEWPORTS };
export type { RoleName };

// Step 16D e2e: the CANONICAL restricted GST/bank/address values seeded onto a fixture Vendor -
// synthetic, invented values (never a real GST/bank number), mirroring the SAME `Acme Studios`-style
// values used in restricted-extraction.test.ts / matcher-integration.test.ts so a Playwright scenario
// can stage a PDF containing the exact matching (or deliberately mismatching) text.
export const CANONICAL_IDENTITY = {
  gst: "29ABCDE1234F1Z5",
  gstMismatch: "27ZZZZZ9999Z1Z1",
  bankAccountNumber: "000123456789",
  bankAccountMismatch: "000999999999",
  address: "12 MG Road, Bengaluru, Karnataka 560001",
};

export function createInvoiceFixtures(tag: string) {
  const payables: PayablesFixtures = createPayablesFixtures(tag);
  const restrictedIdentityCleanup: FirebaseFirestore.DocumentReference[] = [];

  // A READY_FOR_INVOICE Vendor Payable basis: DETERMINISTIC (one BASE_FIXED line, nothing to
  // review) so the eligible-Payables list and the pinned expected total are unambiguous.
  async function seedReadyVendorPayable(displayName: string, as: RoleName = "manager"): Promise<{ payableRef: string; commercialPeriod: string; expectedTotalMinorSigned: number }> {
    const basis = await payables.seedDeterministicVendorBasis(displayName);
    return finishReady(basis, as);
  }

  // Step 16D: the same READY_FOR_INVOICE Vendor Payable basis, but the Vendor ALSO has canonical
  // restricted identity (GST applicable/number, bank account, registered address - see
  // CANONICAL_IDENTITY above) on file, written directly into the shared restrictedFinancialIdentities
  // collection - the SAME trusted-test-setup pattern finance-agreements-fixtures.ts's own seedKyc
  // already uses (a direct Firestore write in TEST fixture code, never through the app's own
  // service/UI, and never a pattern this module's app code itself uses - see
  // finance-invoices-static.test.ts's "no Payables/Agreements/Partners/Vendors collection is ever
  // written directly" guard, which only scans src/server/finance-invoices/**, not test fixtures).
  async function seedReadyVendorPayableWithIdentity(
    displayName: string,
    identity: { gst?: string | null; bankAccountNumber?: string | null; address?: string | null },
    as: RoleName = "manager",
  ): Promise<{ payableRef: string; commercialPeriod: string; expectedTotalMinorSigned: number; vendorRef: string }> {
    const basis = await payables.seedDeterministicVendorBasis(displayName);
    const vendor = await getVendorDocByRef(basis.counterpartyRef);
    if (!vendor) throw new Error(`Vendor not found for ${basis.counterpartyRef} right after seeding.`);

    const stamp = new Date().toISOString();
    const doc = restrictedFinancialIdentityDocSchema.parse({
      uid: restrictedIdentityDocId("VENDOR", vendor.uid),
      subjectType: "VENDOR",
      subjectRef: vendor.vendorRef,
      version: 1,
      pan: null,
      aadhaar: null,
      gst: identity.gst ? { applicable: true, number: identity.gst } : null,
      bank: identity.bankAccountNumber ? { accountHolderName: displayName, accountNumber: identity.bankAccountNumber, ifsc: "TEST0009999", bankName: "Test Bank", branchName: "Test Branch" } : null,
      address: identity.address ?? null,
      evidence: [],
      updatedAt: stamp,
      updatedByUserRef: "e2e",
    });
    const ref = restrictedFinancialIdentitiesCollection().doc(doc.uid);
    await ref.set(doc);
    restrictedIdentityCleanup.push(ref);

    const ready = await finishReady(basis, as);
    return { ...ready, vendorRef: vendor.vendorRef };
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
    await Promise.all(restrictedIdentityCleanup.splice(0).map((ref) => ref.delete()));
    await payables.cleanupAll();
  }

  return { payables, seedReadyVendorPayable, seedReadyVendorPayableWithIdentity, cleanupAll };
}

export type InvoiceFixtures = ReturnType<typeof createInvoiceFixtures>;
