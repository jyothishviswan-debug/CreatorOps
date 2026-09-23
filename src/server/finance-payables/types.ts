import { z } from "zod";

// Step 15A: the canonical Finance Payables domain.
//
// A Payable is the finance record that converts FINALIZED, Agreement-governed commercial
// evidence into an amount Finance can review and later invoice. The canonical flow is
//   Agreement -> Payable -> Invoice -> approval -> Payment(s) -> close/correction
// and this module implements exactly the Payable step. Nothing here knows about Campaigns,
// Assignments, Content or Creators - those never create a Payable and are never a commercial
// authority. The Agreement is the commercial authority; a finalized Partner Review is the
// consumed evidence.
//
// Shapes deliberately follow src/server/finance-agreements/types.ts (which itself follows
// src/server/partner-reviews/types.ts): one HEAD carrying only current workflow / indexable
// projection fields, an append-only chain of numbered, IMMUTABLE VERSIONS carrying the
// evidence snapshot and the amount breakdown, and an append-only event history.
//
// Hard rules encoded here:
//   - Money is ALWAYS integer minor units (paise-equivalent) plus an explicit ISO-4217-shaped
//     currency - the same convention as the Agreement module's own amountMinor (pinned equal by
//     a unit test). A breakdown line's amount is SIGNED; everything else is non-negative.
//   - A persisted version is never BLOCKED: blocking is a refusal to generate, never a stored
//     state (see payableDeterminationSchema's own check).
//   - No restricted identity value (PAN / Aadhaar / GST / bank), no raw full Agreement text and
//     no Partner Review source-record identifier is representable in any schema of this file.

const isoTimestamp = z.string().min(1);
const nonEmpty = z.string().min(1);
const refString = z.string().min(1).max(200);
const shortText = (max: number) => z.string().trim().min(1).max(max);

// --- Money ----------------------------------------------------------------------------------------------------------------
// Identical convention to the Agreement module's amountMinorSchema / currencyCodeSchema
// (finance-payables-static.test.ts pins both against the Agreement module's own).
export const amountMinorSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const signedAmountMinorSchema = z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
export const currencyCodeSchema = z.string().regex(/^[A-Z]{3}$/, "Expected a 3-letter uppercase currency code.");

// --- Counterparty ---------------------------------------------------------------------------------------------------------
// Never polymorphic and never a duplicate of canonical Partner / Vendor identity: a type plus the
// owning module's own opaque ref, resolved live through that module on every read and mutation.
export const PAYABLE_COUNTERPARTY_TYPES = ["PARTNER", "VENDOR"] as const;
export const payableCounterpartyTypeSchema = z.enum(PAYABLE_COUNTERPARTY_TYPES);
export type PayableCounterpartyType = z.infer<typeof payableCounterpartyTypeSchema>;

// --- Source model ---------------------------------------------------------------------------------------------------------
// PARTNER_REVIEW  the commercial evidence is a FINALIZED Partner Review version (Partner counterparties).
// AGREEMENT_ONLY  there is no Partner Review evidence for this counterparty (Vendor counterparties);
//                 the Agreement alone governs. A Partner Review is never fabricated for one.
// The list is deliberately an open enum-in-one-place: a future APPROVED source type is added here
// and nowhere else, but none is implemented now.
export const PAYABLE_SOURCE_TYPES = ["PARTNER_REVIEW", "AGREEMENT_ONLY"] as const;
export const payableSourceTypeSchema = z.enum(PAYABLE_SOURCE_TYPES);
export type PayableSourceType = z.infer<typeof payableSourceTypeSchema>;

// The one supported source type per counterparty type in this step. Partner payables are always
// Partner-review governed (a Partner month always has a review); Vendor payables never are.
export const SOURCE_TYPE_BY_COUNTERPARTY: Record<PayableCounterpartyType, PayableSourceType> = { PARTNER: "PARTNER_REVIEW", VENDOR: "AGREEMENT_ONLY" };

// --- Lifecycle ------------------------------------------------------------------------------------------------------------
// Finance-specific and deliberately small. There is NO invoice approval / payment status here, and
// READY_FOR_INVOICE is NOT called "approved" - no approval workflow exists in Payables.
export const PAYABLE_STATUSES = ["DRAFT", "READY_FOR_INVOICE", "VOID"] as const;
export const payableStatusSchema = z.enum(PAYABLE_STATUSES);
export type PayableStatus = z.infer<typeof payableStatusSchema>;

// A Payable can never accumulate an unbounded version chain.
export const MAX_PAYABLE_VERSIONS = 200;

// --- Commercial period ----------------------------------------------------------------------------------------------------
export const periodKeySchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Expected a YYYY-MM commercial period.");
export const utcDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a YYYY-MM-DD date.");

export const commercialPeriodSchema = z.object({ periodKey: periodKeySchema, periodStart: utcDateSchema, periodEnd: utcDateSchema }).strict();
export type CommercialPeriod = z.infer<typeof commercialPeriodSchema>;

// --- Immutable commercial evidence snapshot (section 6) ---------------------------------------------------------------------
// ONLY the finance-relevant confirmed evidence needed to explain the Payable later. Deliberately
// ABSENT (a static test walks this schema for them): the mandated-services clause, monetisation
// terms, renewal / notice / termination text, the counterparty contact snapshot, any identity
// status or value, and any Campaign / Assignment / Content / Analytics record identifier.
export const SNAPSHOT_SCHEMA_VERSION = 1;

export const snapshotAgreementSchema = z
  .object({
    agreementRef: refString,
    agreementVersion: z.number().int().min(1),
    agreementType: shortText(100),
    effectiveFrom: utcDateSchema,
    effectiveTo: utcDateSchema.nullable(),
  })
  .strict();

export const snapshotReviewSchema = z
  .object({
    reviewRef: refString,
    reviewVersion: z.number().int().min(1),
    finalizedAt: isoTimestamp,
    // The Review's own evidence fingerprint - lets a later reader prove which evidence this
    // Payable was built from without re-reading the Review.
    sourceFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

// Required qualifying-content obligation and its ACTUAL evidence, copied verbatim from the
// finalized Review's payment-affecting evidence. Counts and results only - never a source record.
export const snapshotQualifyingContentSchema = z
  .object({
    requiredCount: z.number().int().min(0),
    qualifyingUnit: shortText(100),
    actualQualifyingCount: z.number().int().min(0),
    variance: z.number().int(),
    evaluation: z.enum(["met", "below_requirement", "exceeded"]),
    // Always true here: the section is only snapshotted when it was Agreement-governed AND evaluated.
    affectsPayment: z.literal(true),
  })
  .strict();

export const snapshotLfcSfcSchema = z
  .object({
    ruleRef: shortText(200),
    qualifyingUnit: shortText(100),
    lfcCount: z.number().int().min(0),
    sfcCount: z.number().int().min(0),
    unclassifiedCount: z.number().int().min(0),
  })
  .strict();

// The Agreement's repeatable content-obligation rows, copied as recorded (never evaluated here).
export const snapshotContentObligationSchema = z
  .object({ obligationRef: shortText(100), label: shortText(200), quantity: z.number().int().min(0), period: shortText(60).nullable(), operationalMapping: shortText(100).nullable() })
  .strict();

export const snapshotFixedComponentSchema = z.object({ applicable: z.boolean(), amountMinor: amountMinorSchema.nullable() }).strict();
export const snapshotTransferFeeSchema = z.object({ applicable: z.boolean(), amountMinor: amountMinorSchema.nullable(), details: shortText(1000).nullable() }).strict();
export const snapshotAdvanceSchema = z.object({ applicable: z.boolean(), amountMinor: amountMinorSchema.nullable(), details: shortText(2000).nullable() }).strict();

export const snapshotIncentiveSlabSchema = z
  .object({ slabRef: shortText(100), metricId: shortText(100), lowerBound: z.number().finite().min(0), upperBound: z.number().finite().min(0).nullable(), unit: shortText(60), amountMinor: amountMinorSchema })
  .strict();

// `narrative` present = discretionary / narrative incentive language with no structured schedule.
export const snapshotIncentiveSchema = z.object({ applicable: z.boolean(), narrative: shortText(2000).nullable(), slabs: z.array(snapshotIncentiveSlabSchema).max(30) }).strict();

export const snapshotPaymentTermsSchema = z
  .object({ paymentCycle: shortText(40).nullable(), invoiceRequired: z.boolean().nullable(), invoiceDueTerms: shortText(2000).nullable(), paymentDueTerms: shortText(2000).nullable() })
  .strict();

// Warning-only by construction: `affectsPayment` is the literal false, so a target can never be
// parsed or stored as payment-affecting. A target's measured `actualValue` is analytics evidence
// and is the ONLY metric evidence an explicit incentive slab may be evaluated against.
export const snapshotPerformanceTargetSchema = z
  .object({
    targetRef: shortText(200),
    metricId: shortText(100),
    targetValue: z.number().finite(),
    unit: shortText(60),
    actualValue: z.number().finite().nullable(),
    evaluation: z.enum(["met", "not_met", "unavailable"]),
    affectsPayment: z.literal(false),
  })
  .strict();

export const MAX_SNAPSHOT_WARNINGS = 30;

export const payableSourceSnapshotSchema = z
  .object({
    schemaVersion: z.literal(SNAPSHOT_SCHEMA_VERSION),
    counterparty: z.object({ type: payableCounterpartyTypeSchema, ref: refString }).strict(),
    commercialPeriod: commercialPeriodSchema,
    sourceType: payableSourceTypeSchema,
    agreement: snapshotAgreementSchema,
    review: snapshotReviewSchema.nullable(),
    currency: currencyCodeSchema.nullable(),
    qualifyingContent: snapshotQualifyingContentSchema.nullable(),
    lfcSfc: snapshotLfcSfcSchema.nullable(),
    contentObligations: z.array(snapshotContentObligationSchema).max(20),
    fixedComponent: snapshotFixedComponentSchema.nullable(),
    accountTransferFee: snapshotTransferFeeSchema.nullable(),
    advancePayment: snapshotAdvanceSchema.nullable(),
    incentive: snapshotIncentiveSchema.nullable(),
    paymentTerms: snapshotPaymentTermsSchema,
    performanceTargets: z.array(snapshotPerformanceTargetSchema).max(12),
    // Typed, human-readable ambiguities noticed while capturing the evidence.
    warnings: z.array(shortText(300)).max(MAX_SNAPSHOT_WARNINGS),
    capturedAt: isoTimestamp,
  })
  .strict()
  .superRefine((snapshot, ctx) => {
    if (snapshot.sourceType === "PARTNER_REVIEW" && snapshot.review === null) ctx.addIssue({ code: "custom", path: ["review"], message: "A Partner-review payable pins the finalized Review it consumed." });
    if (snapshot.sourceType === "AGREEMENT_ONLY" && snapshot.review !== null) ctx.addIssue({ code: "custom", path: ["review"], message: "An agreement-only payable never carries Partner Review evidence." });
  });
export type PayableSourceSnapshot = z.infer<typeof payableSourceSnapshotSchema>;

// --- Amount breakdown (section 8) -------------------------------------------------------------------------------------------
export const PAYABLE_LINE_CATEGORIES = ["BASE_FIXED", "TRANSFER_FEE", "INCENTIVE", "ADVANCE_ADJUSTMENT", "MANUAL_ADJUSTMENT"] as const;
export const payableLineCategorySchema = z.enum(PAYABLE_LINE_CATEGORIES);
export type PayableLineCategory = z.infer<typeof payableLineCategorySchema>;

export const PAYABLE_LINE_SOURCES = ["AGREEMENT", "PARTNER_REVIEW", "MANUAL"] as const;
export const payableLineSourceSchema = z.enum(PAYABLE_LINE_SOURCES);
export type PayableLineSource = z.infer<typeof payableLineSourceSchema>;

export const MAX_PAYABLE_LINES = 60;

export const payableLineSchema = z
  .object({
    lineRef: z.string().regex(/^pl_[0-9a-f]{20}$/, "Invalid payable line reference."),
    label: shortText(200),
    category: payableLineCategorySchema,
    // SIGNED integer minor units: a deduction is negative, an addition positive.
    amountMinorSigned: signedAmountMinorSchema,
    source: payableLineSourceSchema,
    // "agr_...@3" / "pr_...@2" - the exact pinned source version the line is derived from.
    sourceRef: refString.nullable(),
    // The contract basis / justification. For a manual line this is what the actor typed.
    reason: shortText(1000),
    // Manual lines only: who added it, when.
    actor: z.object({ userRef: nonEmpty, at: isoTimestamp }).strict().nullable(),
    // Manual lines only: the FINANCE_REVIEW_REQUIRED item this line resolves, when it resolves one.
    resolvesCode: shortText(100).nullable(),
  })
  .strict()
  .superRefine((line, ctx) => {
    const manual = line.category === "MANUAL_ADJUSTMENT";
    if (manual && (line.source !== "MANUAL" || line.actor === null)) ctx.addIssue({ code: "custom", path: ["actor"], message: "A manual adjustment records its actor and is sourced MANUAL." });
    if (!manual && (line.source === "MANUAL" || line.actor !== null || line.resolvesCode !== null)) ctx.addIssue({ code: "custom", path: ["category"], message: "Only a manual adjustment carries actor metadata or resolves a review item." });
  });
export type PayableLine = z.infer<typeof payableLineSchema>;

// --- Amount determination (section 7) ------------------------------------------------------------------------------------------
export const PAYABLE_DETERMINATION_STATES = ["DETERMINISTIC", "FINANCE_REVIEW_REQUIRED", "BLOCKED"] as const;
export const payableDeterminationStateSchema = z.enum(PAYABLE_DETERMINATION_STATES);
export type PayableDeterminationState = z.infer<typeof payableDeterminationStateSchema>;

// The CLOSED set of reasons Finance must confirm something by hand. Each is a fact about the
// confirmed Agreement terms or the pinned evidence, never a guess.
export const PAYABLE_REVIEW_CODES = [
  // The Agreement states a discretionary / narrative incentive with no structured schedule.
  "NARRATIVE_INCENTIVE",
  // An advance exists but the Agreement does not state how it applies to this period.
  "ADVANCE_APPLICATION_UNSPECIFIED",
  // A transfer fee exists but the Agreement does not state how it applies to a payment.
  "TRANSFER_FEE_APPLICATION_UNSPECIFIED",
  // A structured incentive slab names a metric the pinned evidence does not measure.
  "INCENTIVE_METRIC_EVIDENCE_MISSING",
  // Several slabs of one metric match the measured value, or it falls in a gap between slabs.
  "INCENTIVE_THRESHOLD_AMBIGUOUS",
  // Qualifying content was under-delivered and the Agreement states no payment consequence.
  // The fixed fee is NEVER reduced for this - Finance simply has to look.
  "UNDER_DELIVERY_NO_STATED_CONSEQUENCE",
] as const;
export const payableReviewCodeSchema = z.enum(PAYABLE_REVIEW_CODES);
export type PayableReviewCode = z.infer<typeof payableReviewCodeSchema>;

// The CLOSED set of reasons generation is refused outright.
export const PAYABLE_BLOCKED_CODES = [
  "COUNTERPARTY_UNRESOLVED",
  "REVIEW_NOT_FOUND",
  "REVIEW_NOT_FINALIZED",
  "AGREEMENT_SOURCE_CONFLICT",
  "AGREEMENT_VERSION_UNAVAILABLE",
  "AGREEMENT_COUNTERPARTY_MISMATCH",
  "SOURCE_VERSION_INVALID",
  "CURRENCY_MISSING",
] as const;
export const payableBlockedCodeSchema = z.enum(PAYABLE_BLOCKED_CODES);
export type PayableBlockedCode = z.infer<typeof payableBlockedCodeSchema>;

export const payableUnresolvedItemSchema = z.object({ code: payableReviewCodeSchema, message: shortText(300), sourceRef: refString.nullable() }).strict();
export type PayableUnresolvedItem = z.infer<typeof payableUnresolvedItemSchema>;

export const payableDeterminationSchema = z
  .object({
    state: payableDeterminationStateSchema,
    unresolved: z.array(payableUnresolvedItemSchema).max(30),
    blocked: z.array(z.object({ code: payableBlockedCodeSchema, message: shortText(300) }).strict()).max(10),
    warnings: z.array(shortText(300)).max(MAX_SNAPSHOT_WARNINGS),
  })
  .strict()
  .superRefine((determination, ctx) => {
    if (determination.state === "BLOCKED" && determination.blocked.length === 0) ctx.addIssue({ code: "custom", path: ["blocked"], message: "A BLOCKED determination states why." });
    if (determination.state !== "BLOCKED" && determination.blocked.length > 0) ctx.addIssue({ code: "custom", path: ["blocked"], message: "Only a BLOCKED determination carries blockers." });
    if (determination.state === "DETERMINISTIC" && determination.unresolved.length > 0) ctx.addIssue({ code: "custom", path: ["unresolved"], message: "A DETERMINISTIC determination has nothing unresolved." });
    if (determination.state === "FINANCE_REVIEW_REQUIRED" && determination.unresolved.length === 0) ctx.addIssue({ code: "custom", path: ["unresolved"], message: "A FINANCE_REVIEW_REQUIRED determination names what needs confirming." });
  });
export type PayableDetermination = z.infer<typeof payableDeterminationSchema>;

// --- Version document (financePayables/{payableRef}/versions/{n}) ---------------------------------------------------------------
// IMMUTABLE. Created with tx.create and never rewritten - every change creates the NEXT version.
export const PAYABLE_VERSION_CHANGE_KINDS = ["created", "revised", "adjustment_added", "adjustment_removed"] as const;
export const payableVersionChangeKindSchema = z.enum(PAYABLE_VERSION_CHANGE_KINDS);
export type PayableVersionChangeKind = z.infer<typeof payableVersionChangeKindSchema>;

export const payableVersionDocSchema = z
  .object({
    payableRef: nonEmpty,
    version: z.number().int().min(1).max(MAX_PAYABLE_VERSIONS),
    // The full idempotency/business key (see payableBusinessKey) the evidence of THIS version
    // pins: counterparty, period, Agreement ref/version, Review ref/version, source type.
    businessKey: z.string().regex(/^[0-9a-f]{64}$/),
    snapshot: payableSourceSnapshotSchema,
    determination: payableDeterminationSchema,
    lines: z.array(payableLineSchema).max(MAX_PAYABLE_LINES),
    totalAmountMinorSigned: signedAmountMinorSchema,
    currency: currencyCodeSchema,
    // What remains for Finance to confirm on THIS version: the determination's unresolved items
    // minus the ones a manual adjustment in `lines` explicitly resolves.
    openReviewCodes: z.array(payableReviewCodeSchema).max(30),
    changeKind: payableVersionChangeKindSchema,
    reason: shortText(1000).nullable(),
    createdAt: isoTimestamp,
    createdByUserRef: nonEmpty,
  })
  .strict()
  .superRefine((doc, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
    // Blocking is a refusal to generate, never a stored state.
    if (doc.determination.state === "BLOCKED") issue("determination", "A blocked determination is never persisted as a payable version.");
    if (doc.version === 1 && doc.changeKind !== "created") issue("changeKind", "Version 1 is the creation.");
    if (doc.version > 1 && doc.changeKind === "created") issue("changeKind", "Only version 1 is the creation.");
    const total = doc.lines.reduce((sum, line) => sum + line.amountMinorSigned, 0);
    if (total !== doc.totalAmountMinorSigned) issue("totalAmountMinorSigned", "The total must equal the sum of the breakdown lines.");
    const refs = doc.lines.map((line) => line.lineRef);
    if (new Set(refs).size !== refs.length) issue("lines", "Breakdown line refs must be unique.");
    if (doc.snapshot.currency !== doc.currency) issue("currency", "The version currency must equal the snapshot's currency.");
    const resolved = new Set(doc.lines.map((line) => line.resolvesCode).filter((code): code is string => code !== null));
    const expected = doc.determination.unresolved.map((item) => item.code).filter((code) => !resolved.has(code));
    if (JSON.stringify([...doc.openReviewCodes].sort()) !== JSON.stringify([...new Set(expected)].sort())) issue("openReviewCodes", "openReviewCodes must be the unresolved determination items no manual adjustment resolves.");
  });
export type PayableVersionDoc = z.infer<typeof payableVersionDocSchema>;

// --- Head list projection --------------------------------------------------------------------------------------------------
// Written by every mutation that writes the head, in the SAME transaction. Never authorization and
// never financial truth (the version documents are) - it serves the bounded workspace list only.
export const payableHeadDisplaySchema = z
  .object({
    counterpartyName: shortText(200),
    counterpartyNameLower: shortText(200),
    totalAmountMinorSigned: signedAmountMinorSchema,
    determinationState: payableDeterminationStateSchema,
    openReviewCount: z.number().int().min(0).max(1000),
    lineCount: z.number().int().min(0).max(MAX_PAYABLE_LINES),
    projectedAt: isoTimestamp,
  })
  .strict();
export type PayableHeadDisplay = z.infer<typeof payableHeadDisplaySchema>;

// --- Head document (financePayables/{payableRef}) ------------------------------------------------------------------------------
// Current workflow / indexable projection fields ONLY. Every immutable evidence and money fact
// lives on the version documents. The scope fields are a point-in-time copy of the counterparty's
// scope and serve bounded scoped list queries only - the LIVE Partner / Vendor is the authority on
// every detail and mutation read.
export const payableHeadDocSchema = z
  .object({
    payableRef: nonEmpty,
    // Optimistic-concurrency counter, bumped on every accepted change.
    docVersion: z.number().int().min(1),

    counterpartyType: payableCounterpartyTypeSchema,
    counterpartyRef: refString,
    periodKey: periodKeySchema,
    periodStart: utcDateSchema,
    periodEnd: utcDateSchema,
    currency: currencyCodeSchema,

    sourceType: payableSourceTypeSchema,
    agreementRef: refString,
    agreementVersion: z.number().int().min(1),
    sourceReviewRef: refString.nullable(),
    sourceReviewVersion: z.number().int().min(1).nullable(),
    businessKey: z.string().regex(/^[0-9a-f]{64}$/),

    ownerUid: nonEmpty.nullable().default(null),
    regionIds: z.array(nonEmpty).max(50).default([]),
    teamIds: z.array(nonEmpty).max(50).default([]),
    partnerUid: nonEmpty.nullable().default(null),
    vendorUid: nonEmpty.nullable().default(null),

    status: payableStatusSchema,
    latestVersion: z.number().int().min(1).max(MAX_PAYABLE_VERSIONS),
    // The exact immutable version a future Invoice will consume. Set when the payable is moved to
    // READY_FOR_INVOICE and cleared when a revision reopens it as DRAFT.
    readyVersion: z.number().int().min(1).max(MAX_PAYABLE_VERSIONS).nullable().default(null),
    readyAt: isoTimestamp.nullable().default(null),
    readyByUserRef: nonEmpty.nullable().default(null),
    voidedAt: isoTimestamp.nullable().default(null),
    voidedByUserRef: nonEmpty.nullable().default(null),
    voidReason: shortText(1000).nullable().default(null),

    display: payableHeadDisplaySchema,

    createdAt: isoTimestamp,
    createdByUserRef: nonEmpty,
    updatedAt: isoTimestamp,
    updatedByUserRef: nonEmpty,
  })
  .strict()
  .superRefine((head, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
    if (head.counterpartyType === "PARTNER" && (!head.partnerUid || head.vendorUid)) issue("partnerUid", "A partner payable is scoped by exactly a partnerUid.");
    if (head.counterpartyType === "VENDOR" && (!head.vendorUid || head.partnerUid)) issue("vendorUid", "A vendor payable is scoped by exactly a vendorUid.");
    if (head.sourceType === "PARTNER_REVIEW" && (head.sourceReviewRef === null || head.sourceReviewVersion === null)) issue("sourceReviewRef", "A Partner-review payable names the finalized Review it consumed.");
    if (head.sourceType === "AGREEMENT_ONLY" && (head.sourceReviewRef !== null || head.sourceReviewVersion !== null)) issue("sourceReviewRef", "An agreement-only payable names no Partner Review.");
    if (head.status === "READY_FOR_INVOICE" && (head.readyVersion === null || head.readyAt === null || head.readyByUserRef === null)) issue("readyVersion", "A payable ready for invoicing pins its version, time and actor.");
    if (head.status !== "READY_FOR_INVOICE" && head.readyVersion !== null) issue("readyVersion", "Only a payable ready for invoicing pins a ready version.");
    if (head.status === "VOID" && (head.voidedAt === null || head.voidedByUserRef === null || head.voidReason === null)) issue("voidReason", "A voided payable records when, by whom and why.");
    if (head.status !== "VOID" && (head.voidedAt !== null || head.voidReason !== null)) issue("voidReason", "Only a voided payable carries a void reason.");
    if (head.readyVersion !== null && head.readyVersion > head.latestVersion) issue("readyVersion", "readyVersion cannot exceed latestVersion.");
  });
export type PayableHeadDoc = z.infer<typeof payableHeadDocSchema>;

// --- Append-only event history (financePayables/{payableRef}/events/{id}) ---------------------------------------------------
export const PAYABLE_EVENT_KINDS = [
  "PAYABLE_CREATED",
  "PAYABLE_VERSION_CREATED",
  "MANUAL_ADJUSTMENT_ADDED",
  "MANUAL_ADJUSTMENT_REMOVED",
  "PAYABLE_READY_FOR_INVOICE",
  "PAYABLE_VOIDED",
  "SOURCE_REVISION_DETECTED",
] as const;
export const payableEventKindSchema = z.enum(PAYABLE_EVENT_KINDS);
export type PayableEventKind = z.infer<typeof payableEventKindSchema>;

export const payableEventSchema = z
  .object({
    kind: payableEventKindSchema,
    version: z.number().int().min(1),
    actorUserRef: nonEmpty,
    // Already passed through the explicit ALLOWLIST redactor (payable-events.ts).
    metadata: z.record(z.string(), z.unknown()).nullable(),
    requestId: nonEmpty,
    createdAt: isoTimestamp,
  })
  .strict();
export type PayableEvent = z.infer<typeof payableEventSchema>;

// --- Source-revision currency (section 16) -----------------------------------------------------------------------------------
// A WARNING only: comparing pinned source versions against current ones never mutates the payable.
export const PAYABLE_SOURCE_CURRENCY_STATES = ["CURRENT", "AGREEMENT_REVISION_AVAILABLE", "REVIEW_REVISION_AVAILABLE", "MULTIPLE_SOURCE_REVISIONS_AVAILABLE"] as const;
export type PayableSourceCurrencyState = (typeof PAYABLE_SOURCE_CURRENCY_STATES)[number];

// --- Result/error plumbing - same shape as Finance Agreements' own -------------------------------------------------------------
export type FinancePayablesDenialReason = "not_authenticated" | "feature_denied" | "action_denied" | "scope_denied" | "sensitive_denied";

export type FinancePayablesServiceErrorCode = "unauthorized" | "not_found" | "invalid_input" | "stale_write" | "not_ready" | "conflict" | "internal";

export type FinancePayablesReadinessIssue = { code: string; message: string };

export type FinancePayablesServiceResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: FinancePayablesServiceErrorCode; message: string; reason?: FinancePayablesDenialReason; blockers?: FinancePayablesReadinessIssue[] };

export type FinancePayablesErrorResult = Extract<FinancePayablesServiceResult<unknown>, { ok: false }>;

export function financePayablesUnauthorizedResult(reason: FinancePayablesDenialReason): FinancePayablesErrorResult {
  return { ok: false, code: "unauthorized", message: `Finance Payables access denied (${reason}).`, reason };
}

export function financePayablesInvalidInputResult(message: string): FinancePayablesErrorResult {
  return { ok: false, code: "invalid_input", message };
}

// The ONE neutral outcome for a missing, out-of-scope or forged reference - identical in every
// case so a caller can never tell them apart.
export const NEUTRAL_NOT_FOUND_MESSAGE = "Not found.";
export function financePayablesNotFoundResult(message: string = NEUTRAL_NOT_FOUND_MESSAGE): FinancePayablesErrorResult {
  return { ok: false, code: "not_found", message };
}

export function financePayablesStaleResult(message = "This payable was changed elsewhere. Reload and try again."): FinancePayablesErrorResult {
  return { ok: false, code: "stale_write", message };
}

export function financePayablesConflictResult(message: string): FinancePayablesErrorResult {
  return { ok: false, code: "conflict", message };
}

export function financePayablesNotReadyResult(message: string, blockers: FinancePayablesReadinessIssue[]): FinancePayablesErrorResult {
  return { ok: false, code: "not_ready", message, blockers };
}

export function financePayablesInternalResult(message = "Something went wrong."): FinancePayablesErrorResult {
  return { ok: false, code: "internal", message };
}

// --- Strict command INPUT schemas ------------------------------------------------------------------------------------------------
// Every object is .strict(): an unknown key (a client-supplied amount, status, scope, snapshot,
// agreement version ...) is rejected, never silently dropped. `expectedDocVersion` is always the
// HEAD's docVersion; a mismatch is reported as stale_write.
export const payableRefSchema = z.string().regex(/^pay_[0-9a-f]{20}$/, "Invalid payable reference.");
export const payableLineRefSchema = z.string().regex(/^pl_[0-9a-f]{20}$/, "Invalid payable line reference.");
const expectedDocVersionSchema = z.number().int().min(1);
const reasonSchema = z.string().trim().min(3).max(1000);

// The commercial basis a caller names. The Agreement, its version and (for a Partner) the finalized
// Review are ALWAYS resolved server-side - a client may never name a version.
export const payableSourceRequestSchema = z
  .object({
    counterpartyType: payableCounterpartyTypeSchema,
    counterpartyRef: refString,
    commercialPeriod: periodKeySchema,
    // VENDOR only: which Agreement of that Vendor governs. Rejected for a PARTNER request (the
    // finalized Review names the governing Agreement).
    agreementRef: z.string().regex(/^agr_[0-9a-f]{20}$/, "Invalid agreement reference.").optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.counterpartyType === "VENDOR" && input.agreementRef === undefined) ctx.addIssue({ code: "custom", path: ["agreementRef"], message: "A vendor payable names the Agreement that governs the period." });
    if (input.counterpartyType === "PARTNER" && input.agreementRef !== undefined) ctx.addIssue({ code: "custom", path: ["agreementRef"], message: "A partner payable's Agreement comes from the finalized Partner Review; it is never client-supplied." });
  });
export type PayableSourceRequest = z.infer<typeof payableSourceRequestSchema>;

export const createPayableInputSchema = payableSourceRequestSchema;
export type CreatePayableInput = PayableSourceRequest;

export const payableRefParamsSchema = z.object({ payableRef: payableRefSchema }).strict();

export const revisePayableInputSchema = z
  .object({
    payableRef: payableRefSchema,
    expectedDocVersion: expectedDocVersionSchema,
    // true re-pins the CURRENT source versions (an explicit, audited source refresh); false keeps
    // the pinned evidence and only recomputes the breakdown over it.
    refreshSource: z.boolean().default(false),
    reason: reasonSchema,
  })
  .strict();
export type RevisePayableInput = z.infer<typeof revisePayableInputSchema>;

export const addPayableAdjustmentInputSchema = z
  .object({
    payableRef: payableRefSchema,
    expectedDocVersion: expectedDocVersionSchema,
    label: shortText(200),
    // SIGNED: negative deducts, positive adds. 0 records a Finance confirmation that an item has
    // no financial effect (it still needs a reason, and it is still audit-logged).
    amountMinorSigned: signedAmountMinorSchema,
    reason: reasonSchema,
    resolvesCode: payableReviewCodeSchema.optional(),
  })
  .strict();
export type AddPayableAdjustmentInput = z.infer<typeof addPayableAdjustmentInputSchema>;

export const removePayableAdjustmentInputSchema = z.object({ payableRef: payableRefSchema, expectedDocVersion: expectedDocVersionSchema, lineRef: payableLineRefSchema, reason: reasonSchema }).strict();
export type RemovePayableAdjustmentInput = z.infer<typeof removePayableAdjustmentInputSchema>;

export const markPayableReadyInputSchema = z.object({ payableRef: payableRefSchema, expectedDocVersion: expectedDocVersionSchema }).strict();
export type MarkPayableReadyInput = z.infer<typeof markPayableReadyInputSchema>;

export const voidPayableInputSchema = z.object({ payableRef: payableRefSchema, expectedDocVersion: expectedDocVersionSchema, reason: reasonSchema }).strict();
export type VoidPayableInput = z.infer<typeof voidPayableInputSchema>;

export const MAX_PAYABLE_PAGE_SIZE = 100;
export const DEFAULT_PAYABLE_PAGE_SIZE = 25;

export const listPayablesQuerySchema = z
  .object({
    status: payableStatusSchema.optional(),
    counterpartyType: payableCounterpartyTypeSchema.optional(),
    counterpartyRef: refString.optional(),
    commercialPeriod: periodKeySchema.optional(),
    limit: z.number().int().min(1).max(MAX_PAYABLE_PAGE_SIZE).optional(),
    // An opaque, deterministic compound cursor produced by a previous page.
    cursor: z.string().min(1).max(4000).optional(),
  })
  .strict();
export type ListPayablesQuery = z.infer<typeof listPayablesQuerySchema>;
