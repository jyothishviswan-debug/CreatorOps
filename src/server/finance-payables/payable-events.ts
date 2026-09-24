import { randomUUID } from "node:crypto";

import { financePayableEventsCollection } from "./firestore";
import {
  PAYABLE_BLOCKED_CODES,
  PAYABLE_COUNTERPARTY_TYPES,
  PAYABLE_DETERMINATION_STATES,
  PAYABLE_LINE_CATEGORIES,
  PAYABLE_REVIEW_CODES,
  PAYABLE_SOURCE_CURRENCY_STATES,
  PAYABLE_SOURCE_TYPES,
  PAYABLE_STATUSES,
  PAYABLE_VERSION_CHANGE_KINDS,
  payableEventSchema,
  type PayableEvent,
  type PayableEventKind,
} from "./types";

// Step 15A: the append-only Payable audit trail.
//
// Metadata is passed through an EXPLICIT ALLOWLIST, the same discipline as the Agreement audit
// trail (agreement-events.ts): only the named keys below survive, and each only when its VALUE
// has the expected safe shape (an enum member, a small integer, an opaque ref, a boolean, a short
// note). Everything else is dropped - there is no "block these substrings" list, so a new or
// misspelled key can never leak a value by accident.
//
// IMPORTANT: no AMOUNT has a key in this list. Payable amounts are sensitive (the
// `finance_amounts` category), and an audit event is readable by anyone who may read the Payable,
// so no minor-unit value, currency-qualified figure, total or line amount is representable here.
// Counts and category NAMES are; the figures live on the version documents behind the sensitive
// gate. No identity value (PAN / Aadhaar / GST / bank), contract text, or Partner Review source
// record identifier has a key here either.
//
// Free-text keys (`reason`, `label`) hold what a human typed. They are additionally refused when
// they LOOK like an identity value, an email or an amount - a defense-in-depth backstop, not the
// primary control (the allowlist is).

type ValueCheck = (value: unknown) => boolean;

const isCount: ValueCheck = (value) => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100_000;
const isVersionNumber: ValueCheck = (value) => typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 1_000;
const isBoolean: ValueCheck = (value) => typeof value === "boolean";
// A tax RATE in basis points (0-10000 = 0%-100%) - a percentage, never a money amount, so it is
// safe under this file's own "no amount has a key here" rule.
const isBpsRate: ValueCheck = (value) => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 10_000;
const isNullableBpsRate: ValueCheck = (value) => value === null || isBpsRate(value);
const oneOf =
  (allowed: readonly string[]): ValueCheck =>
  (value) =>
    typeof value === "string" && allowed.includes(value);
const isOpaqueRef: ValueCheck = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value);
const isPeriodKey: ValueCheck = (value) => typeof value === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
const isCurrencyCode: ValueCheck = (value) => typeof value === "string" && /^[A-Z]{3}$/.test(value);

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

const isReviewCodeList: ValueCheck = (value) =>
  Array.isArray(value) && value.length <= PAYABLE_REVIEW_CODES.length && new Set(value).size === value.length && value.every((item) => typeof item === "string" && (PAYABLE_REVIEW_CODES as readonly string[]).includes(item));

const isBlockedCodeList: ValueCheck = (value) =>
  Array.isArray(value) && value.length <= PAYABLE_BLOCKED_CODES.length && new Set(value).size === value.length && value.every((item) => typeof item === "string" && (PAYABLE_BLOCKED_CODES as readonly string[]).includes(item));

export const PAYABLE_EVENT_METADATA_ALLOWLIST: Readonly<Record<string, ValueCheck>> = {
  // version numbers
  version: isVersionNumber,
  previousVersion: isVersionNumber,
  newVersion: isVersionNumber,
  readyVersion: isVersionNumber,
  // statuses / kinds / codes (enum members only)
  fromStatus: oneOf(PAYABLE_STATUSES),
  toStatus: oneOf(PAYABLE_STATUSES),
  counterpartyType: oneOf(PAYABLE_COUNTERPARTY_TYPES),
  sourceType: oneOf(PAYABLE_SOURCE_TYPES),
  determinationState: oneOf(PAYABLE_DETERMINATION_STATES),
  changeKind: oneOf(PAYABLE_VERSION_CHANGE_KINDS),
  lineCategory: oneOf(PAYABLE_LINE_CATEGORIES),
  resolvesCode: oneOf(PAYABLE_REVIEW_CODES),
  sourceCurrencyState: oneOf(PAYABLE_SOURCE_CURRENCY_STATES),
  openReviewCodes: isReviewCodeList,
  blockedCodes: isBlockedCodeList,
  // opaque refs, the period and the currency CODE (never an amount)
  counterpartyRef: isOpaqueRef,
  agreementRef: isOpaqueRef,
  agreementVersion: isVersionNumber,
  reviewRef: isOpaqueRef,
  reviewVersion: isVersionNumber,
  previousAgreementVersion: isVersionNumber,
  previousReviewVersion: isVersionNumber,
  lineRef: isOpaqueRef,
  commercialPeriod: isPeriodKey,
  currency: isCurrencyCode,
  // counts
  lineCount: isCount,
  openReviewCount: isCount,
  warningCount: isCount,
  // flags
  refreshSource: isBoolean,
  sourceChanged: isBoolean,
  idempotentReplay: isBoolean,
  // Step 15C.1 section 10: Finance's confirmed GST applicability/rate - a Yes/No flag and a
  // percentage rate, never a money amount, so both are safe under this file's own rule above.
  gstApplicable: isBoolean,
  gstRateBps: isNullableBpsRate,
  // human text (also screened for identity/email/amount shapes)
  reason: isSafeNote,
  label: isSafeNote,
};

// Pure. Keeps a key only when it is on the allowlist AND its value passes that key's check;
// returns null when nothing survives (or nothing was given). Never mutates its input.
export function redactPayableEventMetadata(metadata: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!metadata) return null;
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!Object.prototype.hasOwnProperty.call(PAYABLE_EVENT_METADATA_ALLOWLIST, key)) continue;
    if (!PAYABLE_EVENT_METADATA_ALLOWLIST[key]!(value)) continue;
    clean[key] = value;
  }
  return Object.keys(clean).length > 0 ? clean : null;
}

export type PayableEventInput = {
  payableRef: string;
  kind: PayableEventKind;
  version: number;
  actorUserRef: string;
  metadata: Record<string, unknown> | null;
  requestId: string;
  createdAt: string;
};

export function buildPayableEvent(input: PayableEventInput): PayableEvent {
  return payableEventSchema.parse({
    kind: input.kind,
    version: input.version,
    actorUserRef: input.actorUserRef,
    metadata: redactPayableEventMetadata(input.metadata),
    requestId: input.requestId,
    createdAt: input.createdAt,
  });
}

// Appends one event INSIDE the caller's Firestore transaction, so a mutation and its audit event
// commit atomically (an accepted mutation can never lack its event, and a rolled-back one never
// leaves a phantom event). tx.create with a fresh id: never rewritten, never deleted. Must be
// called after every read the transaction needs (Firestore requires all reads before writes).
export function appendPayableEvent(tx: FirebaseFirestore.Transaction, input: PayableEventInput): void {
  tx.create(financePayableEventsCollection(input.payableRef).doc(randomUUID()), buildPayableEvent(input));
}
