import { randomUUID } from "node:crypto";

import { financeInvoiceEventsCollection } from "./firestore";
import {
  INVOICE_COUNTERPARTY_TYPES,
  INVOICE_RECONCILIATION_STATES,
  INVOICE_STATUSES,
  INVOICE_VERSION_CHANGE_KINDS,
  invoiceEventSchema,
  type InvoiceEvent,
  type InvoiceEventKind,
} from "./types";

// Step 16A: the append-only Invoice audit trail.
//
// Metadata is passed through an EXPLICIT ALLOWLIST, identical discipline to Payables' own
// payable-events.ts: only the named keys below survive, and each only when its VALUE has the
// expected safe shape (an enum member, a small integer, an opaque ref, a boolean, a short note).
// Everything else is dropped.
//
// IMPORTANT: no AMOUNT has a key in this list. Invoice amounts are sensitive (the same
// `finance_amounts` category Payables uses), and an audit event is readable by anyone who may read
// the Invoice, so no minor-unit value, currency-qualified figure, subtotal, tax or declared total
// is representable here. Counts, states and category NAMES are; the figures live on the version
// documents behind the sensitive gate. No identity value (PAN / Aadhaar / GST / bank), contract
// text, or Partner Review / Agreement source-record identifier has a key here either.

type ValueCheck = (value: unknown) => boolean;

const isVersionNumber: ValueCheck = (value) => typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 1_000;
const isBoolean: ValueCheck = (value) => typeof value === "boolean";
const oneOf =
  (allowed: readonly string[]): ValueCheck =>
  (value) =>
    typeof value === "string" && allowed.includes(value);
const isOpaqueRef: ValueCheck = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value);
const isMimeType: ValueCheck = (value) => value === "application/pdf";

const IDENTITY_SHAPED: RegExp[] = [
  /\b[A-Z]{5}\d{4}[A-Z]\b/i, // PAN
  /\b[A-Z]{4}0[A-Z0-9]{6}\b/i, // IFSC
  /\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/i, // GSTIN
  /\b\d{4}[ -]?\d{4}[ -]?\d{4}\b/, // Aadhaar (12 digits, optionally grouped)
  /\d{9,}/, // any long digit run: account numbers, phone numbers
  /[^\s@]+@[^\s@]+\.[^\s@]+/, // email address
  /(?:₹|\brs\.?|\binr\b|\busd\b|\$)\s*\d/i, // currency-prefixed amount
  /\d[\d,.]*\s*(?:rs\b|inr\b|rupees?\b|paise\b|usd\b|lakhs?\b|crores?\b)/i, // currency-suffixed amount
];

const isSafeNote: ValueCheck = (value) => typeof value === "string" && value.trim().length > 0 && value.length <= 1000 && !IDENTITY_SHAPED.some((pattern) => pattern.test(value));

// A file name is allowed through (it is not an identity value) but is still screened by the same
// identity/amount backstop and bounded in length.
const isSafeFileName: ValueCheck = (value) => typeof value === "string" && value.trim().length > 0 && value.length <= 300 && !IDENTITY_SHAPED.some((pattern) => pattern.test(value));

export const INVOICE_EVENT_METADATA_ALLOWLIST: Readonly<Record<string, ValueCheck>> = {
  // version numbers
  version: isVersionNumber,
  previousVersion: isVersionNumber,
  newVersion: isVersionNumber,
  submittedVersion: isVersionNumber,
  approvedVersion: isVersionNumber,
  rejectedVersion: isVersionNumber,
  payableVersion: isVersionNumber,
  previousPayableVersion: isVersionNumber,
  // statuses / kinds / codes (enum members only)
  fromStatus: oneOf(INVOICE_STATUSES),
  toStatus: oneOf(INVOICE_STATUSES),
  counterpartyType: oneOf(INVOICE_COUNTERPARTY_TYPES),
  changeKind: oneOf(INVOICE_VERSION_CHANGE_KINDS),
  reconciliationState: oneOf(INVOICE_RECONCILIATION_STATES),
  // opaque refs and the currency CODE (never an amount)
  payableRef: isOpaqueRef,
  counterpartyRef: isOpaqueRef,
  agreementRef: isOpaqueRef,
  reviewRef: isOpaqueRef,
  documentId: isOpaqueRef,
  currency: (value) => typeof value === "string" && /^[A-Z]{3}$/.test(value),
  fileName: isSafeFileName,
  mimeType: isMimeType,
  // counts
  findingCount: (value) => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100,
  // flags
  documentPresent: isBoolean,
  // human text (also screened for identity/email/amount shapes)
  reason: isSafeNote,
};

// Pure. Keeps a key only when it is on the allowlist AND its value passes that key's check; returns
// null when nothing survives (or nothing was given). Never mutates its input.
export function redactInvoiceEventMetadata(metadata: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!metadata) return null;
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!Object.prototype.hasOwnProperty.call(INVOICE_EVENT_METADATA_ALLOWLIST, key)) continue;
    if (!INVOICE_EVENT_METADATA_ALLOWLIST[key]!(value)) continue;
    clean[key] = value;
  }
  return Object.keys(clean).length > 0 ? clean : null;
}

export type InvoiceEventInput = {
  invoiceRef: string;
  kind: InvoiceEventKind;
  version: number;
  actorUserRef: string;
  metadata: Record<string, unknown> | null;
  requestId: string;
  createdAt: string;
};

export function buildInvoiceEvent(input: InvoiceEventInput): InvoiceEvent {
  return invoiceEventSchema.parse({
    kind: input.kind,
    version: input.version,
    actorUserRef: input.actorUserRef,
    metadata: redactInvoiceEventMetadata(input.metadata),
    requestId: input.requestId,
    createdAt: input.createdAt,
  });
}

// Appends one event INSIDE the caller's Firestore transaction, so a mutation and its audit event
// commit atomically. tx.create with a fresh id: never rewritten, never deleted. Must be called
// after every read the transaction needs (Firestore requires all reads before writes).
export function appendInvoiceEvent(tx: FirebaseFirestore.Transaction, input: InvoiceEventInput): void {
  tx.create(financeInvoiceEventsCollection(input.invoiceRef).doc(randomUUID()), buildInvoiceEvent(input));
}
