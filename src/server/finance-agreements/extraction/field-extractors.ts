import { extractAccountTransferFee, extractAdvancePayment, extractCurrency, extractDueTerms, extractFixedComponent, extractInvoiceRequired, extractLfcSfc, extractPaymentCycle, extractRequiredContent, extractServicesMandated } from "./commercial-rules";
import { EXTRACTED_FIELD_KEYS, type FieldExtractionResult } from "./extraction-types";
import { extractAadhaar, extractAddressPinState, extractBankAccount, extractContactNumber, extractCounterpartyName, extractEmail, extractGstin, extractIfsc, extractPan, extractPanHolderName } from "./identity-rules";
import { extractIncentive, extractPerformanceTargets } from "./incentive-target-rules";
import { createContext, warn, type RuleContext } from "./rule-context";
import { extractAgreementNumber, extractClauses, extractDates, extractPageLinkAndName } from "./term-rules";
import { buildDoc } from "./text-utils";

export type { ExtractedFieldProposal, ExtractedFieldKey, ExtractionConfidence, ExtractionWarning, FieldExtractionResult } from "./extraction-types";

// Step 14A: deterministic, PURE field extraction from already-extracted PDF text
// (one string per page). Rules are label-anchored or format-anchored only - a
// value that cannot be tied to a label or a strict format is not proposed, and
// ambiguity yields LOW confidence or an omission plus a document-level warning.
//
// Everything returned is a PROPOSAL: requiresHumanConfirmation is always true.
// The contract text is DATA - no rule interprets an instruction inside it, and
// there is no rule that could produce an Agreement STATUS or TYPE (CreatorOps
// derives those). Restricted identity fields are flagged `restricted: true`;
// see extraction-result.ts splitRestricted for how they are stored.

// Rule order is irrelevant to the output order (results are sorted by field key
// order) except where a rule reads another's proposal (PAN cross-checks GSTIN,
// PIN/state may derive from the address).
const RULES: ReadonlyArray<readonly [string, (ctx: RuleContext) => void]> = [
  ["counterpartyName", extractCounterpartyName],
  ["contactNumber", extractContactNumber],
  ["emailAddress", extractEmail],
  ["addressPinState", extractAddressPinState],
  ["gstin", extractGstin],
  ["panNumber", extractPan],
  ["panHolderName", extractPanHolderName],
  ["aadhaarNumber", extractAadhaar],
  ["bankAccountNumber", extractBankAccount],
  ["ifsc", extractIfsc],
  ["pageLinkAndName", extractPageLinkAndName],
  ["agreementNumber", extractAgreementNumber],
  ["dates", extractDates],
  ["clauses", extractClauses],
  ["currency", extractCurrency],
  ["paymentCycle", extractPaymentCycle],
  ["fixedComponent", extractFixedComponent],
  ["requiredContent", extractRequiredContent],
  ["accountTransferFee", extractAccountTransferFee],
  ["advancePayment", extractAdvancePayment],
  ["invoiceRequired", extractInvoiceRequired],
  ["dueTerms", extractDueTerms],
  ["servicesMandated", extractServicesMandated],
  ["incentive", extractIncentive],
  ["lfcSfc", extractLfcSfc],
  ["performanceTargets", extractPerformanceTargets],
];

const FIELD_ORDER: ReadonlyMap<string, number> = new Map(EXTRACTED_FIELD_KEYS.map((key, index) => [key, index]));

export function extractAgreementFields(pages: string[]): FieldExtractionResult {
  const ctx = createContext(buildDoc(pages));
  for (const [name, rule] of RULES) {
    try {
      rule(ctx);
    } catch {
      // A rule bug must not lose every other field, and must never surface
      // contract text: record only a stable code.
      warn(ctx, `rule_error:${name}`);
    }
  }
  const fields = [...ctx.fields].sort((a, b) => (FIELD_ORDER.get(a.fieldKey) ?? 0) - (FIELD_ORDER.get(b.fieldKey) ?? 0));
  return { fields, warnings: ctx.warnings };
}
