import { z } from "zod";

import { agreementFieldKeySchema, AGREEMENT_FIELD_BY_KEY, AGREEMENT_FIELD_DECISIONS, checkFieldDecisionValue, type AgreementFieldKey } from "./fields";
import { agreementTypeSchema, confirmedAgreementTermsSchema, contactSnapshotSchema, identityStatusSnapshotSchema, utcDateSchema } from "./terms";

// Step 14A: the canonical Finance Agreements domain. One logical Agreement
// ("head") = one Partner OR Vendor counterparty. Each head owns an append-only
// chain of numbered VERSIONS (immutable once confirmed) and an append-only event
// history. Nothing here knows about Campaigns, Assignments, Deliverables or
// Creators, and no restricted identity VALUE (PAN / Aadhaar / GST / bank) is
// representable in any schema of this file - identity appears only as status.
//
// Follows the contract shape of src/server/partner-reviews/types.ts deliberately.

export * from "./terms";
export {
  AGREEMENT_FIELD_KEYS,
  AGREEMENT_FIELD_DECISIONS,
  agreementFieldKeySchema,
  type AgreementFieldKey,
  type AgreementFieldDecisionKind,
} from "./fields";

const isoTimestamp = z.string().min(1);
const nonEmpty = z.string().min(1);
const refString = z.string().min(1).max(200);

// --- Lifecycle ----------------------------------------------------------------------------------------------------------
// Version: DRAFT -> ACTIVE <-> SUSPENDED -> ENDED, ACTIVE|SUSPENDED -> SUPERSEDED.
// The graph lives in @/server/authz/lifecycle's FINANCE_AGREEMENT_LIFECYCLE_TRANSITIONS.
// "Confirmed" is a field on a DRAFT version (`confirmation`), never a status.
export const AGREEMENT_VERSION_STATUSES = ["DRAFT", "ACTIVE", "SUSPENDED", "ENDED", "SUPERSEDED"] as const;
export const agreementVersionStatusSchema = z.enum(AGREEMENT_VERSION_STATUSES);
export type AgreementVersionStatus = z.infer<typeof agreementVersionStatusSchema>;

// Head status = the status of the GOVERNING version (DRAFT while none was ever activated).
export const AGREEMENT_HEAD_STATUSES = ["DRAFT", "ACTIVE", "SUSPENDED", "ENDED"] as const;
export const agreementHeadStatusSchema = z.enum(AGREEMENT_HEAD_STATUSES);
export type AgreementHeadStatus = z.infer<typeof agreementHeadStatusSchema>;

// An Agreement can never accumulate an unbounded revision chain.
export const MAX_AGREEMENT_VERSIONS = 200;

export const AGREEMENT_SOURCE_MODES = ["MANUAL", "EXTRACTED", "MIXED"] as const;
export const agreementSourceModeSchema = z.enum(AGREEMENT_SOURCE_MODES);
export type AgreementSourceMode = z.infer<typeof agreementSourceModeSchema>;

// --- Counterparty --------------------------------------------------------------------------------------------------------
export const COUNTERPARTY_TYPES = ["PARTNER", "VENDOR"] as const;
export const counterpartyTypeSchema = z.enum(COUNTERPARTY_TYPES);
export type CounterpartyType = z.infer<typeof counterpartyTypeSchema>;

// What the CLIENT may name (strict: a client-supplied platformScope / uid / scope is rejected).
export const MAX_PARTNER_ACCOUNT_REFS = 50;
export const agreementCounterpartyInputSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("PARTNER"), partnerRef: refString, partnerAccountRefs: z.array(refString).max(MAX_PARTNER_ACCOUNT_REFS).optional() }).strict(),
  z.object({ type: z.literal("VENDOR"), vendorRef: refString }).strict(),
]);
export type AgreementCounterpartyInput = z.infer<typeof agreementCounterpartyInputSchema>;

// What is STORED (browser-safe opaque refs). platformScope is derived server-side from
// the referenced Partner Accounts - one Partner with Instagram + YouTube accounts stays
// ONE Partner identity with platformScope ["instagram","youtube"].
export const agreementCounterpartySchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("PARTNER"),
      partnerRef: refString,
      partnerAccountRefs: z.array(refString).max(MAX_PARTNER_ACCOUNT_REFS).default([]),
      platformScope: z.array(z.string().min(1).max(60)).max(MAX_PARTNER_ACCOUNT_REFS).default([]),
    })
    .strict(),
  z.object({ type: z.literal("VENDOR"), vendorRef: refString }).strict(),
]);
export type AgreementCounterparty = z.infer<typeof agreementCounterpartySchema>;

// Point-in-time copy of the counterparty's scope (server-only; never in a DTO). It exists
// ONLY to serve bounded scoped list queries - the LIVE Partner/Vendor is the authority on
// every detail/mutation read.
export type AgreementScopeSnapshot = { ownerUid: string | null; regionIds: string[]; teamIds: string[]; partnerUid: string | null; vendorUid: string | null };

// --- Draft working copy ------------------------------------------------------------------------------------------------
export const AGREEMENT_FIELD_ORIGINS = ["MASTER_DATA", "EXTRACTED", "MANUAL"] as const;
export const agreementFieldOriginSchema = z.enum(AGREEMENT_FIELD_ORIGINS);
export type AgreementFieldOrigin = z.infer<typeof agreementFieldOriginSchema>;

// PENDING: proposed / prefilled, not yet decided. Only the other four are decisions.
export const AGREEMENT_ENTRY_DECISIONS = ["PENDING", ...AGREEMENT_FIELD_DECISIONS] as const;
export const agreementEntryDecisionSchema = z.enum(AGREEMENT_ENTRY_DECISIONS);
export type AgreementEntryDecision = z.infer<typeof agreementEntryDecisionSchema>;

export const EXTRACTION_CONFIDENCES = ["HIGH", "MEDIUM", "LOW", "UNKNOWN"] as const;
export const extractionConfidenceSchema = z.enum(EXTRACTION_CONFIDENCES);
export type ExtractionConfidence = z.infer<typeof extractionConfidenceSchema>;

// Where a field's value came from. Non-restricted only: the raw contract snippet and locator
// live solely in the restricted extraction record.
export const agreementFieldProvenanceEntrySchema = z
  .object({
    label: z.string().min(1).max(200),
    extractionRunRef: refString.nullable().default(null),
    page: z.number().int().min(1).max(100_000).nullable().default(null),
    confidence: extractionConfidenceSchema.nullable().default(null),
  })
  .strict();
export type AgreementFieldProvenanceEntry = z.infer<typeof agreementFieldProvenanceEntrySchema>;

const MAX_JSON_VALUE_CHARS = 30_000;
export const agreementJsonValueSchema = z.json().refine((value) => JSON.stringify(value).length <= MAX_JSON_VALUE_CHARS, { message: "Value is too large." });

export const agreementDraftEntrySchema = z
  .object({
    // The current candidate value. ALWAYS null for an identity VALUE field and for a
    // decision of UNAVAILABLE / NOT_APPLICABLE.
    value: agreementJsonValueSchema.nullable(),
    origin: agreementFieldOriginSchema,
    decision: agreementEntryDecisionSchema,
    // The extractor's own proposal (non-restricted fields only) kept beside a human correction.
    extractedValue: agreementJsonValueSchema.nullable().default(null),
    decidedByUserRef: nonEmpty.nullable().default(null),
    decidedAt: isoTimestamp.nullable().default(null),
    provenance: agreementFieldProvenanceEntrySchema,
  })
  .strict();
export type AgreementDraftEntry = z.infer<typeof agreementDraftEntrySchema>;

// fieldKey -> entry. Enforces, on every parse (read AND write), that no identity VALUE and no
// value under an UNAVAILABLE / NOT_APPLICABLE decision can ever be held in a draft.
export const agreementDraftSchema = z.partialRecord(agreementFieldKeySchema, agreementDraftEntrySchema).superRefine((draft, ctx) => {
  for (const [key, entry] of Object.entries(draft) as Array<[AgreementFieldKey, AgreementDraftEntry]>) {
    const field = AGREEMENT_FIELD_BY_KEY[key];
    if (field.identityValue && (entry.value !== null || entry.extractedValue !== null)) ctx.addIssue({ code: "custom", path: [key], message: "An identity value can never be stored on an Agreement." });
    if ((entry.decision === "UNAVAILABLE" || entry.decision === "NOT_APPLICABLE") && entry.value !== null) ctx.addIssue({ code: "custom", path: [key, "value"], message: `A ${entry.decision} decision carries no value.` });
  }
});
export type AgreementDraft = z.infer<typeof agreementDraftSchema>;

// Frozen at confirm: per decidable field, who decided what and where the value came from.
export const agreementFrozenProvenanceEntrySchema = z
  .object({
    origin: agreementFieldOriginSchema,
    decision: z.enum(AGREEMENT_FIELD_DECISIONS),
    decidedByUserRef: nonEmpty.nullable(),
    decidedAt: isoTimestamp.nullable(),
    provenance: agreementFieldProvenanceEntrySchema,
  })
  .strict();
export const agreementFieldProvenanceSchema = z.partialRecord(agreementFieldKeySchema, agreementFrozenProvenanceEntrySchema);
export type AgreementFieldProvenance = z.infer<typeof agreementFieldProvenanceSchema>;

// --- Version document (financeAgreements/{agreementRef}/versions/{n}) ---------------------------------------------------
export const agreementVersionSourceSchema = z
  .object({ contractArtifactRef: refString.nullable().default(null), extractionRunRef: refString.nullable().default(null), parserVersion: z.string().min(1).max(100).nullable().default(null) })
  .strict();
export type AgreementVersionSource = z.infer<typeof agreementVersionSourceSchema>;

export const agreementEffectiveSchema = z.object({ signedDate: utcDateSchema.nullable(), effectiveFrom: utcDateSchema, effectiveTo: utcDateSchema.nullable() }).strict();
export type AgreementEffective = z.infer<typeof agreementEffectiveSchema>;

export const agreementConfirmationSchema = z.object({ confirmedByUserRef: nonEmpty, confirmedAt: isoTimestamp }).strict();
export const agreementActivationSchema = z.object({ activatedByUserRef: nonEmpty, activatedAt: isoTimestamp, supersededVersion: z.number().int().min(1).nullable().default(null) }).strict();

export const agreementVersionDocSchema = z
  .object({
    agreementRef: nonEmpty,
    version: z.number().int().min(1).max(MAX_AGREEMENT_VERSIONS),
    status: agreementVersionStatusSchema,
    // Optimistic-concurrency counter of THIS version doc, bumped on every accepted change to it.
    docVersion: z.number().int().min(1),

    // Frozen copy of the head's counterparty at the moment this version was created.
    counterparty: agreementCounterpartySchema,
    sourceMode: agreementSourceModeSchema,
    source: agreementVersionSourceSchema,

    // WORKING COPY while unconfirmed; cleared ({}) on confirm.
    draft: agreementDraftSchema,

    // Set together at confirm, IMMUTABLE forever after (only lifecycle fields below change).
    terms: confirmedAgreementTermsSchema.nullable().default(null),
    contactSnapshot: contactSnapshotSchema.nullable().default(null),
    identityStatusSnapshot: identityStatusSnapshotSchema.nullable().default(null),
    fieldProvenance: agreementFieldProvenanceSchema.nullable().default(null),
    effective: agreementEffectiveSchema.nullable().default(null),
    confirmation: agreementConfirmationSchema.nullable().default(null),

    // Lifecycle fields.
    activation: agreementActivationSchema.nullable().default(null),
    supersededByVersion: z.number().int().min(1).nullable().default(null),
    supersededAt: isoTimestamp.nullable().default(null),
    suspendedAt: isoTimestamp.nullable().default(null),
    suspendedByUserRef: nonEmpty.nullable().default(null),
    suspendReason: z.string().min(1).max(1000).nullable().default(null),
    endedAt: isoTimestamp.nullable().default(null),
    endedByUserRef: nonEmpty.nullable().default(null),
    endReason: z.string().min(1).max(1000).nullable().default(null),

    createdAt: isoTimestamp,
    createdByUserRef: nonEmpty,
    updatedAt: isoTimestamp,
    updatedByUserRef: nonEmpty,
  })
  .strict()
  .superRefine((doc, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
    const confirmedParts = [doc.terms, doc.contactSnapshot, doc.identityStatusSnapshot, doc.fieldProvenance, doc.effective, doc.confirmation];
    const confirmedCount = confirmedParts.filter((part) => part !== null).length;
    if (confirmedCount !== 0 && confirmedCount !== confirmedParts.length) issue("confirmation", "terms, contactSnapshot, identityStatusSnapshot, fieldProvenance, effective and confirmation are set together or not at all.");
    const confirmed = confirmedCount === confirmedParts.length;

    if (confirmed && Object.keys(doc.draft).length > 0) issue("draft", "The draft working copy is cleared on confirm.");
    if (confirmed && doc.terms && doc.effective) {
      const { dates } = doc.terms;
      if (dates.signedDate !== doc.effective.signedDate || dates.effectiveFrom !== doc.effective.effectiveFrom || dates.effectiveTo !== doc.effective.effectiveTo) issue("effective", "effective must equal the confirmed terms' agreement dates.");
    }
    if (doc.status !== "DRAFT" && !confirmed) issue("status", "Only a confirmed version can leave DRAFT.");
    if (doc.status === "DRAFT" && (doc.activation || doc.suspendedAt || doc.endedAt || doc.supersededByVersion)) issue("status", "A DRAFT version carries no lifecycle fields.");
    if (["ACTIVE", "SUSPENDED", "ENDED", "SUPERSEDED"].includes(doc.status) && !doc.activation) issue("activation", "An activated version records its activation.");
    if (doc.status === "SUSPENDED" && !doc.suspendedAt) issue("suspendedAt", "A SUSPENDED version records when.");
    if (doc.status === "ENDED" && (!doc.endedAt || !doc.endReason)) issue("endedAt", "An ENDED version records when and why.");
    if (doc.status === "SUPERSEDED" && !doc.supersededByVersion) issue("supersededByVersion", "A SUPERSEDED version names its replacement.");
  });
export type AgreementVersionDoc = z.infer<typeof agreementVersionDocSchema>;

// --- Head list projection (Step 14B) ---------------------------------------------------------------------------------------
// A LIST PROJECTION written by every mutation that writes the head (in the SAME transaction) - never
// authorization and never lifecycle truth (the head fields and the version docs are). It serves the
// bounded workspace list only: name search, period / discrepancy filters and the row summary, "as of
// last update". It carries no identity value, no scope-snapshot field and no contract text. It is
// additive and optional: a head written before Step 14B has `display: null` and is refreshed by its
// next mutation. Writing it NEVER changes head.docVersion (see buildHeadDisplay / display writes).
export const agreementHeadDisplaySchema = z
  .object({
    // The counterparty's display name as of the last write (the live name is still shown in rows).
    counterpartyName: z.string().min(1).max(200),
    counterpartyNameLower: z.string().min(1).max(200),
    agreementNumber: z.string().min(1).max(100).nullable().default(null),
    agreementType: agreementTypeSchema.nullable().default(null),
    effectiveFrom: utcDateSchema.nullable().default(null),
    effectiveTo: utcDateSchema.nullable().default(null),
    sourceMode: agreementSourceModeSchema.nullable().default(null),
    // PENDING (proposed / prefilled, not yet decided) entries of the OPEN version's working draft.
    unresolvedFieldCount: z.number().int().min(0).max(1000).default(0),
    // The open version exists and is already confirmed (awaiting activation) - drives the row's primary action hint.
    openVersionConfirmed: z.boolean().default(false),
    // Status of the most recent extraction run recorded for the open version (completeness only).
    extractionStatus: z.enum(["EXTRACTED", "PARTIAL", "MANUAL_REVIEW_REQUIRED"]).nullable().default(null),
    // The head status when the projection was written.
    governingStatus: agreementHeadStatusSchema,
    projectedAt: isoTimestamp,
  })
  .strict();
export type AgreementHeadDisplay = z.infer<typeof agreementHeadDisplaySchema>;

// --- Head document (financeAgreements/{agreementRef}) -------------------------------------------------------------------
// The head's own scope fields (ownerUid/regionIds/teamIds/partnerUid|vendorUid) are a point-in-time
// copy of the counterparty's scope (see AgreementScopeSnapshot).
export const agreementHeadDocSchema = z
  .object({
    agreementRef: nonEmpty,
    // Optimistic-concurrency counter of the HEAD, bumped on every accepted lifecycle change.
    docVersion: z.number().int().min(1),
    counterparty: agreementCounterpartySchema,

    ownerUid: nonEmpty.nullable().default(null),
    regionIds: z.array(nonEmpty).max(50).default([]),
    teamIds: z.array(nonEmpty).max(50).default([]),
    partnerUid: nonEmpty.nullable().default(null),
    vendorUid: nonEmpty.nullable().default(null),

    status: agreementHeadStatusSchema,
    // Highest version number ever created (never decreases).
    latestVersion: z.number().int().min(1).max(MAX_AGREEMENT_VERSIONS),
    // The single mutable / confirmed-not-yet-active DRAFT version, if any.
    openVersion: z.number().int().min(1).nullable().default(null),
    // The ACTIVE or SUSPENDED version, if any.
    activeVersion: z.number().int().min(1).nullable().default(null),
    lastEndedVersion: z.number().int().min(1).nullable().default(null),

    // Step 14B list projection (additive; null on heads written before it). See agreementHeadDisplaySchema.
    display: agreementHeadDisplaySchema.nullable().default(null),

    createdAt: isoTimestamp,
    createdByUserRef: nonEmpty,
    updatedAt: isoTimestamp,
    updatedByUserRef: nonEmpty,
  })
  .strict()
  .superRefine((head, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
    if (head.counterparty.type === "PARTNER" && (!head.partnerUid || head.vendorUid)) issue("partnerUid", "A partner agreement is scoped by exactly a partnerUid.");
    if (head.counterparty.type === "VENDOR" && (!head.vendorUid || head.partnerUid)) issue("vendorUid", "A vendor agreement is scoped by exactly a vendorUid.");
    const governing = head.status === "ACTIVE" || head.status === "SUSPENDED";
    if (governing && head.activeVersion === null) issue("activeVersion", "An ACTIVE/SUSPENDED agreement names its governing version.");
    if (!governing && head.activeVersion !== null) issue("activeVersion", "Only an ACTIVE/SUSPENDED agreement has an active version.");
    if (head.status === "ENDED" && head.lastEndedVersion === null) issue("lastEndedVersion", "An ENDED agreement names the version that ended.");
    if (head.status === "DRAFT" && head.lastEndedVersion !== null) issue("lastEndedVersion", "A never-activated agreement has no ended version.");
    for (const [name, value] of [["openVersion", head.openVersion], ["activeVersion", head.activeVersion], ["lastEndedVersion", head.lastEndedVersion]] as const) {
      if (value !== null && value > head.latestVersion) issue(name, `${name} cannot exceed latestVersion.`);
    }
  });
export type AgreementHeadDoc = z.infer<typeof agreementHeadDocSchema>;

// --- Append-only event history (financeAgreements/{agreementRef}/events/{id}) ------------------------------------------
export const AGREEMENT_EVENT_KINDS = [
  "created",
  "field_decided",
  "extraction_attached",
  "confirmed",
  "activated",
  "superseded",
  "revision_created",
  "suspended",
  "resumed",
  "ended",
  "master_data_updated",
  "kyc_updated_from_agreement",
] as const;
export const agreementEventKindSchema = z.enum(AGREEMENT_EVENT_KINDS);
export type AgreementEventKind = z.infer<typeof agreementEventKindSchema>;

export const agreementEventSchema = z
  .object({
    kind: agreementEventKindSchema,
    version: z.number().int().min(1),
    actorUserRef: nonEmpty,
    // Already passed through the explicit ALLOWLIST redactor (agreement-events.ts).
    metadata: z.record(z.string(), z.unknown()).nullable(),
    requestId: nonEmpty,
    createdAt: isoTimestamp,
  })
  .strict();
export type AgreementEvent = z.infer<typeof agreementEventSchema>;

// --- Idempotency claim (financeAgreementClaims/{sha256(actorUid|clientRequestId)}) ---------------------------------------
// Created with tx.create in the SAME transaction as the head, so a retry with the same
// clientRequestId can only ever resolve to the one head. inputFingerprint lets a retry that
// changes the payload be reported as a conflict instead of silently returning another head.
export const agreementClaimDocSchema = z
  .object({ agreementRef: nonEmpty, inputFingerprint: z.string().regex(/^[0-9a-f]{64}$/), createdAt: isoTimestamp })
  .strict();
export type AgreementClaimDoc = z.infer<typeof agreementClaimDocSchema>;

// --- Contract artifact metadata (financeContractArtifacts/{artifactRef}) -------------------------------------------------
// Restricted collection. `storageLocator` is SERVER-ONLY: no DTO exposes it (see client-dto.ts).
export const MAX_CONTRACT_ARTIFACT_BYTES = 10 * 1024 * 1024;
export const CONTRACT_ARTIFACT_STATUSES = ["UPLOADED", "EXTRACTED", "MANUAL_REVIEW_REQUIRED"] as const;
export const contractArtifactStatusSchema = z.enum(CONTRACT_ARTIFACT_STATUSES);
export type ContractArtifactStatus = z.infer<typeof contractArtifactStatusSchema>;

export const contractArtifactDocSchema = z
  .object({
    artifactRef: refString,
    fileName: z.string().min(1).max(255),
    mimeType: z.literal("application/pdf"),
    sizeBytes: z.number().int().min(1).max(MAX_CONTRACT_ARTIFACT_BYTES),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    uploadedByUserRef: nonEmpty,
    uploadedAt: isoTimestamp,
    // The counterparty this contract was uploaded for (opaque ref, never a uid).
    counterparty: z.object({ type: counterpartyTypeSchema, ref: refString }).strict(),
    status: contractArtifactStatusSchema,
    storageLocator: nonEmpty,
  })
  .strict();
export type ContractArtifactDoc = z.infer<typeof contractArtifactDocSchema>;

// --- Extraction run (financeAgreements/{ref}/extractionRuns/{runRef}) - NON-restricted ------------------------------------
export const EXTRACTION_RUN_STATUSES = ["EXTRACTED", "PARTIAL", "MANUAL_REVIEW_REQUIRED"] as const;
export const extractionRunStatusSchema = z.enum(EXTRACTION_RUN_STATUSES);
export type ExtractionRunStatus = z.infer<typeof extractionRunStatusSchema>;

// Completeness only - never legal verification. Proposals for identity VALUE fields carry a
// null normalizedValue (the value lives only in the restricted extraction record).
export const extractionProposalSchema = z
  .object({
    fieldKey: agreementFieldKeySchema,
    normalizedValue: agreementJsonValueSchema.nullable(),
    confidence: extractionConfidenceSchema,
    warnings: z.array(z.string().min(1).max(300)).max(10).default([]),
    requiresHumanConfirmation: z.literal(true),
    source: z.object({ page: z.number().int().min(1).max(100_000).nullable() }).strict(),
  })
  .strict()
  .superRefine((proposal, ctx) => {
    if (AGREEMENT_FIELD_BY_KEY[proposal.fieldKey].identityValue && proposal.normalizedValue !== null) ctx.addIssue({ code: "custom", path: ["normalizedValue"], message: "An identity value is never part of an ordinary extraction run." });
  });
export type ExtractionProposal = z.infer<typeof extractionProposalSchema>;

export const MAX_EXTRACTION_PROPOSALS = 60;
export const extractionRunDocSchema = z
  .object({
    runRef: refString,
    agreementRef: nonEmpty,
    artifactRef: refString,
    status: extractionRunStatusSchema,
    reasonCodes: z.array(z.string().min(1).max(100)).max(20).default([]),
    parserVersion: z.string().min(1).max(100),
    pageCount: z.number().int().min(0).max(100_000),
    charCount: z.number().int().min(0),
    proposals: z.array(extractionProposalSchema).max(MAX_EXTRACTION_PROPOSALS),
    createdAt: isoTimestamp,
    createdByUserRef: nonEmpty,
  })
  .strict();
export type ExtractionRunDoc = z.infer<typeof extractionRunDocSchema>;

// --- Restricted extraction (financeAgreementRestrictedExtractions/{runRef}) - SERVER-ONLY --------------------------------
// Raw snippets/locators for every field and raw values of identity fields. Readable only with
// finance_contracts (identity values additionally the owning identity category). NEVER exposed
// by a DTO and never copied into financeAgreements/*.
export const restrictedExtractionFieldSchema = z
  .object({ rawSnippet: z.string().min(1).max(2000).nullable().default(null), locator: z.string().min(1).max(200).nullable().default(null), rawValue: z.string().min(1).max(1000).nullable().default(null) })
  .strict();
export const restrictedExtractionDocSchema = z
  .object({
    runRef: refString,
    agreementRef: nonEmpty,
    artifactRef: refString,
    fields: z.partialRecord(agreementFieldKeySchema, restrictedExtractionFieldSchema),
    createdAt: isoTimestamp,
  })
  .strict();
export type RestrictedExtractionDoc = z.infer<typeof restrictedExtractionDocSchema>;

// --- Result/error plumbing - same shape as Partner Reviews' own -----------------------------------------------------------
export type FinanceAgreementsDenialReason = "not_authenticated" | "feature_denied" | "action_denied" | "scope_denied" | "sensitive_denied";

export type FinanceAgreementsServiceErrorCode = "unauthorized" | "not_found" | "invalid_input" | "stale_write" | "not_ready" | "conflict" | "internal";

export type FinanceAgreementsReadinessIssue = { code: string; message: string; fieldKey?: AgreementFieldKey };

export type FinanceAgreementsServiceResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: FinanceAgreementsServiceErrorCode; message: string; reason?: FinanceAgreementsDenialReason; blockers?: FinanceAgreementsReadinessIssue[] };

export type FinanceAgreementsErrorResult = Extract<FinanceAgreementsServiceResult<unknown>, { ok: false }>;

export function financeAgreementsUnauthorizedResult(reason: FinanceAgreementsDenialReason): FinanceAgreementsErrorResult {
  return { ok: false, code: "unauthorized", message: `Finance Agreements access denied (${reason}).`, reason };
}

export function financeAgreementsInvalidInputResult(message: string): FinanceAgreementsErrorResult {
  return { ok: false, code: "invalid_input", message };
}

// The ONE neutral outcome for a missing, out-of-scope or forged reference - identical in
// every case so a caller can never tell them apart.
export const NEUTRAL_NOT_FOUND_MESSAGE = "Not found.";
export function financeAgreementsNotFoundResult(message: string = NEUTRAL_NOT_FOUND_MESSAGE): FinanceAgreementsErrorResult {
  return { ok: false, code: "not_found", message };
}

export function financeAgreementsStaleResult(message = "This agreement was changed elsewhere. Reload and try again."): FinanceAgreementsErrorResult {
  return { ok: false, code: "stale_write", message };
}

export function financeAgreementsConflictResult(message: string): FinanceAgreementsErrorResult {
  return { ok: false, code: "conflict", message };
}

export function financeAgreementsNotReadyResult(message: string, blockers: FinanceAgreementsReadinessIssue[]): FinanceAgreementsErrorResult {
  return { ok: false, code: "not_ready", message, blockers };
}

export function financeAgreementsInternalResult(message = "Something went wrong."): FinanceAgreementsErrorResult {
  return { ok: false, code: "internal", message };
}

// --- Strict command INPUT schemas -------------------------------------------------------------------------------------------
// Every object is .strict(): an unknown key (a client-supplied scope, uid, platformScope,
// status, terms ...) is rejected, never silently dropped.
//
// `expectedDocVersion` semantics (optimistic concurrency):
//   - decideField / attachExtraction / confirm carry the docVersion of the VERSION doc being changed;
//   - activate / revise / suspend / resume / end carry the docVersion of the HEAD.
// A mismatch is reported as stale_write.

export const agreementRefSchema = z.string().regex(/^agr_[0-9a-f]{20}$/, "Invalid agreement reference.");
export const artifactRefSchema = z.string().regex(/^ca_[0-9a-f]{20}$/, "Invalid contract artifact reference.");
export const extractionRunRefSchema = z.string().regex(/^run_[0-9a-f]{20}$/, "Invalid extraction run reference.");
const versionNumberSchema = z.number().int().min(1).max(MAX_AGREEMENT_VERSIONS);
const expectedDocVersionSchema = z.number().int().min(1);
const reasonSchema = z.string().trim().min(3).max(1000);

export const clientRequestIdSchema = z.string().regex(/^[A-Za-z0-9._:-]{8,100}$/, "clientRequestId must be 8-100 characters of letters, digits, . _ : -");

export const agreementRefParamsSchema = z.object({ agreementRef: agreementRefSchema }).strict();

export const createAgreementDraftInputSchema = z
  .object({
    clientRequestId: clientRequestIdSchema,
    counterparty: agreementCounterpartyInputSchema,
    // Advisory intention only; the effective sourceMode is recomputed from field origins at confirm.
    sourceMode: z.enum(["MANUAL", "EXTRACTED"]).optional(),
  })
  .strict();
export type CreateAgreementDraftInput = z.infer<typeof createAgreementDraftInputSchema>;

export const decideFieldInputSchema = z
  .object({
    agreementRef: agreementRefSchema,
    version: versionNumberSchema,
    expectedDocVersion: expectedDocVersionSchema,
    fieldKey: agreementFieldKeySchema,
    decision: z.enum(AGREEMENT_FIELD_DECISIONS),
    // Required for CORRECTED, optional for ACCEPTED (keeps the entry's current value),
    // forbidden for UNAVAILABLE / NOT_APPLICABLE and for identity value fields.
    value: agreementJsonValueSchema.optional(),
    note: z.string().trim().min(1).max(500).optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    const check = checkFieldDecisionValue(input.fieldKey, input.decision, input.value);
    if (!check.ok) ctx.addIssue({ code: "custom", path: ["value"], message: check.message });
  })
  // Replace `value` with the validated/normalized one (e.g. trimmed text, normalized platforms).
  .transform((input) => {
    const check = checkFieldDecisionValue(input.fieldKey, input.decision, input.value);
    return { ...input, value: check.ok ? check.value : input.value };
  });
export type DecideFieldInput = z.output<typeof decideFieldInputSchema>;

export const attachExtractionInputSchema = z
  .object({ agreementRef: agreementRefSchema, version: versionNumberSchema, expectedDocVersion: expectedDocVersionSchema, extractionRunRef: extractionRunRefSchema })
  .strict();
export type AttachExtractionInput = z.infer<typeof attachExtractionInputSchema>;

export const confirmAgreementVersionInputSchema = z.object({ agreementRef: agreementRefSchema, version: versionNumberSchema, expectedDocVersion: expectedDocVersionSchema }).strict();
export type ConfirmAgreementVersionInput = z.infer<typeof confirmAgreementVersionInputSchema>;

export const activateAgreementVersionInputSchema = z.object({ agreementRef: agreementRefSchema, version: versionNumberSchema, expectedDocVersion: expectedDocVersionSchema }).strict();
export type ActivateAgreementVersionInput = z.infer<typeof activateAgreementVersionInputSchema>;

export const createAgreementRevisionInputSchema = z.object({ agreementRef: agreementRefSchema, expectedDocVersion: expectedDocVersionSchema }).strict();
export type CreateAgreementRevisionInput = z.infer<typeof createAgreementRevisionInputSchema>;

export const suspendAgreementInputSchema = z.object({ agreementRef: agreementRefSchema, expectedDocVersion: expectedDocVersionSchema, reason: reasonSchema }).strict();
export type SuspendAgreementInput = z.infer<typeof suspendAgreementInputSchema>;

export const resumeAgreementInputSchema = z.object({ agreementRef: agreementRefSchema, expectedDocVersion: expectedDocVersionSchema }).strict();
export type ResumeAgreementInput = z.infer<typeof resumeAgreementInputSchema>;

export const endAgreementInputSchema = z.object({ agreementRef: agreementRefSchema, expectedDocVersion: expectedDocVersionSchema, reason: reasonSchema }).strict();
export type EndAgreementInput = z.infer<typeof endAgreementInputSchema>;
