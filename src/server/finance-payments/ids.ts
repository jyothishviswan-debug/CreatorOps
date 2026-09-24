import { createHash, randomUUID } from "node:crypto";

import type { PaymentMethod } from "./types";

// Step 17A: Payment identity.
//
// Unlike a Payable (one canonical record per commercial basis) or an Invoice (one canonical record
// per Payable), a Payment is deliberately NOT deterministic: section 4 explicitly requires
// "one approved Invoice -> one OR MORE Payment records" (partial payments, split transfers,
// retries, corrections). `paymentRef` is therefore a random opaque handle, exactly like a Payable
// breakdown line's `pl_` ref.
//
// `normalizedExternalReferenceKey` / `paymentReferenceClaimId` implement section 10's duplicate
// protection: two DIFFERENT Payment heads may never claim the same (method, external reference)
// pair. Normalization strips incidental formatting (case, surrounding whitespace, internal
// whitespace/hyphens) so "UTR 123-456" and "utr123456" collide exactly when a human would expect
// them to.

function randomHex20(): string {
  return randomUUID().replace(/-/g, "").slice(0, 20);
}

export function generatePaymentRef(): string {
  return `pmt_${randomHex20()}`;
}

// Strips case, surrounding whitespace and internal whitespace/hyphens/underscores. Returns null for
// an empty/whitespace-only input - callers must treat that as "no reference", never as a
// normalizable value.
export function normalizeExternalReference(raw: string): string | null {
  const stripped = raw.trim().toUpperCase().replace(/[\s\-_]+/g, "");
  return stripped.length > 0 ? stripped : null;
}

export function paymentReferenceClaimId(method: PaymentMethod, normalizedReferenceKey: string): string {
  return createHash("sha256").update(`${method}|${normalizedReferenceKey}`).digest("hex").slice(0, 40);
}
