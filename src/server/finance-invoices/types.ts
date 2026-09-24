import { z } from "zod";

import { payeeIdentityMatchResultSchema } from "./payee-identity/types";

// Step 16A: the canonical Finance Invoices domain.
//
// An Invoice CONSUMES a Payable: it belongs to exactly one canonical Payable head, at exactly one
// PINNED, immutable Payable version, in this phase (one Payable -> one canonical Invoice head ->
// immutable Invoice versions - see section 4 of the spec). The canonical flow is
//   Agreement -> Payable -> Invoice -> approval -> Payment(s) -> close/correction
// and this module implements exactly the Invoice step. Payments do not exist yet - nothing here
// models a Payment record or a Payment status.
//
// Shapes deliberately follow src/server/finance-payables/types.ts (which itself follows
// src/server/finance-agreements/types.ts): one HEAD carrying only current workflow / indexable
// projection fields, an append-only chain of numbered, IMMUTABLE VERSIONS carrying the declared
// Invoice data and its reconciliation result, and an append-only event history.
//
// Hard rules encoded here:
//   - Money is ALWAYS integer minor units, plus an explicit ISO-4217-shaped currency - identical
//     convention to Payables' own amountMinorSchema / currencyCodeSchema (pinned equal by a static
//     unit test).
//   - No restricted identity value (PAN / Aadhaar / GST / bank), no raw full Agreement text, no
//     Partner Review source-record identifier, and no canonical KYC identity is representable in
//     any schema of this file - the Invoice inherits only opaque refs from the Payable it pins.
//   - Nothing here models a Payment record or a Payment status.

const isoTimestamp = z.string().min(1);
const nonEmpty = z.string().min(1);
const refString = z.string().min(1).max(200);
const shortText = (max: number) => z.string().trim().min(1).max(max);

// --- Money ------------------------------------------------------------------------------------------------------------------
// Identical convention to the Payables/Agreements modules' own (pinned equal by a static test).
export const amountMinorSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const currencyCodeSchema = z.string().regex(/^[A-Z]{3}$/, "Expected a 3-letter uppercase currency code.");

// --- Counterparty (mirrors Payables' own; never polymorphic, opaque ref resolved live) ----------------------------------------
export const INVOICE_COUNTERPARTY_TYPES = ["PARTNER", "VENDOR"] as const;
export const invoiceCounterpartyTypeSchema = z.enum(INVOICE_COUNTERPARTY_TYPES);
export type InvoiceCounterpartyType = z.infer<typeof invoiceCounterpartyTypeSchema>;

// --- Commercial period (mirrors Payables' own) -------------------------------------------------------------------------------
export const periodKeySchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Expected a YYYY-MM commercial period.");
export const utcDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a YYYY-MM-DD date.");

export const commercialPeriodSchema = z.object({ periodKey: periodKeySchema, periodStart: utcDateSchema, periodEnd: utcDateSchema }).strict();
export type CommercialPeriod = z.infer<typeof commercialPeriodSchema>;

// --- Lifecycle ----------------------------------------------------------------------------------------------------------------
export const INVOICE_STATUSES = ["DRAFT", "SUBMITTED", "APPROVED", "REJECTED", "VOID"] as const;
export const invoiceStatusSchema = z.enum(INVOICE_STATUSES);
export type InvoiceStatus = z.infer<typeof invoiceStatusSchema>;

export const MAX_INVOICE_VERSIONS = 200;

// --- Payable pin (section 4/15, revised by Step 15C section 18/23) - captured once at creation, ----------------------------
// NEVER re-read live except by the explicit, read-only source-revision comparison. A later Payable
// revision never mutates this.
//
// STEP 15C CORRECTION: the old single `payableExpectedTotalMinorSigned` scalar is REPLACED by the
// Payable's own five distinct tax/proration totals (finance-payables/types.ts's
// PayableVersionDoc), copied verbatim so this module never assumes what an old, undifferentiated
// field name meant. The Invoice reconciles its declared total against
// `payableGrossInvoiceExpectedMinor` specifically - NOT the after-TDS `payableExpectedNetPaymentMinor`
// - because TDS is CreatorOps payment treatment, not part of the supplier's own gross Invoice
// amount (section 18). `payableTotalAmountMinorSigned` (the full payout sum, Payables' own
// `totalAmountMinorSigned` - includes transfer fee/incentive/manual lines too) is retained ONLY as
// read-only context, never as the reconciliation target.
export const invoicePayablePinSchema = z
  .object({
    payableRef: refString,
    payableVersion: z.number().int().min(1),
    counterpartyType: invoiceCounterpartyTypeSchema,
    counterpartyRef: refString,
    agreementRef: refString,
    agreementVersion: z.number().int().min(1),
    reviewRef: refString.nullable(),
    reviewVersion: z.number().int().min(1).nullable(),
    commercialPeriod: commercialPeriodSchema,
    payableCurrency: currencyCodeSchema,
    // The Payable's full signed payout sum (Payables' own totalAmountMinorSigned) - context only.
    payableTotalAmountMinorSigned: z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
    // The five Step 15C totals, copied verbatim from the pinned Payable version.
    payableServiceBaseMinor: z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).nullable(),
    payableGstMinor: amountMinorSchema,
    // THE reconciliation target for the Invoice's declared total (section 18/23).
    payableGrossInvoiceExpectedMinor: z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).nullable(),
    payableTdsMinor: amountMinorSchema,
    payableExpectedNetPaymentMinor: z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).nullable(),
    payableCalculationRuleVersion: z.string().min(1).max(60),
    pinnedAt: isoTimestamp,
  })
  .strict();
export type InvoicePayablePin = z.infer<typeof invoicePayablePinSchema>;

// --- Declared tax line (section 9 - capture, never invent) ---------------------------------------------------------------------
export const invoiceTaxLineSchema = z
  .object({
    label: shortText(200),
    // Basis points (1/100 of a percent) so a declared rate is an integer, never a float - 1800 =
    // 18.00%. null when the source states no rate (an amount-only tax line).
    ratePercentBasisPoints: z.number().int().min(0).max(1_000_000).nullable(),
    amountMinor: amountMinorSchema,
  })
  .strict();
export type InvoiceTaxLine = z.infer<typeof invoiceTaxLineSchema>;
export const MAX_INVOICE_TAX_LINES = 20;

// --- Declared Invoice document reference (section 10) ---------------------------------------------------------------------------
export const invoiceDocumentRefSchema = z
  .object({
    documentId: nonEmpty,
    fileName: shortText(300),
    mimeType: z.literal("application/pdf"),
    sizeBytes: z.number().int().min(1).max(10 * 1024 * 1024),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    storedAt: isoTimestamp,
    storedByUserRef: nonEmpty,
  })
  .strict();
export type InvoiceDocumentRef = z.infer<typeof invoiceDocumentRefSchema>;

// --- Reconciliation (section 11) ------------------------------------------------------------------------------------------------
export const INVOICE_RECONCILIATION_STATES = ["MATCH", "MISMATCH", "MISSING_IN_INVOICE", "MISSING_IN_PAYABLE", "REVIEW_REQUIRED", "BLOCKED"] as const;
export const invoiceReconciliationStateSchema = z.enum(INVOICE_RECONCILIATION_STATES);
export type InvoiceReconciliationState = z.infer<typeof invoiceReconciliationStateSchema>;

// The CLOSED set of facts a reconciliation finding can name. Never a guess, never an invented tax
// rule - see amount-determination-style discipline in reconciliation.ts.
export const INVOICE_RECONCILIATION_CODES = [
  "CURRENCY_MISMATCH",
  // Step 15C section 18/23: the Invoice's declared total vs the Payable's GROSS EXPECTED INVOICE
  // TOTAL (serviceBase + GST) - never the after-TDS expected net payment.
  "TOTAL_AMOUNT_MISMATCH",
  "COUNTERPARTY_MISMATCH",
  "COMMERCIAL_PERIOD_MISMATCH",
  "PAYABLE_VERSION_STALE",
  "DUPLICATE_INVOICE_NUMBER",
  "MISSING_INVOICE_DOCUMENT",
  "MISSING_INVOICE_TOTAL",
  "MISSING_PAYABLE_TOTAL",
  "ARITHMETIC_INCONSISTENT",
  // Step 15C section 20: an informational (WARNING) comparison of the Invoice's declared subtotal
  // against the Payable's prorated service base - never a blocker on its own (the supplier's own
  // subtotal/tax split is theirs to state; only the gross TOTAL is the hard reconciliation target).
  "SUBTOTAL_SERVICE_BASE_MISMATCH",
] as const;
export const invoiceReconciliationCodeSchema = z.enum(INVOICE_RECONCILIATION_CODES);
export type InvoiceReconciliationCode = z.infer<typeof invoiceReconciliationCodeSchema>;

export const INVOICE_RECONCILIATION_SEVERITIES = ["BLOCKER", "WARNING"] as const;
export const invoiceReconciliationSeveritySchema = z.enum(INVOICE_RECONCILIATION_SEVERITIES);
export type InvoiceReconciliationSeverity = z.infer<typeof invoiceReconciliationSeveritySchema>;

export const invoiceReconciliationFindingSchema = z.object({ code: invoiceReconciliationCodeSchema, severity: invoiceReconciliationSeveritySchema, message: shortText(400) }).strict();
export type InvoiceReconciliationFinding = z.infer<typeof invoiceReconciliationFindingSchema>;
export const MAX_RECONCILIATION_FINDINGS = INVOICE_RECONCILIATION_CODES.length;

export const invoiceReconciliationResultSchema = z
  .object({ state: invoiceReconciliationStateSchema, findings: z.array(invoiceReconciliationFindingSchema).max(MAX_RECONCILIATION_FINDINGS), computedAt: isoTimestamp })
  .strict();
export type InvoiceReconciliationResult = z.infer<typeof invoiceReconciliationResultSchema>;

// --- Version document (financeInvoices/{invoiceRef}/versions/{n}) ---------------------------------------------------------------
// IMMUTABLE. Created with tx.create and never rewritten - every change creates the NEXT version.
export const INVOICE_VERSION_CHANGE_KINDS = ["created", "revised", "document_attached", "reopened"] as const;
export const invoiceVersionChangeKindSchema = z.enum(INVOICE_VERSION_CHANGE_KINDS);
export type InvoiceVersionChangeKind = z.infer<typeof invoiceVersionChangeKindSchema>;

export const invoiceVersionDocSchema = z
  .object({
    invoiceRef: nonEmpty,
    version: z.number().int().min(1).max(MAX_INVOICE_VERSIONS),
    payablePin: invoicePayablePinSchema,
    // The commercial/business-key identity of section 6 - null while the supplier invoice number
    // is not yet known (an incomplete draft). Duplicate protection strengthens once it is set (see
    // ids.ts's normalizedInvoiceNumberKey).
    externalInvoiceNumber: shortText(100).nullable(),
    normalizedInvoiceNumberKey: z.string().min(1).max(300).nullable(),
    invoiceDate: utcDateSchema.nullable(),
    receivedDate: utcDateSchema.nullable(),
    currency: currencyCodeSchema.nullable(),
    subtotalMinor: amountMinorSchema.nullable(),
    taxLines: z.array(invoiceTaxLineSchema).max(MAX_INVOICE_TAX_LINES),
    declaredTotalMinor: amountMinorSchema.nullable(),
    dueDate: utcDateSchema.nullable(),
    document: invoiceDocumentRefSchema.nullable(),
    reconciliation: invoiceReconciliationResultSchema,
    // Step 16C: the Invoice's own extracted/declared payee name - ordinary, non-restricted (see
    // extraction/field-extractors.ts's supplierNameField). Applied by the client from an extraction
    // proposal, exactly like externalInvoiceNumber/invoiceDate above - never invented server-side.
    extractedPayeeName: shortText(200).nullable().default(null),
    // Step 16C section 8/13: the server-authoritative payee identity comparison for THIS exact
    // version - pinned by construction (a new version always computes its own fresh result; an
    // earlier version's result is never rewritten). Null only when the comparison has not been
    // computed at all (never used to mean "no evidence" - that is INSUFFICIENT_EVIDENCE).
    payeeIdentity: payeeIdentityMatchResultSchema.nullable().default(null),
    changeKind: invoiceVersionChangeKindSchema,
    reason: shortText(1000).nullable(),
    createdAt: isoTimestamp,
    createdByUserRef: nonEmpty,
  })
  .strict()
  .superRefine((doc, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
    if (doc.version === 1 && doc.changeKind !== "created") issue("changeKind", "Version 1 is the creation.");
    if (doc.version > 1 && doc.changeKind === "created") issue("changeKind", "Only version 1 is the creation.");
    if (doc.externalInvoiceNumber === null && doc.normalizedInvoiceNumberKey !== null) issue("normalizedInvoiceNumberKey", "There is no normalized key without a declared invoice number.");
    if (doc.externalInvoiceNumber !== null && doc.normalizedInvoiceNumberKey === null) issue("normalizedInvoiceNumberKey", "A declared invoice number always has its normalized key.");
    const taxTotal = doc.taxLines.reduce((sum, line) => sum + line.amountMinor, 0);
    if (doc.subtotalMinor !== null && doc.declaredTotalMinor !== null) {
      const arithmeticOk = doc.subtotalMinor + taxTotal === doc.declaredTotalMinor;
      const inconsistentFinding = doc.reconciliation.findings.some((finding) => finding.code === "ARITHMETIC_INCONSISTENT");
      if (!arithmeticOk && !inconsistentFinding) issue("reconciliation", "An arithmetic mismatch between subtotal+tax and the declared total is always surfaced as a finding.");
    }
  });
export type InvoiceVersionDoc = z.infer<typeof invoiceVersionDocSchema>;

// --- Mismatch override (section 16) - pinned on the HEAD to the exact version it was accepted for --------------------------------
export const invoiceMismatchOverrideSchema = z.object({ forVersion: z.number().int().min(1), reason: shortText(1000), actorUserRef: nonEmpty, at: isoTimestamp }).strict();
export type InvoiceMismatchOverride = z.infer<typeof invoiceMismatchOverrideSchema>;

// --- Head list projection --------------------------------------------------------------------------------------------------
export const invoiceHeadDisplaySchema = z
  .object({
    counterpartyName: shortText(200),
    counterpartyNameLower: shortText(200),
    declaredTotalMinor: amountMinorSchema.nullable(),
    reconciliationState: invoiceReconciliationStateSchema,
    externalInvoiceNumber: shortText(100).nullable(),
    projectedAt: isoTimestamp,
  })
  .strict();
export type InvoiceHeadDisplay = z.infer<typeof invoiceHeadDisplaySchema>;

// --- Head document (financeInvoices/{invoiceRef}) ------------------------------------------------------------------------------
export const invoiceHeadDocSchema = z
  .object({
    invoiceRef: nonEmpty,
    docVersion: z.number().int().min(1),

    payableRef: refString,
    counterpartyType: invoiceCounterpartyTypeSchema,
    counterpartyRef: refString,
    periodKey: periodKeySchema,
    periodStart: utcDateSchema,
    periodEnd: utcDateSchema,
    currency: currencyCodeSchema.nullable(),

    externalInvoiceNumber: shortText(100).nullable(),
    normalizedInvoiceNumberKey: z.string().min(1).max(300).nullable(),

    ownerUid: nonEmpty.nullable().default(null),
    regionIds: z.array(nonEmpty).max(50).default([]),
    teamIds: z.array(nonEmpty).max(50).default([]),
    partnerUid: nonEmpty.nullable().default(null),
    vendorUid: nonEmpty.nullable().default(null),

    status: invoiceStatusSchema,
    latestVersion: z.number().int().min(1).max(MAX_INVOICE_VERSIONS),
    submittedVersion: z.number().int().min(1).max(MAX_INVOICE_VERSIONS).nullable().default(null),
    submittedAt: isoTimestamp.nullable().default(null),
    submittedByUserRef: nonEmpty.nullable().default(null),
    approvedVersion: z.number().int().min(1).max(MAX_INVOICE_VERSIONS).nullable().default(null),
    approvedAt: isoTimestamp.nullable().default(null),
    approvedByUserRef: nonEmpty.nullable().default(null),
    rejectedVersion: z.number().int().min(1).max(MAX_INVOICE_VERSIONS).nullable().default(null),
    rejectedAt: isoTimestamp.nullable().default(null),
    rejectedByUserRef: nonEmpty.nullable().default(null),
    rejectionReason: shortText(1000).nullable().default(null),
    voidedAt: isoTimestamp.nullable().default(null),
    voidedByUserRef: nonEmpty.nullable().default(null),
    voidReason: shortText(1000).nullable().default(null),

    // Accepted mismatch, pinned to the exact version it was accepted for (section 16). Cleared
    // whenever a NEW version is created (an unreviewed version carries no override).
    mismatchOverride: invoiceMismatchOverrideSchema.nullable().default(null),
    // Step 16C section 11/13: the accepted PAYEE IDENTITY mismatch/review, pinned to the exact
    // version it was accepted for - its own field, deliberately never folded into mismatchOverride
    // above (a payee identity resolution is a distinct decision from an amount mismatch override,
    // gated by its own narrow action - see finance-invoices-gate.ts). Cleared on every new version.
    payeeMismatchOverride: invoiceMismatchOverrideSchema.nullable().default(null),

    display: invoiceHeadDisplaySchema,

    createdAt: isoTimestamp,
    createdByUserRef: nonEmpty,
    updatedAt: isoTimestamp,
    updatedByUserRef: nonEmpty,
  })
  .strict()
  .superRefine((head, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
    if (head.counterpartyType === "PARTNER" && (!head.partnerUid || head.vendorUid)) issue("partnerUid", "A partner invoice is scoped by exactly a partnerUid.");
    if (head.counterpartyType === "VENDOR" && (!head.vendorUid || head.partnerUid)) issue("vendorUid", "A vendor invoice is scoped by exactly a vendorUid.");
    if (head.status === "SUBMITTED" && (head.submittedVersion === null || head.submittedAt === null || head.submittedByUserRef === null)) issue("submittedVersion", "A submitted invoice pins its version, time and actor.");
    if (head.status === "APPROVED" && (head.approvedVersion === null || head.approvedAt === null || head.approvedByUserRef === null)) issue("approvedVersion", "An approved invoice pins its version, time and actor.");
    if (head.status !== "APPROVED" && head.approvedVersion !== null) issue("approvedVersion", "Only an approved invoice pins an approved version.");
    if (head.status === "REJECTED" && (head.rejectedVersion === null || head.rejectedAt === null || head.rejectedByUserRef === null || head.rejectionReason === null)) {
      issue("rejectionReason", "A rejected invoice records when, by whom, which version and why.");
    }
    if (head.status !== "REJECTED" && (head.rejectedAt !== null || head.rejectionReason !== null)) issue("rejectionReason", "Only a rejected invoice carries a rejection reason.");
    if (head.status === "VOID" && (head.voidedAt === null || head.voidedByUserRef === null || head.voidReason === null)) issue("voidReason", "A voided invoice records when, by whom and why.");
    if (head.status !== "VOID" && (head.voidedAt !== null || head.voidReason !== null)) issue("voidReason", "Only a voided invoice carries a void reason.");
    if (head.mismatchOverride !== null && head.mismatchOverride.forVersion > head.latestVersion) issue("mismatchOverride", "An accepted mismatch cannot name a version beyond the invoice's latest.");
    if (head.payeeMismatchOverride !== null && head.payeeMismatchOverride.forVersion > head.latestVersion) issue("payeeMismatchOverride", "An accepted payee mismatch cannot name a version beyond the invoice's latest.");
    if (head.externalInvoiceNumber === null && head.normalizedInvoiceNumberKey !== null) issue("normalizedInvoiceNumberKey", "There is no normalized key without a declared invoice number.");
    if (head.externalInvoiceNumber !== null && head.normalizedInvoiceNumberKey === null) issue("normalizedInvoiceNumberKey", "A declared invoice number always has its normalized key.");
  });
export type InvoiceHeadDoc = z.infer<typeof invoiceHeadDocSchema>;

// --- Invoice-number duplicate claim (financeInvoiceNumberClaims/{claimId}) - section 6 ------------------------------------------
// One claim per (counterparty, normalized invoice number): guards against two DIFFERENT canonical
// Invoice heads (from two different Payables) declaring the same supplier invoice number for the
// same counterparty. A revision under the SAME head that keeps or changes its own number is never a
// duplicate of itself (the claim already names that head).
export const invoiceNumberClaimDocSchema = z.object({ claimId: nonEmpty, invoiceRef: nonEmpty, counterpartyType: invoiceCounterpartyTypeSchema, counterpartyRef: refString, createdAt: isoTimestamp }).strict();
export type InvoiceNumberClaimDoc = z.infer<typeof invoiceNumberClaimDocSchema>;

// --- Append-only event history (financeInvoices/{invoiceRef}/events/{id}) ---------------------------------------------------
export const INVOICE_EVENT_KINDS = [
  "INVOICE_CREATED",
  "INVOICE_VERSION_CREATED",
  "INVOICE_DOCUMENT_ATTACHED",
  "INVOICE_SUBMITTED",
  "INVOICE_APPROVED",
  "INVOICE_REJECTED",
  "INVOICE_REOPENED",
  "INVOICE_VOIDED",
  "INVOICE_MISMATCH_ACCEPTED",
  "PAYABLE_REVISION_DETECTED",
  // Step 16C section 17: fired whenever a fresh payee identity comparison is computed for a version
  // (creation and every revision - "identity re-evaluated after Invoice revision" is simply another
  // occurrence of this same event) - its metadata carries the resulting status, so "payee mismatch
  // detected" is visible as this event's status rather than a wholly separate event kind (keeps
  // History compact, per section 17's own instruction).
  "INVOICE_PAYEE_IDENTITY_CHECKED",
  "INVOICE_PAYEE_MISMATCH_ACCEPTED",
] as const;
export const invoiceEventKindSchema = z.enum(INVOICE_EVENT_KINDS);
export type InvoiceEventKind = z.infer<typeof invoiceEventKindSchema>;

export const invoiceEventSchema = z
  .object({
    kind: invoiceEventKindSchema,
    version: z.number().int().min(1),
    actorUserRef: nonEmpty,
    // Already passed through the explicit ALLOWLIST redactor (invoice-events.ts).
    metadata: z.record(z.string(), z.unknown()).nullable(),
    requestId: nonEmpty,
    createdAt: isoTimestamp,
  })
  .strict();
export type InvoiceEvent = z.infer<typeof invoiceEventSchema>;

// --- Source-revision currency (section 15) - a Payable revision, WARNING only ------------------------------------------------
export const INVOICE_SOURCE_CURRENCY_STATES = ["CURRENT", "PAYABLE_REVISION_AVAILABLE"] as const;
export type InvoiceSourceCurrencyState = (typeof INVOICE_SOURCE_CURRENCY_STATES)[number];

// --- Result/error plumbing - same shape as Finance Payables'/Agreements' own -----------------------------------------------------
export type FinanceInvoicesDenialReason = "not_authenticated" | "feature_denied" | "action_denied" | "scope_denied" | "sensitive_denied";

export type FinanceInvoicesServiceErrorCode = "unauthorized" | "not_found" | "invalid_input" | "stale_write" | "not_ready" | "conflict" | "internal";

export type FinanceInvoicesReadinessIssue = { code: string; message: string };

export type FinanceInvoicesServiceResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: FinanceInvoicesServiceErrorCode; message: string; reason?: FinanceInvoicesDenialReason; blockers?: FinanceInvoicesReadinessIssue[] };

export type FinanceInvoicesErrorResult = Extract<FinanceInvoicesServiceResult<unknown>, { ok: false }>;

export function financeInvoicesUnauthorizedResult(reason: FinanceInvoicesDenialReason): FinanceInvoicesErrorResult {
  return { ok: false, code: "unauthorized", message: `Finance Invoices access denied (${reason}).`, reason };
}

export function financeInvoicesInvalidInputResult(message: string): FinanceInvoicesErrorResult {
  return { ok: false, code: "invalid_input", message };
}

// The ONE neutral outcome for a missing, out-of-scope or forged reference - identical in every case
// so a caller can never tell them apart.
export const NEUTRAL_NOT_FOUND_MESSAGE = "Not found.";
export function financeInvoicesNotFoundResult(message: string = NEUTRAL_NOT_FOUND_MESSAGE): FinanceInvoicesErrorResult {
  return { ok: false, code: "not_found", message };
}

export function financeInvoicesStaleResult(message = "This invoice was changed elsewhere. Reload and try again."): FinanceInvoicesErrorResult {
  return { ok: false, code: "stale_write", message };
}

export function financeInvoicesConflictResult(message: string): FinanceInvoicesErrorResult {
  return { ok: false, code: "conflict", message };
}

export function financeInvoicesNotReadyResult(message: string, blockers: FinanceInvoicesReadinessIssue[]): FinanceInvoicesErrorResult {
  return { ok: false, code: "not_ready", message, blockers };
}

export function financeInvoicesInternalResult(message = "Something went wrong."): FinanceInvoicesErrorResult {
  return { ok: false, code: "internal", message };
}

// --- Strict command INPUT schemas ------------------------------------------------------------------------------------------------
// Every object is .strict(): an unknown key (a client-supplied amount, status, scope, pin, source
// ref ...) is rejected, never silently dropped. `expectedDocVersion` is always the HEAD's
// docVersion; a mismatch is reported as stale_write.
export const invoiceRefSchema = z.string().regex(/^inv_[0-9a-f]{20}$/, "Invalid invoice reference.");
export const payableRefForInvoiceSchema = z.string().regex(/^pay_[0-9a-f]{20}$/, "Invalid payable reference.");
const expectedDocVersionSchema = z.number().int().min(1);
const reasonSchema = z.string().trim().min(3).max(1000);

// The ONLY client-named source: which Payable to invoice. The server resolves and PINS every other
// ref (Agreement, Review, counterparty, commercial period) from that Payable's own current
// READY_FOR_INVOICE version - never from the client (section 4: "the browser must not be allowed
// to substitute arbitrary source refs").
export const previewInvoiceEligibilityInputSchema = z.object({ payableRef: payableRefForInvoiceSchema }).strict();
export type PreviewInvoiceEligibilityInput = z.infer<typeof previewInvoiceEligibilityInputSchema>;

export const createInvoiceDraftInputSchema = z.object({ payableRef: payableRefForInvoiceSchema }).strict();
export type CreateInvoiceDraftInput = z.infer<typeof createInvoiceDraftInputSchema>;

export const invoiceRefParamsSchema = z.object({ invoiceRef: invoiceRefSchema }).strict();

// Declared Invoice fields a DRAFT (or, for a reopen, the caller reads current values and resubmits
// changed ones) may set. Every field is optional (an incomplete draft may set them one at a time);
// omitting a field on a revision KEEPS its previous value (see invoice-service.ts).
const invoiceTaxLineInputSchema = z.object({ label: shortText(200), ratePercentBasisPoints: z.number().int().min(0).max(1_000_000).nullable(), amountMinor: amountMinorSchema }).strict();

export const reviseInvoiceDraftInputSchema = z
  .object({
    invoiceRef: invoiceRefSchema,
    expectedDocVersion: expectedDocVersionSchema,
    externalInvoiceNumber: shortText(100).nullable().optional(),
    invoiceDate: utcDateSchema.nullable().optional(),
    receivedDate: utcDateSchema.nullable().optional(),
    currency: currencyCodeSchema.nullable().optional(),
    subtotalMinor: amountMinorSchema.nullable().optional(),
    taxLines: z.array(invoiceTaxLineInputSchema).max(MAX_INVOICE_TAX_LINES).optional(),
    declaredTotalMinor: amountMinorSchema.nullable().optional(),
    dueDate: utcDateSchema.nullable().optional(),
    // Step 16C: the client applies an extraction proposal into the draft exactly like every other
    // field above - an omitted field keeps the previous value, an explicit null clears it.
    extractedPayeeName: shortText(200).nullable().optional(),
    reason: reasonSchema,
  })
  .strict();
export type ReviseInvoiceDraftInput = z.infer<typeof reviseInvoiceDraftInputSchema>;

export const attachInvoiceDocumentInputSchema = z
  .object({
    invoiceRef: invoiceRefSchema,
    expectedDocVersion: expectedDocVersionSchema,
    fileName: shortText(300),
    // Base64-encoded EXACT original bytes - never a generated replacement.
    contentBase64: z.string().min(1),
  })
  .strict();
export type AttachInvoiceDocumentInput = z.infer<typeof attachInvoiceDocumentInputSchema>;

// Step 15C section 26: preview extraction over the EXACT bytes the browser already has locally
// (the same staged file `attachInvoiceDocumentInputSchema` would persist) - a read-only preview,
// never a mutation, so it takes no `expectedDocVersion` and writes nothing. The Invoice must still
// exist and be a DRAFT the actor may author, exactly like attaching the document itself.
export const previewInvoiceExtractionInputSchema = z.object({ invoiceRef: invoiceRefSchema, contentBase64: z.string().min(1) }).strict();
export type PreviewInvoiceExtractionInput = z.infer<typeof previewInvoiceExtractionInputSchema>;

export const reconcileInvoiceInputSchema = z.object({ invoiceRef: invoiceRefSchema }).strict();

export const submitInvoiceInputSchema = z.object({ invoiceRef: invoiceRefSchema, expectedDocVersion: expectedDocVersionSchema }).strict();
export type SubmitInvoiceInput = z.infer<typeof submitInvoiceInputSchema>;

export const approveInvoiceInputSchema = z.object({ invoiceRef: invoiceRefSchema, expectedDocVersion: expectedDocVersionSchema }).strict();
export type ApproveInvoiceInput = z.infer<typeof approveInvoiceInputSchema>;

export const rejectInvoiceInputSchema = z.object({ invoiceRef: invoiceRefSchema, expectedDocVersion: expectedDocVersionSchema, reason: reasonSchema }).strict();
export type RejectInvoiceInput = z.infer<typeof rejectInvoiceInputSchema>;

export const reopenInvoiceInputSchema = z.object({ invoiceRef: invoiceRefSchema, expectedDocVersion: expectedDocVersionSchema, reason: reasonSchema }).strict();
export type ReopenInvoiceInput = z.infer<typeof reopenInvoiceInputSchema>;

export const voidInvoiceInputSchema = z.object({ invoiceRef: invoiceRefSchema, expectedDocVersion: expectedDocVersionSchema, reason: reasonSchema }).strict();
export type VoidInvoiceInput = z.infer<typeof voidInvoiceInputSchema>;

export const acceptInvoiceMismatchInputSchema = z.object({ invoiceRef: invoiceRefSchema, expectedDocVersion: expectedDocVersionSchema, reason: reasonSchema }).strict();
export type AcceptInvoiceMismatchInput = z.infer<typeof acceptInvoiceMismatchInputSchema>;

// Step 16C section 11: "Resolve payee mismatch" - accepts the Invoice as belonging to the expected
// Payable counterparty despite a MISMATCH/REVIEW_REQUIRED payee identity result. Same shape as
// acceptInvoiceMismatchInputSchema (a reasoned, version-pinned decision), deliberately its own
// schema/action - never reused for the amount mismatch override (section 11: distinct decisions).
export const resolveInvoicePayeeMismatchInputSchema = z.object({ invoiceRef: invoiceRefSchema, expectedDocVersion: expectedDocVersionSchema, reason: reasonSchema }).strict();
export type ResolveInvoicePayeeMismatchInput = z.infer<typeof resolveInvoicePayeeMismatchInputSchema>;

export const MAX_INVOICE_PAGE_SIZE = 100;
export const DEFAULT_INVOICE_PAGE_SIZE = 25;

export const listInvoicesQuerySchema = z
  .object({
    status: invoiceStatusSchema.optional(),
    counterpartyType: invoiceCounterpartyTypeSchema.optional(),
    counterpartyRef: refString.optional(),
    commercialPeriod: periodKeySchema.optional(),
    reconciliationState: invoiceReconciliationStateSchema.optional(),
    limit: z.number().int().min(1).max(MAX_INVOICE_PAGE_SIZE).optional(),
    // An opaque, deterministic compound cursor produced by a previous page.
    cursor: z.string().min(1).max(4000).optional(),
  })
  .strict();
export type ListInvoicesQuery = z.infer<typeof listInvoicesQuerySchema>;
