import { z } from "zod";

// Step 16C: the Invoice PAYEE IDENTITY MATCHING domain - compares the Invoice's extracted
// payee/supplier evidence against the CANONICAL counterparty already pinned on the source Payable
// (see resolve-identity.ts). This module never searches across all Partners/Vendors, never proposes
// a different counterparty, and never mutates Payable/Partner/Vendor master data (sections 3/19/20
// of the spec) - it only produces a server-authoritative comparison VERDICT.
//
// SENSITIVE-DATA DISCIPLINE (section 5): a restricted value (a tax-registration number, a bank
// account identifier) is read server-side only, inside resolve-identity.ts, and NEVER stored or
// returned here as a raw value - only as a closed-enum STATUS plus an already-masked display string
// built by matcher.ts's safe-display projection. Field/property names here deliberately avoid the
// exact tokens this module's own static guard (finance-invoices-static.test.ts) forbids anywhere in
// src/server/finance-invoices/** (gstin, gstNumber, accountNumber, bankAccountNumber, ifsc,
// accountHolderName, panNumber, aadhaarNumber, kyc) - "taxRegistration"/"bankIdentifier" are used
// instead, never those literal names.

export const PAYEE_IDENTITY_FIELD_KEYS = ["NAME", "TAX_REGISTRATION", "ADDRESS", "BANK"] as const;
export type PayeeIdentityFieldKey = (typeof PAYEE_IDENTITY_FIELD_KEYS)[number];

// Per-field comparison result. Bank comparison is exact-only (no fuzzy matching - section 7): it
// only ever reports EXACT (treated as the section-5 "MATCH" bank state), MISMATCH or UNAVAILABLE,
// never NORMALIZED_MATCH/REVIEW_REQUIRED - matcher.ts enforces this.
export const PAYEE_IDENTITY_FIELD_STATUSES = ["EXACT", "NORMALIZED_MATCH", "MISMATCH", "UNAVAILABLE", "REVIEW_REQUIRED"] as const;
export type PayeeIdentityFieldStatus = (typeof PAYEE_IDENTITY_FIELD_STATUSES)[number];

export const PAYEE_IDENTITY_OVERALL_STATUSES = ["MATCH", "PARTIAL_MATCH", "MISMATCH", "INSUFFICIENT_EVIDENCE", "REVIEW_REQUIRED", "OVERRIDDEN"] as const;
export type PayeeIdentityOverallStatus = (typeof PAYEE_IDENTITY_OVERALL_STATUSES)[number];

// "OVERRIDDEN" is never computed by the matcher (see matcher.ts's computePayeeIdentityMatch) - it is
// a DISPLAY-ONLY projection the client-dto layer applies when an authorized resolution exists for
// this exact version (section 16: "do not overwrite mismatch with a fake green Match state" - the
// stored evidence below is always preserved exactly as computed).
export const PAYEE_IDENTITY_MATCHER_STATUSES = PAYEE_IDENTITY_OVERALL_STATUSES.filter((status) => status !== "OVERRIDDEN") as readonly Exclude<PayeeIdentityOverallStatus, "OVERRIDDEN">[];

export const PAYEE_IDENTITY_CONFIDENCE = ["HIGH", "MEDIUM", "LOW", "NONE"] as const;
export type PayeeIdentityConfidence = (typeof PAYEE_IDENTITY_CONFIDENCE)[number];

const shortText = (max: number) => z.string().trim().min(1).max(max);

// Per-field result as persisted/returned. `safeExpectedDisplay`/`safeExtractedDisplay` are ALREADY
// masked/safe by the time they reach this shape (built once, in matcher.ts, from the trusted
// server-side comparison) - nothing downstream (DTO, UI) needs to re-mask them, but nothing
// downstream may ever substitute a raw value in either field either.
export const payeeIdentityFieldResultSchema = z
  .object({
    field: z.enum(PAYEE_IDENTITY_FIELD_KEYS),
    status: z.enum(PAYEE_IDENTITY_FIELD_STATUSES),
    confidence: z.enum(PAYEE_IDENTITY_CONFIDENCE),
    safeExpectedDisplay: shortText(200).nullable(),
    safeExtractedDisplay: shortText(200).nullable(),
    reason: shortText(300).nullable(),
  })
  .strict();
export type PayeeIdentityFieldResult = z.infer<typeof payeeIdentityFieldResultSchema>;

export const payeeIdentityMatchResultSchema = z
  .object({
    // Never "OVERRIDDEN" here - see PAYEE_IDENTITY_MATCHER_STATUSES above.
    overallStatus: z.enum(PAYEE_IDENTITY_MATCHER_STATUSES),
    fields: z.array(payeeIdentityFieldResultSchema).max(PAYEE_IDENTITY_FIELD_KEYS.length),
    warnings: z.array(shortText(300)).max(10),
    comparedAt: z.string().min(1),
  })
  .strict();
export type PayeeIdentityMatchResult = z.infer<typeof payeeIdentityMatchResultSchema>;
