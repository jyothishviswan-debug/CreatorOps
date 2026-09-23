// Step 15C section 19/24: the Invoice extraction CONTRACT - foundation only in this step (no UI
// consumes it yet). Deliberately reuses the established shape/discipline from
// src/server/finance-agreements/extraction/extraction-types.ts rather than inventing a parallel
// one: proposal + confidence + warnings + page/source, ALWAYS `requiresHumanConfirmation: true`,
// restricted fields split from ordinary ones. The two domains stay separate modules (an Invoice's
// extraction never imports Agreement extraction STATE, only its pure, domain-agnostic PDF/parsing
// utilities - see field-extractors.ts).

export const INVOICE_EXTRACTED_FIELD_KEYS = [
  "externalInvoiceNumber",
  "invoiceDate",
  "supplierName",
  "currency",
  "subtotalMinor",
  "taxLabel",
  "taxRateBps",
  "taxAmountMinor",
  "declaredTotalMinor",
  "dueDate",
  "servicePeriod",
  // Restricted (see RESTRICTED_INVOICE_EXTRACTED_FIELD_KEYS below) - only through safe handling.
  "gstin",
] as const;
export type InvoiceExtractedFieldKey = (typeof INVOICE_EXTRACTED_FIELD_KEYS)[number];

// The ONE closed set of identity-sensitive Invoice field keys - mirrors Agreement extraction's own
// `RESTRICTED_EXTRACTED_FIELD_KEYS` discipline (types.ts's "No restricted identity value... is
// representable" rule, section 30 of the spec).
export const RESTRICTED_INVOICE_EXTRACTED_FIELD_KEYS = ["gstin"] as const satisfies readonly InvoiceExtractedFieldKey[];
export function isRestrictedInvoiceExtractedField(fieldKey: string): boolean {
  return (RESTRICTED_INVOICE_EXTRACTED_FIELD_KEYS as readonly string[]).includes(fieldKey);
}

export type InvoiceExtractionConfidence = "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN";

// A proposal is ALWAYS unconfirmed - `requiresHumanConfirmation` is the literal `true`, never a
// value that could be parsed as "verified". Nothing here writes an Invoice; a confirmation flow
// (not built in this step - see the module header) is what turns a proposal into a declared field.
export type InvoiceExtractedFieldProposal = {
  fieldKey: InvoiceExtractedFieldKey;
  // A restricted field's value is withheld at this layer (null) - the same defense-in-depth
  // "ordinary vs restricted" split as Agreement extraction's splitRestricted, applied at the
  // point of construction instead of a later split step, since Invoice extraction has only one
  // restricted key today.
  value: string | number | null;
  rawSnippet: string | null;
  page: number;
  confidence: InvoiceExtractionConfidence;
  warnings: string[];
  requiresHumanConfirmation: true;
  restricted: boolean;
};

export type InvoiceExtractionWarning = { code: string; fieldKey?: InvoiceExtractedFieldKey; page?: number };

export type InvoiceFieldExtractionResult = { fields: InvoiceExtractedFieldProposal[]; warnings: InvoiceExtractionWarning[] };

// --- Classification (mirrors Agreement extraction's ExtractionClassification) ------------------------------------------------
export const INVOICE_EXTRACTION_STATUSES = ["EXTRACTED", "PARTIAL", "MANUAL_REVIEW_REQUIRED"] as const;
export type InvoiceExtractionStatus = (typeof INVOICE_EXTRACTION_STATUSES)[number];

export const INVOICE_EXTRACTION_REASON_CODES = ["pdf_unreadable", "no_extractable_text", "missing_core_fields", "truncated", "low_confidence_core"] as const;
export type InvoiceExtractionReasonCode = (typeof INVOICE_EXTRACTION_REASON_CODES)[number];

export type InvoiceExtractionClassification = {
  status: InvoiceExtractionStatus;
  reasons: InvoiceExtractionReasonCode[];
  missingCore: InvoiceExtractedFieldKey[];
  fieldCount: number;
};

// The minimum an Invoice extraction must recover to be "EXTRACTED" rather than "PARTIAL"/"MANUAL
// REVIEW REQUIRED" - the two fields reconciliation.ts actually needs to compare against the
// Payable (declaredTotalMinor is section 18's reconciliation target; externalInvoiceNumber is the
// section 6 duplicate-detection key). Never PAN/Aadhaar/bank - those are never extracted at all.
export const INVOICE_CORE_REQUIRED_FIELDS: readonly InvoiceExtractedFieldKey[] = ["externalInvoiceNumber", "declaredTotalMinor"];
