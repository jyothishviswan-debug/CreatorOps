import { z } from "zod";

import { platformIdentifierArraySchema } from "@/server/shared/platform";

// Step 14A: the confirmed, immutable commercial/contractual TERMS of one
// Agreement version, and the small component schemas the field registry
// (fields.ts) validates individual field values against.
//
// Hard rules encoded here:
//   - Money is ALWAYS integer minor units (`amountMinor`, e.g. paise) plus an
//     explicit ISO-4217-shaped `currency`. There is no total, proration or
//     payable calculation anywhere in this module.
//   - `null` on a nullable term means "the contract does not state it"
//     (decision UNAVAILABLE). `{ applicable: false }` means the component
//     explicitly does not apply (decision NOT_APPLICABLE).
//   - performance targets are warning-only: `affectsPayment` is the literal
//     `false`, so a value of `true` can neither be parsed nor stored.
//   - NO Campaign / Assignment / Deliverable / Creator concept, and NO
//     restricted identity value (PAN / Aadhaar / GST / bank) appears anywhere
//     in this file - identity lives only in the canonical restricted store.

const isoTimestamp = z.string().min(1);
export const utcDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a YYYY-MM-DD date.")
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value), { message: "Not a real calendar date." });

export const MAX_CLAUSE_TEXT_LENGTH = 10_000;
const shortText = (max: number) => z.string().trim().min(1).max(max);

// --- Money --------------------------------------------------------------------------------------------------------------
export const amountMinorSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const currencyCodeSchema = z.string().regex(/^[A-Z]{3}$/, "Expected a 3-letter uppercase currency code.");

// --- Enumerations -------------------------------------------------------------------------------------------------------
export const PAYMENT_CYCLES = ["WEEKLY", "FORTNIGHTLY", "MONTHLY", "QUARTERLY", "ONE_TIME", "OTHER"] as const;
export const paymentCycleSchema = z.enum(PAYMENT_CYCLES);
export type PaymentCycle = z.infer<typeof paymentCycleSchema>;

// Component presence in the canonical restricted store - status only, never a value.
//   PRESENT         the canonical value is on file
//   MISSING         nothing on file for the component
//   INCOMPLETE      (Step 14B.1) a document of that type is on file but the canonical details are not entered yet, or GST applies
//                   but no number is on file - "document on file, details not entered"
//   NOT_APPLICABLE  the component does not apply to this counterparty
export const IDENTITY_COMPONENT_STATUSES = ["PRESENT", "MISSING", "INCOMPLETE", "NOT_APPLICABLE"] as const;
export const identityComponentStatusSchema = z.enum(IDENTITY_COMPONENT_STATUSES);
export type IdentityComponentStatus = z.infer<typeof identityComponentStatusSchema>;

// --- Commercial components ----------------------------------------------------------------------------------------------
export const fixedComponentSchema = z
  .object({ applicable: z.boolean(), amountMinor: amountMinorSchema.nullable() })
  .strict()
  .superRefine((value, ctx) => {
    if (value.applicable && value.amountMinor === null) ctx.addIssue({ code: "custom", path: ["amountMinor"], message: "An applicable fixed component needs an amount." });
    if (!value.applicable && value.amountMinor !== null) ctx.addIssue({ code: "custom", path: ["amountMinor"], message: "A non-applicable fixed component carries no amount." });
  });
export type FixedComponent = z.infer<typeof fixedComponentSchema>;

export const accountTransferFeeSchema = z
  .object({ applicable: z.boolean(), amountMinor: amountMinorSchema.nullable(), details: shortText(1000).nullable() })
  .strict()
  .superRefine((value, ctx) => {
    if (value.applicable && value.amountMinor === null && value.details === null) ctx.addIssue({ code: "custom", path: ["amountMinor"], message: "An applicable account transfer fee needs an amount or details." });
    if (!value.applicable && (value.amountMinor !== null || value.details !== null)) ctx.addIssue({ code: "custom", path: ["applicable"], message: "A non-applicable account transfer fee carries no amount or details." });
  });
export type AccountTransferFee = z.infer<typeof accountTransferFeeSchema>;

export const advancePaymentSchema = z
  .object({ applicable: z.boolean(), details: shortText(2000).nullable(), amountMinor: amountMinorSchema.nullable() })
  .strict()
  .superRefine((value, ctx) => {
    if (value.applicable && value.amountMinor === null && value.details === null) ctx.addIssue({ code: "custom", path: ["details"], message: "An applicable advance payment needs an amount or details." });
    if (!value.applicable && (value.amountMinor !== null || value.details !== null)) ctx.addIssue({ code: "custom", path: ["applicable"], message: "A non-applicable advance payment carries no amount or details." });
  });
export type AdvancePayment = z.infer<typeof advancePaymentSchema>;

// One incentive slab: a recorded band of a metric and the incentive amount the
// contract attaches to it. Recorded data only - never evaluated here.
export const MAX_INCENTIVE_SLABS = 30;
export const incentiveSlabSchema = z
  .object({
    slabRef: shortText(100),
    metricId: shortText(100),
    lowerBound: z.number().finite().min(0),
    upperBound: z.number().finite().min(0).nullable(),
    unit: shortText(60),
    amountMinor: amountMinorSchema,
    description: shortText(500).nullable(),
  })
  .strict()
  .superRefine((slab, ctx) => {
    if (slab.upperBound !== null && slab.upperBound <= slab.lowerBound) ctx.addIssue({ code: "custom", path: ["upperBound"], message: "A slab's upper bound must exceed its lower bound." });
  });
export type IncentiveSlab = z.infer<typeof incentiveSlabSchema>;

export const incentiveSchema = z
  .object({ applicable: z.boolean(), slabs: z.array(incentiveSlabSchema).max(MAX_INCENTIVE_SLABS) })
  .strict()
  .superRefine((value, ctx) => {
    if (value.applicable && value.slabs.length === 0) ctx.addIssue({ code: "custom", path: ["slabs"], message: "An applicable incentive needs at least one slab." });
    if (!value.applicable && value.slabs.length > 0) ctx.addIssue({ code: "custom", path: ["slabs"], message: "A non-applicable incentive carries no slabs." });
    const refs = value.slabs.map((slab) => slab.slabRef);
    if (new Set(refs).size !== refs.length) ctx.addIssue({ code: "custom", path: ["slabs"], message: "Incentive slab refs must be unique." });
  });
export type Incentive = z.infer<typeof incentiveSchema>;

// Present ONLY when the contract states an explicit format -> LFC/SFC
// classification. null = not explicit (never guessed).
export const MAX_LFC_SFC_FORMATS = 40;
export const lfcSfcSchema = z
  .object({
    ruleRef: shortText(200).optional(),
    byFormat: z
      .record(z.string().trim().min(1).max(60), z.enum(["LFC", "SFC"]))
      .refine((value) => Object.keys(value).length > 0 && Object.keys(value).length <= MAX_LFC_SFC_FORMATS, { message: "An LFC/SFC rule names between 1 and 40 formats." }),
  })
  .strict();
export type LfcSfc = z.infer<typeof lfcSfcSchema>;

// Warning-only performance targets. `affectsPayment` is the literal false:
// no value but false can be parsed, stored or read back.
export const MAX_PERFORMANCE_TARGETS = 12;
export const performanceTargetSchema = z
  .object({
    targetRef: shortText(200),
    // followerGrowth | reach | views | engagement | likes | comments | any other analytics metric id.
    metricId: shortText(100),
    targetValue: z.number().finite(),
    unit: shortText(60),
    comparison: z.literal("at_least"),
    affectsPayment: z.literal(false),
  })
  .strict();
export type PerformanceTarget = z.infer<typeof performanceTargetSchema>;

export const performanceTargetsSchema = z
  .array(performanceTargetSchema)
  .max(MAX_PERFORMANCE_TARGETS)
  .superRefine((targets, ctx) => {
    const refs = targets.map((target) => target.targetRef);
    if (new Set(refs).size !== refs.length) ctx.addIssue({ code: "custom", message: "Performance target refs must be unique." });
  });

// --- Agreement type (derived, never trusted from an extractor) ---------------------------------------------------------
export const AGREEMENT_TYPES = [
  "FIXED_ONLY",
  "FIXED_PLUS_INCENTIVE",
  "FIXED_PLUS_REQUIRED_CONTENT",
  "FIXED_PLUS_INCENTIVE_PLUS_REQUIRED_CONTENT",
  "REQUIRED_CONTENT_BASED",
  "INCENTIVE_BASED",
  "INCENTIVE_PLUS_REQUIRED_CONTENT",
  "UNSPECIFIED",
] as const;
export const agreementTypeSchema = z.enum(AGREEMENT_TYPES);
export type AgreementType = z.infer<typeof agreementTypeSchema>;

// The commercial slice deriveAgreementType reads - structural, so the pure
// function is usable on a draft-assembled slice as well as on confirmed terms.
export type AgreementTypeInput = {
  commercial: {
    fixedComponent: { applicable: boolean } | null;
    incentive: { applicable: boolean; slabs: readonly unknown[] } | null;
    monthlyRequiredQualifyingContentCount: number | null;
  };
};

// RULE (the only source of an Agreement's type - an extractor's guess is never read):
//   fixed     = fixedComponent.applicable === true
//   incentive = incentive.applicable === true AND at least one slab
//   required  = monthlyRequiredQualifyingContentCount is a number > 0
// The 8 combinations map 1:1 to the AGREEMENT_TYPES; no component present =>
// UNSPECIFIED. advancePayment / accountTransferFee / invoice terms are
// modifiers, never part of the structural type. lfcSfc and performance targets
// do not change the type either.
export function deriveAgreementType(terms: AgreementTypeInput): AgreementType {
  const { fixedComponent, incentive, monthlyRequiredQualifyingContentCount } = terms.commercial;
  const fixed = fixedComponent?.applicable === true;
  const hasIncentive = incentive?.applicable === true && incentive.slabs.length > 0;
  const required = typeof monthlyRequiredQualifyingContentCount === "number" && monthlyRequiredQualifyingContentCount > 0;

  if (fixed && !hasIncentive && !required) return "FIXED_ONLY";
  if (fixed && hasIncentive && !required) return "FIXED_PLUS_INCENTIVE";
  if (fixed && !hasIncentive && required) return "FIXED_PLUS_REQUIRED_CONTENT";
  if (fixed && hasIncentive && required) return "FIXED_PLUS_INCENTIVE_PLUS_REQUIRED_CONTENT";
  if (!fixed && !hasIncentive && required) return "REQUIRED_CONTENT_BASED";
  if (!fixed && hasIncentive && !required) return "INCENTIVE_BASED";
  if (!fixed && hasIncentive && required) return "INCENTIVE_PLUS_REQUIRED_CONTENT";
  return "UNSPECIFIED";
}

// --- ConfirmedAgreementTerms ---------------------------------------------------------------------------------------------
export const commercialTermsSchema = z
  .object({
    // Required (non-null) whenever any amount is present - see the terms-level check below.
    currency: currencyCodeSchema.nullable(),
    paymentCycle: paymentCycleSchema.nullable(),
    fixedComponent: fixedComponentSchema.nullable(),
    // The old "Fixed deliverable units" label maps here. NO Deliverable entity exists.
    monthlyRequiredQualifyingContentCount: z.number().int().min(0).max(100_000).nullable(),
    qualifyingUnit: shortText(100).nullable(),
    accountTransferFee: accountTransferFeeSchema.nullable(),
    advancePayment: advancePaymentSchema.nullable(),
    invoiceRequired: z.boolean().nullable(),
    invoiceDueTerms: shortText(2000).nullable(),
    paymentDueTerms: shortText(2000).nullable(),
    // The full mandated-services clause text.
    servicesMandated: shortText(MAX_CLAUSE_TEXT_LENGTH).nullable(),
    incentive: incentiveSchema.nullable(),
    lfcSfc: lfcSfcSchema.nullable(),
  })
  .strict();
export type CommercialTerms = z.infer<typeof commercialTermsSchema>;

export const agreementDatesSchema = z
  .object({
    signedDate: utcDateSchema.nullable(),
    // Required: the effective range is what makes a version govern a period.
    effectiveFrom: utcDateSchema,
    // The contract's termination/end date, when stated.
    effectiveTo: utcDateSchema.nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.effectiveTo !== null && value.effectiveTo < value.effectiveFrom) ctx.addIssue({ code: "custom", path: ["effectiveTo"], message: "The termination date cannot precede the effective date." });
  });
export type AgreementDates = z.infer<typeof agreementDatesSchema>;

export const contractTermsTextSchema = z
  .object({
    renewalTerms: shortText(MAX_CLAUSE_TEXT_LENGTH).nullable(),
    noticeTerms: shortText(MAX_CLAUSE_TEXT_LENGTH).nullable(),
    terminationTerms: shortText(MAX_CLAUSE_TEXT_LENGTH).nullable(),
  })
  .strict();
export type ContractTermsText = z.infer<typeof contractTermsTextSchema>;

export const MAX_AGREEMENT_PLATFORMS = 20;
export const platformTermsSchema = z
  .object({
    // Normalized with shared/platform normalizePlatformIdentifier; duplicates rejected.
    platforms: platformIdentifierArraySchema(MAX_AGREEMENT_PLATFORMS),
    collaboratorPageLink: shortText(500).nullable(),
    collaboratorPageName: shortText(200).nullable(),
  })
  .strict();
export type PlatformTerms = z.infer<typeof platformTermsSchema>;

export const adminTermsSchema = z
  .object({
    // Manual admin flag (CreatorOps process), never read from contract text.
    onboardingProcessCompleted: z.boolean().nullable(),
    // Internal notes.
    remarks: shortText(2000).nullable(),
  })
  .strict();
export type AdminTerms = z.infer<typeof adminTermsSchema>;

function hasAnyAmount(commercial: CommercialTerms): boolean {
  return (
    (commercial.fixedComponent?.amountMinor ?? null) !== null ||
    (commercial.accountTransferFee?.amountMinor ?? null) !== null ||
    (commercial.advancePayment?.amountMinor ?? null) !== null ||
    (commercial.incentive?.slabs.length ?? 0) > 0
  );
}

export const confirmedAgreementTermsSchema = z
  .object({
    agreementNumber: shortText(100).nullable(),
    dates: agreementDatesSchema,
    contractTerms: contractTermsTextSchema,
    platform: platformTermsSchema,
    commercial: commercialTermsSchema,
    performanceTargets: performanceTargetsSchema,
    admin: adminTermsSchema,
    // Derived from the confirmed commercial structure by deriveAgreementType;
    // the check below rejects any stored value that disagrees with the rule.
    agreementType: agreementTypeSchema,
  })
  .strict()
  .superRefine((terms, ctx) => {
    const { commercial } = terms;
    if (hasAnyAmount(commercial) && commercial.currency === null) ctx.addIssue({ code: "custom", path: ["commercial", "currency"], message: "A currency is required when any amount is present." });
    if (commercial.monthlyRequiredQualifyingContentCount !== null && commercial.qualifyingUnit === null) ctx.addIssue({ code: "custom", path: ["commercial", "qualifyingUnit"], message: "A required content count needs its qualifying unit." });
    if (commercial.monthlyRequiredQualifyingContentCount === null && commercial.qualifyingUnit !== null) ctx.addIssue({ code: "custom", path: ["commercial", "monthlyRequiredQualifyingContentCount"], message: "A qualifying unit needs its required content count." });
    if (terms.agreementType !== deriveAgreementType(terms)) ctx.addIssue({ code: "custom", path: ["agreementType"], message: "agreementType must equal the type derived from the confirmed commercial structure." });
  });
export type ConfirmedAgreementTerms = z.infer<typeof confirmedAgreementTermsSchema>;

// --- Confirmed non-restricted counterparty contact facts ----------------------------------------------------------------
// Operationally needed, ordinary contact/address data. Never an identity value.
export const contactSnapshotSchema = z
  .object({
    counterpartyName: shortText(200),
    contactNumber: shortText(40).nullable(),
    emailAddress: shortText(300).nullable(),
    state: shortText(100).nullable(),
    address: shortText(500).nullable(),
    pinCode: z.string().regex(/^\d{6}$/, "Expected a 6-digit PIN code.").nullable(),
  })
  .strict();
export type ContactSnapshot = z.infer<typeof contactSnapshotSchema>;

// --- Identity STATUS snapshot (status + component presence ONLY) --------------------------------------------------------
export const IDENTITY_STATUS_STATES = ["AVAILABLE", "MISSING", "INCOMPLETE", "UNAVAILABLE"] as const;
export const identityStatusStateSchema = z.enum(IDENTITY_STATUS_STATES);
export type IdentityStatusState = z.infer<typeof identityStatusStateSchema>;

export const identityComponentsSchema = z
  .object({
    pan: identityComponentStatusSchema,
    aadhaar: identityComponentStatusSchema,
    gst: identityComponentStatusSchema,
    bank: identityComponentStatusSchema,
  })
  .strict();
export type IdentityComponents = z.infer<typeof identityComponentsSchema>;

export const identityStatusSnapshotSchema = z.object({ state: identityStatusStateSchema, components: identityComponentsSchema, capturedAt: isoTimestamp }).strict();
export type IdentityStatusSnapshot = z.infer<typeof identityStatusSnapshotSchema>;

// --- Original Agreement document failure codes (Step 14B.1) --------------------------------------------------------------------
// Safe, closed codes for a failed attempt to store the original signed Agreement in Drive. Kept here (a pure registry module) so the
// version document schema, the audit event allowlist and the browser can all name the same set without importing any storage code.
export const AGREEMENT_DOCUMENT_FAILURE_CODES = [
  // Storage is not set up (no credentials / no folder for this counterparty type).
  "not_configured",
  // The real Drive adapter refuses to run inside an automated test run.
  "live_drive_disabled_in_tests",
  "invalid_input",
  "access_denied",
  "folder_not_found",
  "quota_exceeded",
  "drive_unavailable",
  "unexpected_response",
  // The exact bytes could not be read back / did not match the recorded checksum (service-level, never from an adapter).
  "artifact_unavailable",
  "artifact_mismatch",
  "unknown",
] as const;
export type AgreementDocumentFailureCode = (typeof AGREEMENT_DOCUMENT_FAILURE_CODES)[number];

