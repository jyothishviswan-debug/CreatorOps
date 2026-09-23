import type { InvoiceSourceCurrencyState } from "./types";

// Step 16A section 15: SOURCE-REVISION DETECTION.
//
// A WARNING ONLY. Comparing an Invoice's pinned Payable version against the Payable's current
// latest version never mutates the Invoice and never re-pins anything. Approval uses the explicitly
// pinned Payable version unless a human explicitly revises the Invoice to re-resolve it. Mirrors
// Payables' own source-revision.ts exactly, simplified to the ONE pinned reference Invoices carry
// (a Payable version number) rather than Payables' own two (Agreement + Review).
//
// This module is PURE so the comparison itself is unit-testable without Firestore; the service
// supplies "what the Payable's current version is" by re-reading the Payable's own published
// contract.

export type PinnedPayableVersion = { payableVersion: number };
export type CurrentPayableVersion = { latestVersion: number; status: string } | null;

export type InvoiceSourceRevisionComparison = { state: InvoiceSourceCurrencyState; payableRevisionAvailable: boolean };

// When `current` is null the Payable cannot be resolved at all right now (it vanished from scope,
// or was voided in a way that hides it). That is NOT a revision to offer - the state stays CURRENT
// and the caller explains the situation in its own message, exactly like Payables' own
// compareSourceVersions.
export function compareInvoicePayableRevision(pinned: PinnedPayableVersion, current: CurrentPayableVersion): InvoiceSourceRevisionComparison {
  if (!current) return { state: "CURRENT", payableRevisionAvailable: false };
  const payableRevisionAvailable = current.latestVersion !== pinned.payableVersion;
  return { state: payableRevisionAvailable ? "PAYABLE_REVISION_AVAILABLE" : "CURRENT", payableRevisionAvailable };
}

export const INVOICE_SOURCE_REVISION_MESSAGES: Record<InvoiceSourceCurrencyState, string> = {
  CURRENT: "This Invoice is based on the Payable version it was built from, and that is still the Payable's current version.",
  PAYABLE_REVISION_AVAILABLE:
    "A newer Payable version now exists. This Invoice still uses the version it was built from; create a revised Invoice version to re-pin the newer one if the newer figures should be invoiced instead.",
};
