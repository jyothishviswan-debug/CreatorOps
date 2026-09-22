import type { AgreementFieldDecisionKind, AgreementFieldKey } from "../fields";

// Step 14A: synthetic decision fixtures shared by the Agreement service unit and emulator tests.
// Every value is invented. `READY_DECISIONS` is a complete set of decisions that lets a version
// confirm (counterparty name, effective date, and every payment-affecting field decided) with the
// commercial structure FIXED + INCENTIVE + REQUIRED CONTENT.

export type FieldDecisionSeed = { fieldKey: AgreementFieldKey; decision: AgreementFieldDecisionKind; value?: unknown };

export const SAMPLE_INCENTIVE = {
  applicable: true,
  narrative: null,
  slabs: [{ slabRef: "slab-1", metricId: "views", lowerBound: 100_000, upperBound: 500_000, unit: "views", amountMinor: 250_000, description: null }],
};

export const SAMPLE_TARGETS = [{ targetRef: "target-1", metricId: "followerGrowth", targetValue: 1000, unit: "followers", comparison: "at_least", period: null, anchor: null, affectsPayment: false }];

export const READY_DECISIONS: FieldDecisionSeed[] = [
  { fieldKey: "counterpartyName", decision: "CORRECTED", value: "Acme Talent Private Limited" },
  { fieldKey: "signedDate", decision: "ACCEPTED", value: "2023-12-20" },
  { fieldKey: "effectiveDate", decision: "CORRECTED", value: "2024-01-01" },
  { fieldKey: "terminationDate", decision: "CORRECTED", value: "2024-12-31" },
  { fieldKey: "currency", decision: "CORRECTED", value: "INR" },
  { fieldKey: "paymentCycle", decision: "CORRECTED", value: "MONTHLY" },
  { fieldKey: "fixedComponent", decision: "CORRECTED", value: { applicable: true, amountMinor: 5_000_000 } },
  { fieldKey: "monthlyRequiredQualifyingContentCount", decision: "CORRECTED", value: 8 },
  { fieldKey: "qualifyingUnit", decision: "CORRECTED", value: "reel" },
  { fieldKey: "accountTransferFee", decision: "NOT_APPLICABLE" },
  { fieldKey: "advancePayment", decision: "NOT_APPLICABLE" },
  { fieldKey: "invoiceRequired", decision: "CORRECTED", value: true },
  { fieldKey: "invoiceDueTerms", decision: "CORRECTED", value: "Invoice by the 5th of the following month" },
  { fieldKey: "paymentDueTerms", decision: "CORRECTED", value: "Payment within 30 days of invoice" },
  { fieldKey: "servicesMandated", decision: "CORRECTED", value: "Creation and posting of short-form video content" },
  { fieldKey: "incentive", decision: "CORRECTED", value: SAMPLE_INCENTIVE },
  { fieldKey: "lfcSfc", decision: "CORRECTED", value: { byFormat: { reel: "SFC" } } },
  { fieldKey: "monetisationTerms", decision: "NOT_APPLICABLE" },
  { fieldKey: "performanceTargets", decision: "CORRECTED", value: SAMPLE_TARGETS },
];
