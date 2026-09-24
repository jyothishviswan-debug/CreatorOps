import { z } from "zod";

// Step 17A: the canonical Finance Payments domain.
//
// A Payment is actual money movement against an APPROVED Invoice. The canonical flow is
//   Agreement -> Payable -> Invoice -> approval -> Payment(s) -> settlement
// and this module implements exactly the Payment step. It consumes the pinned, immutable evidence
// of an APPROVED Invoice (and, through it, the Invoice's own pinned Payable evidence) - it never
// recomputes GST/TDS, never mutates the Invoice or Payable, and never reruns payee identity
// matching (see payment-source.ts).
//
// Shapes deliberately follow src/server/finance-invoices/types.ts (which itself follows
// src/server/finance-payables/types.ts): one HEAD carrying only current workflow / indexable
// projection fields, an append-only chain of numbered, IMMUTABLE VERSIONS carrying the declared
// Payment data, and an append-only event history.
//
// Hard rules encoded here:
//   - Money is ALWAYS integer minor units, plus an explicit ISO-4217-shaped currency - identical
//     convention to Payables'/Invoices' own amountMinorSchema / currencyCodeSchema.
//   - The Payment target is ALWAYS expectedNetPaymentMinor, pinned once from the approved Invoice's
//     evidence at creation - never the gross Invoice total, the service base, or the Agreement's
//     monthly amount.
//   - No raw bank account data, no PAN/Aadhaar/GSTIN, no KYC payload, no Google Drive locator is
//     representable anywhere in this file - only the already-safe, already-masked payee-identity
//     projection the Invoice module itself already exposes (see payment-source.ts).

const isoTimestamp = z.string().min(1);
const nonEmpty = z.string().min(1);
const refString = z.string().min(1).max(200);
const shortText = (max: number) => z.string().trim().min(1).max(max);

// --- Money ------------------------------------------------------------------------------------------------------------------
// Identical convention to the Payables/Invoices modules' own (pinned equal by a static unit test).
export const amountMinorSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
// A Payment's own transferred amount is always POSITIVE (section 8: "Payment amount: positive") -
// zero is never a valid transfer.
export const positiveAmountMinorSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
export const currencyCodeSchema = z.string().regex(/^[A-Z]{3}$/, "Expected a 3-letter uppercase currency code.");

// --- Counterparty (mirrors Invoices'/Payables' own; never polymorphic, opaque ref resolved live) ---------------------------
export const PAYMENT_COUNTERPARTY_TYPES = ["PARTNER", "VENDOR"] as const;
export const paymentCounterpartyTypeSchema = z.enum(PAYMENT_COUNTERPARTY_TYPES);
export type PaymentCounterpartyType = z.infer<typeof paymentCounterpartyTypeSchema>;

// --- Commercial period (mirrors Invoices'/Payables' own) --------------------------------------------------------------------
export const periodKeySchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Expected a YYYY-MM commercial period.");
export const utcDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a YYYY-MM-DD date.");

export const commercialPeriodSchema = z.object({ periodKey: periodKeySchema, periodStart: utcDateSchema, periodEnd: utcDateSchema }).strict();
export type CommercialPeriod = z.infer<typeof commercialPeriodSchema>;

// --- Lifecycle (section 6/7) --------------------------------------------------------------------------------------------------
export const PAYMENT_STATUSES = ["DRAFT", "RECORDED", "CONFIRMED", "FAILED", "VOID"] as const;
export const paymentStatusSchema = z.enum(PAYMENT_STATUSES);
export type PaymentStatus = z.infer<typeof paymentStatusSchema>;

export const MAX_PAYMENT_VERSIONS = 200;

// --- Payment methods (section 11) - a bounded enum, no provider integration --------------------------------------------------
export const PAYMENT_METHODS = ["BANK_TRANSFER", "UPI", "CHEQUE", "CASH", "OTHER"] as const;
export const paymentMethodSchema = z.enum(PAYMENT_METHODS);
export type PaymentMethod = z.infer<typeof paymentMethodSchema>;

// --- Settlement state (section 4/9) --------------------------------------------------------------------------------------------
export const PAYMENT_SETTLEMENT_STATES = ["UNPAID", "PARTIALLY_PAID", "PAID", "OVERPAID", "REVIEW_REQUIRED"] as const;
export const paymentSettlementStateSchema = z.enum(PAYMENT_SETTLEMENT_STATES);
export type PaymentSettlementState = z.infer<typeof paymentSettlementStateSchema>;

// --- Approved-Invoice source pin (section 2/3/12/14) - captured ONCE at creation, NEVER silently -----------------------------
// re-pinned. A later Invoice correction is surfaced only as a read-only warning (see
// payment-source.ts's compareInvoiceSourceRevision) - it never rewrites this pin.
export const paymentInvoicePinSchema = z
  .object({
    invoiceRef: refString,
    invoiceVersion: z.number().int().min(1), // the exact APPROVED version pinned
    payableRef: refString,
    payableVersion: z.number().int().min(1),
    counterpartyType: paymentCounterpartyTypeSchema,
    counterpartyRef: refString,
    commercialPeriod: commercialPeriodSchema,
    currency: currencyCodeSchema,
    externalInvoiceNumber: shortText(200).nullable(),
    // Step 17B section 13: the Invoice's own already-computed breakdown, pinned alongside the
    // payment target for read-only display on the Source Invoice tab - NEVER recomputed here (same
    // "copy verbatim, never re-derive" discipline as expectedNetPaymentMinor below and the payee-
    // identity snapshot above).
    serviceBaseMinor: amountMinorSchema,
    gstMinor: amountMinorSchema,
    grossInvoiceExpectedMinor: amountMinorSchema,
    tdsMinor: amountMinorSchema,
    // THE payment target (section 3) - never the gross Invoice total, service base, or Agreement
    // monthly amount. Null only when the actor pinning the source could not see amounts (blocked
    // upstream by payment-source.ts before a draft is ever created - kept nullable here only so the
    // schema shape can never silently coerce a withheld figure into 0).
    expectedNetPaymentMinor: amountMinorSchema,
    pinnedAt: isoTimestamp,
  })
  .strict();
export type PaymentInvoicePin = z.infer<typeof paymentInvoicePinSchema>;

// --- Payee identity snapshot (section 12) - consumes the Invoice's approval-time decision, never ------------------------------
// reruns matching and never exposes a raw restricted value. `bankSafeDisplay` is the ALREADY masked
// projection the Invoice module itself returns to any authorized viewer (payee-identity/matcher.ts's
// safe-display build) - copied verbatim, never re-derived from restricted data.
export const paymentPayeeIdentitySnapshotSchema = z
  .object({
    overallStatusAtApproval: shortText(40).nullable(),
    bankSafeDisplay: shortText(200).nullable(),
    resolution: z.object({ reason: shortText(1000), actorUserRef: nonEmpty, at: isoTimestamp }).strict().nullable(),
    comparedAt: isoTimestamp.nullable(),
  })
  .strict();
export type PaymentPayeeIdentitySnapshot = z.infer<typeof paymentPayeeIdentitySnapshotSchema>;

// --- External reference (section 10) -------------------------------------------------------------------------------------------
export const paymentExternalReferenceSchema = shortText(120);

// --- Version document (financePayments/{paymentRef}/versions/{n}) -------------------------------------------------------------
// IMMUTABLE. Created with tx.create and never rewritten - every change creates the NEXT version.
export const PAYMENT_VERSION_CHANGE_KINDS = ["created", "revised", "reopened"] as const;
export const paymentVersionChangeKindSchema = z.enum(PAYMENT_VERSION_CHANGE_KINDS);
export type PaymentVersionChangeKind = z.infer<typeof paymentVersionChangeKindSchema>;

export const paymentVersionDocSchema = z
  .object({
    paymentRef: nonEmpty,
    version: z.number().int().min(1).max(MAX_PAYMENT_VERSIONS),
    invoicePin: paymentInvoicePinSchema,
    payeeIdentity: paymentPayeeIdentitySnapshotSchema,
    // Declared fields - each nullable while the DRAFT is incomplete (mirrors Invoice's own draft
    // shape). `amountMinor` is the actual cash represented by THIS payment record (may be a partial
    // amount of invoicePin.expectedNetPaymentMinor).
    amountMinor: positiveAmountMinorSchema.nullable(),
    paymentDate: utcDateSchema.nullable(),
    method: paymentMethodSchema.nullable(),
    externalReference: paymentExternalReferenceSchema.nullable(),
    normalizedExternalReferenceKey: z.string().min(1).max(200).nullable(),
    memo: shortText(1000).nullable(),
    changeKind: paymentVersionChangeKindSchema,
    reason: shortText(1000).nullable(),
    createdAt: isoTimestamp,
    createdByUserRef: nonEmpty,
  })
  .strict()
  .superRefine((doc, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
    if (doc.version === 1 && doc.changeKind !== "created") issue("changeKind", "Version 1 is the creation.");
    if (doc.version > 1 && doc.changeKind === "created") issue("changeKind", "Only version 1 is the creation.");
    if (doc.externalReference === null && doc.normalizedExternalReferenceKey !== null) issue("normalizedExternalReferenceKey", "There is no normalized key without a declared external reference.");
    if (doc.externalReference !== null && doc.normalizedExternalReferenceKey === null) issue("normalizedExternalReferenceKey", "A declared external reference always has its normalized key.");
  });
export type PaymentVersionDoc = z.infer<typeof paymentVersionDocSchema>;

// --- Overpayment override (section 8/15) - pinned on the HEAD to the exact version it was accepted for -----------------------
export const paymentOverageOverrideSchema = z.object({ forVersion: z.number().int().min(1), reason: shortText(1000), actorUserRef: nonEmpty, at: isoTimestamp }).strict();
export type PaymentOverageOverride = z.infer<typeof paymentOverageOverrideSchema>;

// --- Head list projection --------------------------------------------------------------------------------------------------
export const paymentHeadDisplaySchema = z
  .object({
    counterpartyName: shortText(200),
    counterpartyNameLower: shortText(200),
    amountMinor: amountMinorSchema.nullable(),
    status: paymentStatusSchema,
    projectedAt: isoTimestamp,
  })
  .strict();
export type PaymentHeadDisplay = z.infer<typeof paymentHeadDisplaySchema>;

// --- Head document (financePayments/{paymentRef}) ------------------------------------------------------------------------------
export const paymentHeadDocSchema = z
  .object({
    paymentRef: nonEmpty,
    docVersion: z.number().int().min(1),

    invoiceRef: refString,
    payableRef: refString,
    counterpartyType: paymentCounterpartyTypeSchema,
    counterpartyRef: refString,
    currency: currencyCodeSchema,

    ownerUid: nonEmpty.nullable().default(null),
    regionIds: z.array(nonEmpty).max(50).default([]),
    teamIds: z.array(nonEmpty).max(50).default([]),
    partnerUid: nonEmpty.nullable().default(null),
    vendorUid: nonEmpty.nullable().default(null),

    status: paymentStatusSchema,
    latestVersion: z.number().int().min(1).max(MAX_PAYMENT_VERSIONS),

    recordedVersion: z.number().int().min(1).max(MAX_PAYMENT_VERSIONS).nullable().default(null),
    recordedAt: isoTimestamp.nullable().default(null),
    recordedByUserRef: nonEmpty.nullable().default(null),

    confirmedVersion: z.number().int().min(1).max(MAX_PAYMENT_VERSIONS).nullable().default(null),
    confirmedAt: isoTimestamp.nullable().default(null),
    confirmedByUserRef: nonEmpty.nullable().default(null),
    // Set only when a CONFIRMED payment is later voided (a correction/reversal - section 7/20):
    // the confirmed evidence itself is never edited, only this reversal marker plus a linked event.
    confirmedReversedAt: isoTimestamp.nullable().default(null),
    confirmedReversedByUserRef: nonEmpty.nullable().default(null),

    failedVersion: z.number().int().min(1).max(MAX_PAYMENT_VERSIONS).nullable().default(null),
    failedAt: isoTimestamp.nullable().default(null),
    failedByUserRef: nonEmpty.nullable().default(null),
    failedReason: shortText(1000).nullable().default(null),

    voidedAt: isoTimestamp.nullable().default(null),
    voidedByUserRef: nonEmpty.nullable().default(null),
    voidReason: shortText(1000).nullable().default(null),

    // Accepted overpayment (section 8), pinned to the exact version it was accepted for. Cleared
    // whenever a new version is created (an unreviewed version carries no override).
    overageOverride: paymentOverageOverrideSchema.nullable().default(null),

    display: paymentHeadDisplaySchema,

    createdAt: isoTimestamp,
    createdByUserRef: nonEmpty,
    updatedAt: isoTimestamp,
    updatedByUserRef: nonEmpty,
  })
  .strict()
  .superRefine((head, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
    if (head.counterpartyType === "PARTNER" && (!head.partnerUid || head.vendorUid)) issue("partnerUid", "A partner payment is scoped by exactly a partnerUid.");
    if (head.counterpartyType === "VENDOR" && (!head.vendorUid || head.partnerUid)) issue("vendorUid", "A vendor payment is scoped by exactly a vendorUid.");
    if (head.status === "RECORDED" && (head.recordedVersion === null || head.recordedAt === null || head.recordedByUserRef === null)) issue("recordedVersion", "A recorded payment pins its version, time and actor.");
    if (head.status === "CONFIRMED" && (head.confirmedVersion === null || head.confirmedAt === null || head.confirmedByUserRef === null)) issue("confirmedVersion", "A confirmed payment pins its version, time and actor.");
    if (head.status === "FAILED" && (head.failedVersion === null || head.failedAt === null || head.failedByUserRef === null || head.failedReason === null)) issue("failedReason", "A failed payment records when, by whom, which version and why.");
    if (head.status === "VOID" && (head.voidedAt === null || head.voidedByUserRef === null || head.voidReason === null)) issue("voidReason", "A voided payment records when, by whom and why.");
    if (head.status !== "VOID" && (head.voidedAt !== null || head.voidReason !== null)) issue("voidReason", "Only a voided payment carries a void reason.");
    if (head.overageOverride !== null && head.overageOverride.forVersion > head.latestVersion) issue("overageOverride", "An accepted overpayment cannot name a version beyond the payment's latest.");
    if (head.confirmedReversedAt !== null && head.status !== "VOID") issue("confirmedReversedAt", "A confirmed-then-reversed payment is always VOID.");
  });
export type PaymentHeadDoc = z.infer<typeof paymentHeadDocSchema>;

// --- External-reference duplicate claim (financePaymentReferenceClaims/{claimId}) - section 10 --------------------------------
// One claim per (method, normalized reference): guards against two DIFFERENT Payment heads
// declaring the same UTR / cheque number / transaction id. A revision under the SAME head that
// keeps or changes its own reference is never a duplicate of itself (the claim already names that
// head).
export const paymentReferenceClaimDocSchema = z.object({ claimId: nonEmpty, paymentRef: nonEmpty, method: paymentMethodSchema, normalizedReferenceKey: nonEmpty, createdAt: isoTimestamp }).strict();
export type PaymentReferenceClaimDoc = z.infer<typeof paymentReferenceClaimDocSchema>;

// --- Settlement accumulator (financePaymentSettlements/{invoiceRef}) - section 8/19 --------------------------------------------
// The ONE document that makes overpayment concurrency-safe: every CONFIRM transaction reads this
// SAME document (inside the transaction) before deciding whether the new confirmed total would
// exceed the pinned expected net payment, and writes its updated total in the SAME transaction as
// the Payment's own status change. Two racing confirmations against the same Invoice therefore
// serialize on this one document - Firestore retries the loser's transaction with a fresh read,
// exactly like the Payable/Invoice modules' own expectedDocVersion optimistic-concurrency checks.
export const paymentSettlementAccumulatorDocSchema = z
  .object({
    invoiceRef: nonEmpty,
    expectedNetPaymentMinor: amountMinorSchema,
    confirmedTotalMinor: amountMinorSchema,
    docVersion: z.number().int().min(1),
    updatedAt: isoTimestamp,
    updatedByUserRef: nonEmpty,
  })
  .strict();
export type PaymentSettlementAccumulatorDoc = z.infer<typeof paymentSettlementAccumulatorDocSchema>;

// --- Append-only event history (financePayments/{paymentRef}/events/{id}) ------------------------------------------------------
export const PAYMENT_EVENT_KINDS = [
  "PAYMENT_CREATED",
  "PAYMENT_VERSION_CREATED",
  "PAYMENT_RECORDED",
  "PAYMENT_CONFIRMED",
  "PAYMENT_FAILED",
  "PAYMENT_VOIDED",
  "PAYMENT_REOPENED",
  "PAYMENT_OVERPAYMENT_OVERRIDE",
  "PAYMENT_CONFIRMED_REVERSED",
  "PAYMENT_SOURCE_REVISION_DETECTED",
] as const;
export const paymentEventKindSchema = z.enum(PAYMENT_EVENT_KINDS);
export type PaymentEventKind = z.infer<typeof paymentEventKindSchema>;

export const paymentEventSchema = z
  .object({
    kind: paymentEventKindSchema,
    version: z.number().int().min(1),
    actorUserRef: nonEmpty,
    // Already passed through the explicit ALLOWLIST redactor (payment-events.ts).
    metadata: z.record(z.string(), z.unknown()).nullable(),
    requestId: nonEmpty,
    createdAt: isoTimestamp,
  })
  .strict();
export type PaymentEvent = z.infer<typeof paymentEventSchema>;

// --- Source-revision currency (section 14) - an Invoice correction, WARNING only ----------------------------------------------
export const PAYMENT_SOURCE_CURRENCY_STATES = ["CURRENT", "INVOICE_REVISION_AVAILABLE"] as const;
export type PaymentSourceCurrencyState = (typeof PAYMENT_SOURCE_CURRENCY_STATES)[number];

// --- Result/error plumbing - same shape as Finance Invoices'/Payables' own -----------------------------------------------------
export type FinancePaymentsDenialReason = "not_authenticated" | "feature_denied" | "action_denied" | "scope_denied" | "sensitive_denied";

export type FinancePaymentsServiceErrorCode = "unauthorized" | "not_found" | "invalid_input" | "stale_write" | "not_ready" | "conflict" | "internal";

export type FinancePaymentsReadinessIssue = { code: string; message: string };

export type FinancePaymentsServiceResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: FinancePaymentsServiceErrorCode; message: string; reason?: FinancePaymentsDenialReason; blockers?: FinancePaymentsReadinessIssue[] };

export type FinancePaymentsErrorResult = Extract<FinancePaymentsServiceResult<unknown>, { ok: false }>;

export function financePaymentsUnauthorizedResult(reason: FinancePaymentsDenialReason): FinancePaymentsErrorResult {
  return { ok: false, code: "unauthorized", message: `Finance Payments access denied (${reason}).`, reason };
}

export function financePaymentsInvalidInputResult(message: string): FinancePaymentsErrorResult {
  return { ok: false, code: "invalid_input", message };
}

// The ONE neutral outcome for a missing, out-of-scope or forged reference - identical in every case
// so a caller can never tell them apart.
export const NEUTRAL_NOT_FOUND_MESSAGE = "Not found.";
export function financePaymentsNotFoundResult(message: string = NEUTRAL_NOT_FOUND_MESSAGE): FinancePaymentsErrorResult {
  return { ok: false, code: "not_found", message };
}

export function financePaymentsStaleResult(message = "This payment was changed elsewhere. Reload and try again."): FinancePaymentsErrorResult {
  return { ok: false, code: "stale_write", message };
}

export function financePaymentsConflictResult(message: string): FinancePaymentsErrorResult {
  return { ok: false, code: "conflict", message };
}

export function financePaymentsNotReadyResult(message: string, blockers: FinancePaymentsReadinessIssue[]): FinancePaymentsErrorResult {
  return { ok: false, code: "not_ready", message, blockers };
}

export function financePaymentsInternalResult(message = "Something went wrong."): FinancePaymentsErrorResult {
  return { ok: false, code: "internal", message };
}

// --- Strict command INPUT schemas ------------------------------------------------------------------------------------------------
// Every object is .strict(): an unknown key (a client-supplied amount, status, scope, pin, source
// ref ...) is rejected, never silently dropped. `expectedDocVersion` is always the HEAD's
// docVersion; a mismatch is reported as stale_write.
export const paymentRefSchema = z.string().regex(/^pmt_[0-9a-f]{20}$/, "Invalid payment reference.");
export const invoiceRefForPaymentSchema = z.string().regex(/^inv_[0-9a-f]{20}$/, "Invalid invoice reference.");
const expectedDocVersionSchema = z.number().int().min(1);
const reasonSchema = z.string().trim().min(3).max(1000);

// The ONLY client-named source: which approved Invoice to pay. The server resolves and PINS every
// other ref (Payable, counterparty, commercial period, expected net payment, payee identity) from
// that Invoice's own current APPROVED version - never from the client (section 2: "never silently
// repin").
export const createPaymentDraftInputSchema = z.object({ invoiceRef: invoiceRefForPaymentSchema }).strict();
export type CreatePaymentDraftInput = z.infer<typeof createPaymentDraftInputSchema>;

export const paymentRefParamsSchema = z.object({ paymentRef: paymentRefSchema }).strict();

export const revisePaymentDraftInputSchema = z
  .object({
    paymentRef: paymentRefSchema,
    expectedDocVersion: expectedDocVersionSchema,
    amountMinor: positiveAmountMinorSchema.nullable().optional(),
    paymentDate: utcDateSchema.nullable().optional(),
    method: paymentMethodSchema.nullable().optional(),
    externalReference: paymentExternalReferenceSchema.nullable().optional(),
    memo: shortText(1000).nullable().optional(),
    reason: reasonSchema,
  })
  .strict();
export type RevisePaymentDraftInput = z.infer<typeof revisePaymentDraftInputSchema>;

export const recordPaymentInputSchema = z.object({ paymentRef: paymentRefSchema, expectedDocVersion: expectedDocVersionSchema }).strict();
export type RecordPaymentInput = z.infer<typeof recordPaymentInputSchema>;

// `overrideReason` is present ONLY when the actor explicitly wants to override an overpayment
// block (section 8/15 - restricted to the exact `override_payment_overage` action). Confirming a
// payment that would NOT overpay never needs it.
export const confirmPaymentInputSchema = z.object({ paymentRef: paymentRefSchema, expectedDocVersion: expectedDocVersionSchema, overrideOverageReason: reasonSchema.optional() }).strict();
export type ConfirmPaymentInput = z.infer<typeof confirmPaymentInputSchema>;

export const failPaymentInputSchema = z.object({ paymentRef: paymentRefSchema, expectedDocVersion: expectedDocVersionSchema, reason: reasonSchema }).strict();
export type FailPaymentInput = z.infer<typeof failPaymentInputSchema>;

export const reopenPaymentInputSchema = z.object({ paymentRef: paymentRefSchema, expectedDocVersion: expectedDocVersionSchema, reason: reasonSchema }).strict();
export type ReopenPaymentInput = z.infer<typeof reopenPaymentInputSchema>;

export const voidPaymentInputSchema = z.object({ paymentRef: paymentRefSchema, expectedDocVersion: expectedDocVersionSchema, reason: reasonSchema }).strict();
export type VoidPaymentInput = z.infer<typeof voidPaymentInputSchema>;

export const MAX_PAYMENT_PAGE_SIZE = 100;
export const DEFAULT_PAYMENT_PAGE_SIZE = 25;

export const listPaymentsQuerySchema = z
  .object({
    status: paymentStatusSchema.optional(),
    invoiceRef: invoiceRefForPaymentSchema.optional(),
    counterpartyType: paymentCounterpartyTypeSchema.optional(),
    counterpartyRef: refString.optional(),
    limit: z.number().int().min(1).max(MAX_PAYMENT_PAGE_SIZE).optional(),
    // An opaque, deterministic compound cursor produced by a previous page.
    cursor: z.string().min(1).max(4000).optional(),
  })
  .strict();
export type ListPaymentsQuery = z.infer<typeof listPaymentsQuerySchema>;

export const invoiceSettlementSummaryInputSchema = z.object({ invoiceRef: invoiceRefForPaymentSchema }).strict();
