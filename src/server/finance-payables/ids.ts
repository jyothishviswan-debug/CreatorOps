import { createHash, randomUUID } from "node:crypto";

import type { PayableCounterpartyType, PayableSourceType } from "./types";

// Step 15A: Payable identity.
//
// `payableRef` is DETERMINISTIC, not random: one canonical Payable per commercial basis
// (counterparty type + counterparty ref + commercial period). Because the ref IS the Firestore
// document id, "exactly one canonical Payable for this basis" becomes a document-existence fact -
// two concurrent first creations collapse onto the same document and the loser's tx.create fails
// (the same discipline as Partner Reviews' reviewRefFor and Agreement version doc ids). It is the
// reason a second valid source version for the same period can never silently fork the Payable.
//
// The hash inputs are opaque refs and a validated period key, so the ref reveals neither.
//
// `payableBusinessKey` is the FULL idempotency/business key of section 11 - the basis PLUS the
// exact pinned source versions. It is stored on the head and on every version: a retried create
// whose key matches returns the existing Payable unchanged, and a create whose key differs is a
// conflict pointing at the explicit revision path (never a duplicate).
//
// `pl_` line refs are ordinary random opaque handles (a breakdown line has no canonical identity).

export type PayableBasis = { counterpartyType: PayableCounterpartyType; counterpartyRef: string; commercialPeriod: string };

export type PayableBusinessKeyInput = PayableBasis & {
  sourceType: PayableSourceType;
  agreementRef: string;
  agreementVersion: number;
  reviewRef: string | null;
  reviewVersion: number | null;
};

function randomHex20(): string {
  return randomUUID().replace(/-/g, "").slice(0, 20);
}

export function payableBasisString(basis: PayableBasis): string {
  return `${basis.counterpartyType}|${basis.counterpartyRef}|${basis.commercialPeriod}`;
}

export function payableRefFor(basis: PayableBasis): string {
  return `pay_${createHash("sha256").update(payableBasisString(basis)).digest("hex").slice(0, 20)}`;
}

export function payableBusinessKey(input: PayableBusinessKeyInput): string {
  const canonical = [payableBasisString(input), input.sourceType, input.agreementRef, String(input.agreementVersion), input.reviewRef ?? "-", input.reviewVersion === null ? "-" : String(input.reviewVersion)].join("|");
  return createHash("sha256").update(canonical).digest("hex");
}

export function generatePayableLineRef(): string {
  return `pl_${randomHex20()}`;
}

// An ENGINE-derived breakdown line's ref. Deterministic in (payableRef, category, discriminator)
// so the same Agreement-derived line keeps the same ref across Payable versions and a
// version-to-version diff stays readable. Manual adjustment lines use the random ref above -
// a manual line has no derivable identity.
export function deterministicPayableLineRef(payableRef: string, category: string, discriminator: string): string {
  return `pl_${createHash("sha256").update(`${payableRef}|${category}|${discriminator}`).digest("hex").slice(0, 20)}`;
}

// "agr_...@3" / "pr_...@2": the exact pinned source version a breakdown line is derived from.
export function sourceVersionRef(ref: string, version: number): string {
  return `${ref}@${version}`;
}
