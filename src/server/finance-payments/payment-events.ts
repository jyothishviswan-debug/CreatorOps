import { randomUUID } from "node:crypto";

import { financePaymentEventsCollection } from "./firestore";
import { PAYMENT_METHODS, PAYMENT_SETTLEMENT_STATES, PAYMENT_STATUSES, PAYMENT_VERSION_CHANGE_KINDS, paymentEventSchema, type PaymentEvent, type PaymentEventKind } from "./types";

// Step 17A: the append-only Payment audit trail. Mirrors src/server/finance-payables/payable-events.ts
// and src/server/finance-invoices/invoice-events.ts exactly: metadata is passed through an EXPLICIT
// ALLOWLIST - only the named keys below survive, and each only when its VALUE has the expected safe
// shape (an enum member, a small integer, an opaque ref, a boolean, a short note). Everything else
// is dropped.
//
// IMPORTANT: no raw money AMOUNT has a key in this list. A Payment's amount is sensitive
// (`finance_amounts`), and an audit event is readable by anyone who may read the Payment, so no
// minor-unit value is representable here. No identity value (PAN/Aadhaar/GST/bank), no raw bank
// account data, and no external-reference raw string is representable either - only its already-
// masked shape would ever be safe, and this module deliberately does not build one (the reference
// itself is not restricted-identity-grade, but it is also not audit-log-needed; the claim
// document, not the event trail, is the system of record for duplicate protection).

type ValueCheck = (value: unknown) => boolean;

const isVersionNumber: ValueCheck = (value) => typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 1_000;
const oneOf =
  (allowed: readonly string[]): ValueCheck =>
  (value) =>
    typeof value === "string" && allowed.includes(value);
const isOpaqueRef: ValueCheck = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value);

const IDENTITY_SHAPED: RegExp[] = [
  /\b[A-Z]{5}\d{4}[A-Z]\b/i, // PAN
  /\b[A-Z]{4}0[A-Z0-9]{6}\b/i, // IFSC
  /\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/i, // GSTIN
  /\b\d{4}[ -]?\d{4}[ -]?\d{4}\b/, // Aadhaar
  /\d{9,}/, // any long digit run: account numbers, phone numbers, UTRs
  /[^\s@]+@[^\s@]+\.[^\s@]+/, // email address
  /(?:₹|\brs\.?|\binr\b|\busd\b|\$)\s*\d/i, // currency-prefixed amount
  /\d[\d,.]*\s*(?:rs\b|inr\b|rupees?\b|paise\b|usd\b|lakhs?\b|crores?\b)/i, // currency-suffixed amount
];
const isSafeNote: ValueCheck = (value) => typeof value === "string" && value.trim().length > 0 && value.length <= 1000 && !IDENTITY_SHAPED.some((pattern) => pattern.test(value));

export const PAYMENT_EVENT_METADATA_ALLOWLIST: Readonly<Record<string, ValueCheck>> = {
  version: isVersionNumber,
  previousVersion: isVersionNumber,
  newVersion: isVersionNumber,
  fromStatus: oneOf(PAYMENT_STATUSES),
  toStatus: oneOf(PAYMENT_STATUSES),
  changeKind: oneOf(PAYMENT_VERSION_CHANGE_KINDS),
  method: oneOf(PAYMENT_METHODS),
  settlementState: oneOf(PAYMENT_SETTLEMENT_STATES),
  invoiceRef: isOpaqueRef,
  invoiceVersion: isVersionNumber,
  payableRef: isOpaqueRef,
  payableVersion: isVersionNumber,
  counterpartyRef: isOpaqueRef,
  hasExternalReference: (value) => typeof value === "boolean",
  reason: isSafeNote,
};

// Pure. Keeps a key only when it is on the allowlist AND its value passes that key's check;
// returns null when nothing survives. Never mutates its input.
export function redactPaymentEventMetadata(metadata: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!metadata) return null;
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!Object.prototype.hasOwnProperty.call(PAYMENT_EVENT_METADATA_ALLOWLIST, key)) continue;
    if (!PAYMENT_EVENT_METADATA_ALLOWLIST[key]!(value)) continue;
    clean[key] = value;
  }
  return Object.keys(clean).length > 0 ? clean : null;
}

export type PaymentEventInput = {
  paymentRef: string;
  kind: PaymentEventKind;
  version: number;
  actorUserRef: string;
  metadata: Record<string, unknown> | null;
  requestId: string;
  createdAt: string;
};

export function buildPaymentEvent(input: PaymentEventInput): PaymentEvent {
  return paymentEventSchema.parse({
    kind: input.kind,
    version: input.version,
    actorUserRef: input.actorUserRef,
    metadata: redactPaymentEventMetadata(input.metadata),
    requestId: input.requestId,
    createdAt: input.createdAt,
  });
}

// Appends one event INSIDE the caller's Firestore transaction, so a mutation and its audit event
// commit atomically. tx.create with a fresh id: never rewritten, never deleted.
export function appendPaymentEvent(tx: FirebaseFirestore.Transaction, input: PaymentEventInput): void {
  tx.create(financePaymentEventsCollection(input.paymentRef).doc(randomUUID()), buildPaymentEvent(input));
}
