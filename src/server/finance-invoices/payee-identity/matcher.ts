import { compareAddresses, compareBankIdentifiers, compareNames, compareTaxIds, maskBankIdentifierLast4 } from "./normalization";
import type { PayeeIdentityFieldResult, PayeeIdentityMatchResult, PayeeIdentityOverallStatus } from "./types";

// Step 16C section 8/9/10: the PURE payee-identity decision engine. Given already-resolved evidence
// (section 3: the expected side is always the Payable-pinned counterparty, never a global search
// result), computes the per-field comparison AND the conservative overall verdict. No Firestore, no
// network - fully unit-tested in matcher.test.ts.
//
// SENSITIVE-DATA NOTE: `expectedTaxId`/`expectedBankIdentifier` below ARE the raw restricted values
// (resolved server-side by resolve-identity.ts, which is the ONLY caller of this function outside
// tests). This function itself never returns them - every field result's display strings are built
// through the safe-display helpers below (safeTaxDisplay / masked bank last-4 / verbatim name or
// address text, neither of which is a restricted category).

export type PayeeIdentityEvidence = {
  expectedName: string | null;
  extractedName: string | null;
  // Restricted - see the module header. Never echoed back raw anywhere in this file's return value.
  expectedTaxId: string | null;
  extractedTaxId: string | null;
  expectedAddress: string | null;
  extractedAddress: string | null;
  // Restricted - see the module header.
  expectedBankIdentifier: string | null;
  extractedBankIdentifier: string | null;
};

const DISPLAY_MAX = 200;

function safeText(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > DISPLAY_MAX ? `${trimmed.slice(0, DISPLAY_MAX - 1)}…` : trimmed;
}

// GST/tax registration is treated as restricted everywhere else in this codebase (see
// extraction/field-extractors.ts's gstinField) - a payee-identity DTO must never show any part of
// the actual identifier, only whether one is on file/was found. This mirrors section 5's "never
// expose... unrestricted GSTIN if the current privacy model treats it as restricted".
function safeTaxDisplay(value: string | null): string | null {
  return value === null || value.trim().length === 0 ? null : "On file";
}

export function computePayeeIdentityMatch(evidence: PayeeIdentityEvidence, now: () => Date = () => new Date()): PayeeIdentityMatchResult {
  const name = compareNames(evidence.expectedName, evidence.extractedName);
  const tax = compareTaxIds(evidence.expectedTaxId, evidence.extractedTaxId);
  const address = compareAddresses(evidence.expectedAddress, evidence.extractedAddress);
  const bank = compareBankIdentifiers(evidence.expectedBankIdentifier, evidence.extractedBankIdentifier);

  const fields: PayeeIdentityFieldResult[] = [
    { field: "NAME", status: name.status, confidence: name.confidence, reason: name.reason, safeExpectedDisplay: safeText(evidence.expectedName), safeExtractedDisplay: safeText(evidence.extractedName) },
    { field: "TAX_REGISTRATION", status: tax.status, confidence: tax.confidence, reason: tax.reason, safeExpectedDisplay: safeTaxDisplay(evidence.expectedTaxId), safeExtractedDisplay: safeTaxDisplay(evidence.extractedTaxId) },
    { field: "ADDRESS", status: address.status, confidence: address.confidence, reason: address.reason, safeExpectedDisplay: safeText(evidence.expectedAddress), safeExtractedDisplay: safeText(evidence.extractedAddress) },
    {
      field: "BANK",
      status: bank.status,
      confidence: bank.confidence,
      reason: bank.reason,
      safeExpectedDisplay: maskBankIdentifierLast4(evidence.expectedBankIdentifier),
      safeExtractedDisplay: maskBankIdentifierLast4(evidence.extractedBankIdentifier),
    },
  ];

  return {
    overallStatus: decideOverallStatus(fields),
    fields,
    warnings: buildWarnings(fields),
    comparedAt: now().toISOString(),
  };
}

function fieldOf(fields: PayeeIdentityFieldResult[], key: PayeeIdentityFieldResult["field"]): PayeeIdentityFieldResult {
  const found = fields.find((field) => field.field === key);
  if (!found) throw new Error(`Missing payee identity field ${key}.`);
  return found;
}

// Section 9/10 decision table, conservative by construction (never fabricates a MATCH):
//   1. A HARD mismatch (tax registration or bank, when both sides are available) or a clear NAME
//      mismatch always wins - "a hard mismatch must not be hidden by a matching address or similar
//      trading name" (section 10).
//   2. An ambiguous NAME (ADVISORY similarity band) or a contradicting ADDRESS needs a human to look
//      - REVIEW_REQUIRED, even though no HARD identifier actually conflicts.
//   3. A confident NAME match plus at least one exact hard corroborating identifier (tax or bank) is
//      the only path to MATCH.
//   4. A confident NAME match with no hard corroboration is the textbook PARTIAL_MATCH example from
//      section 9 ("name matches but GSTIN unavailable").
//   5. No usable evidence anywhere is INSUFFICIENT_EVIDENCE; some non-conflicting evidence short of
//      a confident name match is also PARTIAL_MATCH; otherwise INSUFFICIENT_EVIDENCE.
export function decideOverallStatus(fields: PayeeIdentityFieldResult[]): PayeeIdentityMatchResult["overallStatus"] {
  const name = fieldOf(fields, "NAME");
  const tax = fieldOf(fields, "TAX_REGISTRATION");
  const address = fieldOf(fields, "ADDRESS");
  const bank = fieldOf(fields, "BANK");

  const hardMismatch = tax.status === "MISMATCH" || bank.status === "MISMATCH" || name.status === "MISMATCH";
  if (hardMismatch) return "MISMATCH";

  const needsReview = name.status === "REVIEW_REQUIRED" || address.status === "MISMATCH";
  if (needsReview) return "REVIEW_REQUIRED";

  const nameConfidentMatch = name.status === "EXACT" || name.status === "NORMALIZED_MATCH";
  const hardCorroboration = tax.status === "EXACT" || bank.status === "EXACT";

  if (nameConfidentMatch && hardCorroboration) return "MATCH";
  if (nameConfidentMatch) return "PARTIAL_MATCH";

  const addressCorroboration = address.status === "EXACT" || address.status === "NORMALIZED_MATCH";
  if (hardCorroboration || addressCorroboration) return "PARTIAL_MATCH";

  return "INSUFFICIENT_EVIDENCE";
}

function buildWarnings(fields: PayeeIdentityFieldResult[]): string[] {
  const warnings: string[] = [];
  for (const field of fields) {
    if (field.status === "MISMATCH") warnings.push(field.reason ?? `The ${field.field.toLowerCase().replace("_", " ")} does not match.`);
  }
  return warnings;
}

export type PayeeIdentityApprovalBlocker = { code: "PAYEE_IDENTITY_MISMATCH"; message: string };

// The overall statuses section 11 explicitly says require an explicit human decision before
// approval - never silently passed through, never silently forced (section 12/16).
const BLOCKING_OVERALL_STATUSES: ReadonlyArray<PayeeIdentityOverallStatus> = ["MISMATCH", "REVIEW_REQUIRED"];

// Pure approval-gate decision (section 12), unit-testable without Firestore. `override` is the
// Invoice head's payeeMismatchOverride (or null); `versionNumber` is the version being approved.
export function payeeIdentityApprovalBlocker(
  payeeIdentity: PayeeIdentityMatchResult | null,
  override: { forVersion: number } | null,
  versionNumber: number,
): PayeeIdentityApprovalBlocker | null {
  if (!payeeIdentity) return null;
  if (!BLOCKING_OVERALL_STATUSES.includes(payeeIdentity.overallStatus)) return null;
  const accepted = override !== null && override.forVersion === versionNumber;
  if (accepted) return null;
  return { code: "PAYEE_IDENTITY_MISMATCH", message: "This invoice's payee identity does not clearly match the expected counterparty. Resolve the payee mismatch with a reason before approving." };
}

// The DISPLAY-only overall status (section 16): the stored evidence is NEVER rewritten, but once an
// authorized resolution exists for this exact version, the UI shows "Accepted with reason" instead
// of a raw MISMATCH/REVIEW_REQUIRED, while the original fields/evidence remain exactly as computed.
export function displayOverallStatus(payeeIdentity: PayeeIdentityMatchResult, override: { forVersion: number } | null, versionNumber: number): PayeeIdentityOverallStatus {
  if (override !== null && override.forVersion === versionNumber && BLOCKING_OVERALL_STATUSES.includes(payeeIdentity.overallStatus)) return "OVERRIDDEN";
  return payeeIdentity.overallStatus;
}
