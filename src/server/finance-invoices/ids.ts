import { createHash } from "node:crypto";

import type { InvoiceCounterpartyType } from "./types";

// Step 16A: Invoice identity.
//
// `invoiceRef` is DETERMINISTIC, not random - one canonical Invoice head per Payable, exactly the
// same discipline as Payables' own `payableRef` (section 4's scope decision: "one Payable -> one
// canonical Invoice head"). Because the ref IS the Firestore document id, "at most one Invoice head
// for this Payable" becomes a document-existence fact: two concurrent first creations for the same
// Payable collapse onto the same document and the loser's tx.create fails.
//
// `invoiceNumberClaimId` is the section 6 duplicate-protection key: one claim per (counterparty,
// NORMALIZED supplier invoice number). It is deliberately INDEPENDENT of the invoiceRef above - two
// different Payables (and so two different invoiceRefs) could otherwise be invoiced under the same
// supplier invoice number by mistake, which the claim catches; a revision under the SAME head
// reusing or changing its own number is never a duplicate of itself (the claim already names that
// head - see invoice-service.ts's claim/release logic).
//
// `normalizeInvoiceNumber` is whitespace/case canonicalization ONLY - trim, collapse internal
// whitespace, uppercase. Never fuzzy: "INV-001" and "INV 001" are treated as different numbers.

export function invoiceRefFor(payableRef: string): string {
  return `inv_${createHash("sha256").update(payableRef).digest("hex").slice(0, 20)}`;
}

export function normalizeInvoiceNumber(raw: string): string {
  return raw.trim().replace(/\s+/g, " ").toUpperCase();
}

export function invoiceNumberClaimId(counterpartyType: InvoiceCounterpartyType, counterpartyRef: string, normalizedInvoiceNumber: string): string {
  return createHash("sha256").update(`${counterpartyType}|${counterpartyRef}|${normalizedInvoiceNumber}`).digest("hex");
}

// sha256(invoiceRef|version|artifactSha256) - the document-storage idempotency key (mirrors
// Agreements' own agreementDocumentIdempotencyKey).
export function invoiceDocumentIdempotencyKey(invoiceRef: string, version: number, artifactSha256: string): string {
  return createHash("sha256").update(`${invoiceRef}|${version}|${artifactSha256}`).digest("hex");
}
