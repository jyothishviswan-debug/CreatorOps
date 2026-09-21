// Step 14A: types shared by the deterministic field extractors and the
// extraction-result classifier. Self-contained on purpose: the string keys below
// are the SAME strings as AGREEMENT_FIELD_KEYS in ../fields.ts (the registry is
// the single source of truth; a test in the extraction service pass pins that
// every key here exists there).

export const EXTRACTED_FIELD_KEYS = [
  "counterpartyName",
  "contactNumber",
  "emailAddress",
  "state",
  "address",
  "pinCode",
  "gstin",
  "aadhaarNumber",
  "panNumber",
  "panHolderName",
  "bankAccountNumber",
  "ifsc",
  "collaboratorPageLink",
  "collaboratorPageName",
  "agreementNumber",
  "signedDate",
  "effectiveDate",
  "terminationDate",
  "renewalTerms",
  "noticeTerms",
  "terminationTerms",
  "currency",
  "paymentCycle",
  "fixedComponent",
  "monthlyRequiredQualifyingContentCount",
  "qualifyingUnit",
  "accountTransferFee",
  "advancePayment",
  "invoiceRequired",
  "invoiceDueTerms",
  "paymentDueTerms",
  "servicesMandated",
  "incentive",
  "lfcSfc",
  "performanceTargets",
] as const;
export type ExtractedFieldKey = (typeof EXTRACTED_FIELD_KEYS)[number];

// Identity fields: their VALUES (and every raw snippet) live only in the
// restricted extraction record - never in an Agreement doc, event or log.
export const RESTRICTED_EXTRACTED_FIELD_KEYS = ["gstin", "aadhaarNumber", "panNumber", "panHolderName", "bankAccountNumber", "ifsc"] as const satisfies readonly ExtractedFieldKey[];
const RESTRICTED_SET: ReadonlySet<string> = new Set(RESTRICTED_EXTRACTED_FIELD_KEYS);
export function isRestrictedExtractedField(fieldKey: string): boolean {
  return RESTRICTED_SET.has(fieldKey);
}

// Coarse, heuristic wording - never "certain". UNKNOWN is reserved for a
// caller that wants to record "label seen, value unusable"; the current rules
// omit such a field and emit a warning instead.
export type ExtractionConfidence = "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN";

export type ExtractedPaymentCycle = "WEEKLY" | "FORTNIGHTLY" | "MONTHLY" | "QUARTERLY" | "ONE_TIME" | "OTHER";

export type ExtractedIncentiveSlab = {
  slabRef: string;
  metricId: string;
  lowerBound: number;
  upperBound: number | null;
  unit: string;
  amountMinor: number;
  description: string | null;
};

export type ExtractedPerformanceTarget = {
  targetRef: string;
  metricId: string;
  targetValue: number;
  unit: string;
  comparison: "at_least";
  // ALWAYS false: a target only ever warns, it never changes a payment.
  affectsPayment: false;
};

// fieldKey -> typed normalizedValue. Shapes mirror the registry's value schemas.
export type ExtractedFieldValueMap = {
  counterpartyName: string;
  contactNumber: string; // +91XXXXXXXXXX
  emailAddress: string; // lowercased
  state: string; // canonical REGION_ZONES state
  address: string;
  pinCode: string; // 6 digits
  gstin: string;
  aadhaarNumber: string; // 12 digits, or a masked form (XXXXXXXX1234)
  panNumber: string;
  panHolderName: string;
  bankAccountNumber: string; // digits only
  ifsc: string;
  collaboratorPageLink: string;
  collaboratorPageName: string;
  agreementNumber: string;
  signedDate: string; // YYYY-MM-DD
  effectiveDate: string;
  terminationDate: string;
  renewalTerms: string;
  noticeTerms: string;
  terminationTerms: string;
  currency: "INR";
  paymentCycle: ExtractedPaymentCycle;
  fixedComponent: { applicable: boolean; amountMinor: number | null };
  monthlyRequiredQualifyingContentCount: number;
  qualifyingUnit: string; // the noun as written (e.g. "reel"); mapping to a supported unit is a human step
  accountTransferFee: { applicable: boolean; amountMinor: number | null; details: string | null };
  advancePayment: { applicable: boolean; details: string | null; amountMinor: number | null };
  invoiceRequired: boolean;
  invoiceDueTerms: string;
  paymentDueTerms: string;
  servicesMandated: string;
  incentive: { applicable: boolean; slabs: ExtractedIncentiveSlab[] };
  lfcSfc: { byFormat: Record<string, "LFC" | "SFC"> };
  performanceTargets: ExtractedPerformanceTarget[];
};

type ProposalBase = {
  // <= 300 chars around the match. RESTRICTED-record material: splitRestricted
  // strips it from the ordinary proposal.
  rawSnippet: string;
  // 1-based PDF page of the (first) match.
  page: number;
  confidence: ExtractionConfidence;
  // Stable machine codes only - never contract text or identity values.
  warnings: string[];
  requiresHumanConfirmation: true;
  restricted: boolean;
};

export type ExtractedFieldProposal = {
  [K in ExtractedFieldKey]: ProposalBase & { fieldKey: K; normalizedValue: ExtractedFieldValueMap[K] };
}[ExtractedFieldKey];

// Document-level note. `code` is a stable machine code; no values.
export type ExtractionWarning = { code: string; fieldKey?: ExtractedFieldKey; page?: number };

export type FieldExtractionResult = { fields: ExtractedFieldProposal[]; warnings: ExtractionWarning[] };
