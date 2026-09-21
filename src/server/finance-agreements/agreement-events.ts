import { randomUUID } from "node:crypto";

import { AGREEMENT_FIELD_KEYS } from "./fields";
import { financeAgreementEventsCollection } from "./firestore";
import {
  AGREEMENT_FIELD_ORIGINS,
  AGREEMENT_HEAD_STATUSES,
  AGREEMENT_SOURCE_MODES,
  AGREEMENT_TYPES,
  AGREEMENT_VERSION_STATUSES,
  AGREEMENT_ENTRY_DECISIONS,
  COUNTERPARTY_TYPES,
  agreementEventSchema,
  type AgreementEvent,
  type AgreementEventKind,
} from "./types";

// Step 14A: the append-only Agreement audit trail.
//
// Metadata is passed through an EXPLICIT ALLOWLIST: only the named keys below survive, and
// each only when its VALUE has the expected safe shape (an enum member, a small integer, an
// opaque ref, a boolean, a short note). Everything else is dropped - there is no "block
// these substrings" list, so a new or misspelled key can never leak a value by accident.
// No identity value (PAN/Aadhaar/GST/bank/IFSC), contract text/snippet, extracted or
// confirmed field value, or amount has a key in this list, so none can pass.
//
// Free-text keys (`reason`, `note`) hold what a human typed as a justification. They are
// additionally refused when they LOOK like an identity value, an email or an amount - a
// defense-in-depth backstop, not the primary control (the allowlist is).

type ValueCheck = (value: unknown) => boolean;

const isCount: ValueCheck = (value) => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100_000;
const isVersionNumber: ValueCheck = (value) => typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 1_000;
const isBoolean: ValueCheck = (value) => typeof value === "boolean";
const oneOf =
  (allowed: readonly string[]): ValueCheck =>
  (value) =>
    typeof value === "string" && allowed.includes(value);
const isOpaqueRef: ValueCheck = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value);
const isParserVersion: ValueCheck = (value) => typeof value === "string" && /^[A-Za-z0-9._+-]{1,100}$/.test(value);
const isUtcDate: ValueCheck = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);

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

const IDENTITY_COMPONENT_NAMES = ["pan", "aadhaar", "gst", "bank"] as const;
// A list of DISTINCT identity component NAMES (never values): a KYC update names which components it touched.
const isComponentList: ValueCheck = (value) =>
  Array.isArray(value) && value.length >= 1 && value.length <= IDENTITY_COMPONENT_NAMES.length && new Set(value).size === value.length && value.every((item) => typeof item === "string" && (IDENTITY_COMPONENT_NAMES as readonly string[]).includes(item));

const isFieldKeyList: ValueCheck = (value) => Array.isArray(value) && value.length <= AGREEMENT_FIELD_KEYS.length && value.every((item) => typeof item === "string" && (AGREEMENT_FIELD_KEYS as readonly string[]).includes(item));

export const AGREEMENT_EVENT_METADATA_ALLOWLIST: Readonly<Record<string, ValueCheck>> = {
  // version numbers
  version: isVersionNumber,
  previousVersion: isVersionNumber,
  newVersion: isVersionNumber,
  supersededVersion: isVersionNumber,
  supersededByVersion: isVersionNumber,
  // statuses / modes / kinds (enum members only)
  fromStatus: oneOf(AGREEMENT_VERSION_STATUSES),
  toStatus: oneOf(AGREEMENT_VERSION_STATUSES),
  headStatus: oneOf(AGREEMENT_HEAD_STATUSES),
  sourceMode: oneOf(AGREEMENT_SOURCE_MODES),
  counterpartyType: oneOf(COUNTERPARTY_TYPES),
  agreementType: oneOf(AGREEMENT_TYPES),
  origin: oneOf(AGREEMENT_FIELD_ORIGINS),
  decision: oneOf(AGREEMENT_ENTRY_DECISIONS),
  mode: oneOf(["FILL_MISSING", "OVERWRITE_MISMATCH"]),
  // which field / which identity component (a NAME, never a value)
  fieldKey: oneOf(AGREEMENT_FIELD_KEYS),
  fieldKeys: isFieldKeyList,
  component: oneOf(IDENTITY_COMPONENT_NAMES),
  components: isComponentList,
  // counts
  fieldCount: isCount,
  decidedCount: isCount,
  pendingCount: isCount,
  proposalCount: isCount,
  attachedCount: isCount,
  blockerCount: isCount,
  platformCount: isCount,
  accountCount: isCount,
  // opaque refs and the parser version
  artifactRef: isOpaqueRef,
  runRef: isOpaqueRef,
  parserVersion: isParserVersion,
  // dates of the agreement's own effective range (public contract dates, not identity)
  effectiveFrom: isUtcDate,
  effectiveTo: isUtcDate,
  // flags
  resolutionAcknowledged: isBoolean,
  idempotentReplay: isBoolean,
  // human justification text (also screened for identity/email/amount shapes)
  reason: isSafeNote,
  note: isSafeNote,
};

// Pure. Keeps a key only when it is on the allowlist AND its value passes that key's check;
// returns null when nothing survives (or nothing was given). Never mutates its input.
export function redactAgreementEventMetadata(metadata: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!metadata) return null;
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!Object.prototype.hasOwnProperty.call(AGREEMENT_EVENT_METADATA_ALLOWLIST, key)) continue;
    if (!AGREEMENT_EVENT_METADATA_ALLOWLIST[key]!(value)) continue;
    clean[key] = value;
  }
  return Object.keys(clean).length > 0 ? clean : null;
}

export type AgreementEventInput = {
  agreementRef: string;
  kind: AgreementEventKind;
  version: number;
  actorUserRef: string;
  metadata: Record<string, unknown> | null;
  requestId: string;
  createdAt: string;
};

export function buildAgreementEvent(input: AgreementEventInput): AgreementEvent {
  return agreementEventSchema.parse({
    kind: input.kind,
    version: input.version,
    actorUserRef: input.actorUserRef,
    metadata: redactAgreementEventMetadata(input.metadata),
    requestId: input.requestId,
    createdAt: input.createdAt,
  });
}

// Appends one event INSIDE the caller's Firestore transaction, so a mutation and its audit
// event commit atomically (an accepted mutation can never lack its event, and a rolled-back
// one never leaves a phantom event). tx.create with a fresh id: never rewritten, never
// deleted. Must be called after every read the transaction needs (Firestore requires all
// reads before writes).
export function appendAgreementEvent(tx: FirebaseFirestore.Transaction, input: AgreementEventInput): void {
  tx.create(financeAgreementEventsCollection(input.agreementRef).doc(randomUUID()), buildAgreementEvent(input));
}
