import { checkFieldDecisionValue, deriveAgreementType, type AgreementFieldDecisionKind, type AgreementFieldKey } from "@/server/finance-agreements/fields";
import {
  MAX_AGREEMENT_PLATFORMS,
  MAX_CONTENT_OBLIGATIONS,
  MAX_INCENTIVE_SLABS,
  MAX_LFC_SFC_FORMATS,
  MAX_PERFORMANCE_TARGETS,
  PAYMENT_CYCLES,
  type AccountTransferFee,
  type AdvancePayment,
  type AgreementType,
  type ContentObligation,
  type FixedComponent,
  type Incentive,
  type IncentiveSlab,
  type LfcSfc,
  type PerformanceTarget,
} from "@/server/finance-agreements/terms";
import { normalizePlatformIdentifier } from "@/server/shared/platform";

import { fieldLabel, isSupportedQualifyingUnit, isUtcDate, parseMoneyInputToMinor } from "./format";
import { qualifyingPairIssue } from "./qualifying-unit";

// Step 14B: client-side validators for the editors of the commercial terms and the other field types (pure).
// They MIRROR the server's own rules (terms.ts schemas + checkFieldDecisionValue) so a person sees a friendly,
// field-level message BEFORE a round trip - and `validateFieldValue` runs the server's own checkFieldDecisionValue as
// the final authority, so a client rule can never be looser than the server's. The server still re-validates everything.
//
// Money: amounts are typed as rupees and converted to integer minor units (paise) with parseMoneyInputToMinor - no floats.
export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };
const fail = (...errors: string[]): { ok: false; errors: string[] } => ({ ok: false, errors });
const okResult = <T>(value: T): { ok: true; value: T } => ({ ok: true, value });

// The server's own decision/value check (identity fields carry no value; NOT_APPLICABLE / UNAVAILABLE carry none; a value is
// validated against the field's schema). Use as the last step before decideField.
export function validateFieldValue(fieldKey: AgreementFieldKey, decision: AgreementFieldDecisionKind, value: unknown): ValidationResult<unknown> {
  const check = checkFieldDecisionValue(fieldKey, decision, value);
  return check.ok ? okResult(check.value) : fail(check.message);
}

// --- Text -----------------------------------------------------------------------------------------------------------------------------
// Max TRIMMED length per text field (terms.ts). Every value is trimmed and must be non-empty.
export const TEXT_FIELD_LIMITS = {
  counterpartyName: 200,
  contactNumber: 40,
  emailAddress: 300,
  state: 100,
  address: 500,
  agreementNumber: 100,
  collaboratorPageLink: 500,
  collaboratorPageName: 200,
  renewalTerms: 10_000,
  noticeTerms: 10_000,
  terminationTerms: 10_000,
  servicesMandated: 10_000,
  monetisationTerms: 10_000,
  performanceEvaluationClause: 10_000,
  invoiceDueTerms: 2000,
  paymentDueTerms: 2000,
  remarks: 2000,
} as const satisfies Partial<Record<AgreementFieldKey, number>>;
export type TextFieldKey = keyof typeof TEXT_FIELD_LIMITS;

// Client-side SHAPE checks for the two contact fields (the server accepts any short text for them - a backend gap; this only stops an
// obvious typo before it is saved on an Agreement). Deliberately basic: an address needs one "@", no spaces and a dotted domain; a phone
// number is digits with an optional leading "+" and common separators, 7 to 15 digits (E.164 length).
const EMAIL_SHAPE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;
const PHONE_CHARACTERS = /^\+?[\d\s().-]+$/;
const PHONE_MIN_DIGITS = 7;
const PHONE_MAX_DIGITS = 15;

export function validateEmailShape(text: string): ValidationResult<string> {
  const trimmed = text.trim();
  return EMAIL_SHAPE.test(trimmed) ? okResult(trimmed) : fail("Enter a valid email address, for example name@example.com.");
}

export function validatePhoneShape(text: string): ValidationResult<string> {
  const trimmed = text.trim();
  const digits = trimmed.replace(/\D/g, "").length;
  if (!PHONE_CHARACTERS.test(trimmed) || digits < PHONE_MIN_DIGITS || digits > PHONE_MAX_DIGITS) return fail(`Enter a phone number with ${PHONE_MIN_DIGITS} to ${PHONE_MAX_DIGITS} digits, optionally starting with + (spaces, dashes and brackets are fine).`);
  return okResult(trimmed);
}

export function validateTextField(fieldKey: TextFieldKey | "pinCode", text: string): ValidationResult<string> {
  const trimmed = text.trim();
  const label = fieldLabel(fieldKey);
  if (trimmed.length === 0) return fail(`Enter ${label.toLowerCase()}, or choose Not applicable / Unavailable.`);
  if (fieldKey === "pinCode") return /^\d{6}$/.test(trimmed) ? okResult(trimmed) : fail("Enter a 6-digit PIN code.");
  const max = TEXT_FIELD_LIMITS[fieldKey];
  if (trimmed.length > max) return fail(`${label} can be at most ${max.toLocaleString("en-IN")} characters.`);
  if (fieldKey === "emailAddress") return validateEmailShape(trimmed);
  if (fieldKey === "contactNumber") return validatePhoneShape(trimmed);
  return okResult(trimmed);
}

// --- Dates ---------------------------------------------------------------------------------------------------------------------------------
export function validateDateField(text: string): ValidationResult<string> {
  const trimmed = text.trim();
  if (trimmed.length === 0) return fail("Enter a date, or choose Not applicable / Unavailable.");
  return isUtcDate(trimmed) ? okResult(trimmed) : fail("Enter a real calendar date (YYYY-MM-DD).");
}

// The termination date cannot precede the effective date (both YYYY-MM-DD; lexical order is calendar order).
export function validateDateOrder(effectiveDate: string | null, terminationDate: string | null): string | null {
  if (effectiveDate && terminationDate && terminationDate < effectiveDate) return "The termination date cannot precede the effective date.";
  return null;
}

// --- Currency / payment cycle / count -----------------------------------------------------------------------------------------------------------
export function validateCurrency(text: string): ValidationResult<string> {
  const code = text.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? okResult(code) : fail("Enter a 3-letter currency code, for example INR.");
}

export function validatePaymentCycle(value: string): ValidationResult<string> {
  return (PAYMENT_CYCLES as readonly string[]).includes(value) ? okResult(value) : fail("Choose a payment cycle from the list.");
}

export const MAX_QUALIFYING_CONTENT_COUNT = 100_000;
export function validateQualifyingCount(text: string): ValidationResult<number> {
  const trimmed = text.trim();
  if (trimmed.length === 0) return fail("Enter a count, or choose Not applicable / Unavailable.");
  if (!/^\d+$/.test(trimmed)) return fail("Enter a whole number.");
  const count = Number(trimmed);
  if (!Number.isSafeInteger(count) || count > MAX_QUALIFYING_CONTENT_COUNT) return fail(`The count can be at most ${MAX_QUALIFYING_CONTENT_COUNT.toLocaleString("en-IN")}.`);
  return okResult(count);
}

// Only the two supported operational units; anything else must be mapped by the person first.
export function validateQualifyingUnit(value: string): ValidationResult<string> {
  return isSupportedQualifyingUnit(value) ? okResult(value) : fail("Choose Approved Content or Approved current link.");
}

// --- Platforms -----------------------------------------------------------------------------------------------------------------------------
// Normalized lower-case; the server REJECTS duplicates (it does not dedupe), so they are reported here.
export function validatePlatforms(values: readonly string[]): ValidationResult<string[]> {
  const normalized = values.map((value) => normalizePlatformIdentifier(value)).filter((value) => value.length > 0);
  if (normalized.length === 0) return fail("Choose at least one platform, or choose Not applicable / Unavailable.");
  if (normalized.length > MAX_AGREEMENT_PLATFORMS) return fail(`At most ${MAX_AGREEMENT_PLATFORMS} platforms.`);
  if (normalized.some((value) => value.length > 60)) return fail("A platform name can be at most 60 characters.");
  if (new Set(normalized).size !== normalized.length) return fail("Each platform can be listed once.");
  return okResult(normalized);
}

// --- Money components ----------------------------------------------------------------------------------------------------------------------
export type MoneyComponentDraft = { applicable: boolean; amountText: string; details?: string };

function optionalAmount(text: string, label: string): ValidationResult<number | null> {
  if (text.trim().length === 0) return okResult(null);
  const parsed = parseMoneyInputToMinor(text);
  return parsed.ok ? okResult(parsed.amountMinor) : fail(`${label}: ${parsed.message}`);
}

function optionalDetails(text: string | undefined, max: number, label: string): ValidationResult<string | null> {
  const trimmed = (text ?? "").trim();
  if (trimmed.length === 0) return okResult(null);
  return trimmed.length > max ? fail(`${label} details can be at most ${max.toLocaleString("en-IN")} characters.`) : okResult(trimmed);
}

// applicable => an amount is required; not applicable => no amount (prefer the NOT_APPLICABLE decision over an applicable:false object).
export function buildFixedComponent(draft: MoneyComponentDraft): ValidationResult<FixedComponent> {
  if (!draft.applicable) return okResult({ applicable: false, amountMinor: null });
  if (draft.amountText.trim().length === 0) return fail("Enter the fixed amount.");
  const amount = optionalAmount(draft.amountText, "Fixed amount");
  if (!amount.ok) return amount;
  return okResult({ applicable: true, amountMinor: amount.value });
}

// applicable => an amount OR details; not applicable => neither.
export function buildAccountTransferFee(draft: MoneyComponentDraft): ValidationResult<AccountTransferFee> {
  if (!draft.applicable) return okResult({ applicable: false, amountMinor: null, details: null });
  const amount = optionalAmount(draft.amountText, "Account transfer fee");
  if (!amount.ok) return amount;
  const details = optionalDetails(draft.details, 1000, "Account transfer fee");
  if (!details.ok) return details;
  if (amount.value === null && details.value === null) return fail("Enter the account transfer fee amount or its details.");
  return okResult({ applicable: true, amountMinor: amount.value, details: details.value });
}

// applicable => an amount OR details; not applicable => neither.
export function buildAdvancePayment(draft: MoneyComponentDraft): ValidationResult<AdvancePayment> {
  if (!draft.applicable) return okResult({ applicable: false, details: null, amountMinor: null });
  const amount = optionalAmount(draft.amountText, "Advance payment");
  if (!amount.ok) return amount;
  const details = optionalDetails(draft.details, 2000, "Advance payment");
  if (!details.ok) return details;
  if (amount.value === null && details.value === null) return fail("Enter the advance payment amount or its details.");
  return okResult({ applicable: true, details: details.value, amountMinor: amount.value });
}

// --- Incentive slabs ---------------------------------------------------------------------------------------------------------------------------
export type IncentiveSlabDraft = { slabRef?: string; metricId: string; lowerBoundText: string; upperBoundText: string; unit: string; amountText: string; description?: string };

function parseBound(text: string, label: string): ValidationResult<number> {
  const trimmed = text.replace(/,/g, "").trim();
  if (trimmed.length === 0) return fail(`${label}: enter a number.`);
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return fail(`${label}: enter a number that is not negative.`);
  const value = Number(trimmed);
  return Number.isFinite(value) ? okResult(value) : fail(`${label}: enter a smaller number.`);
}

// FINAL_EXECUTION #16: an applicable incentive needs a narrative OR structured slabs (never forced to invent slabs
// out of a discretionary clause). `narrativeText` is trimmed; an empty string means "no narrative".
export function buildIncentive(input: { applicable: boolean; narrativeText?: string; slabs: readonly IncentiveSlabDraft[] }): ValidationResult<Incentive> {
  if (!input.applicable) return okResult({ applicable: false, narrative: null, slabs: [] });
  const narrative = (input.narrativeText ?? "").trim();
  if (narrative.length > 2000) return fail("The incentive narrative can be at most 2000 characters.");
  if (input.slabs.length === 0 && narrative.length === 0) return fail("Add a narrative or at least one slab, or mark the incentive not applicable.");
  if (input.slabs.length === 0) return okResult({ applicable: true, narrative, slabs: [] });
  if (input.slabs.length > MAX_INCENTIVE_SLABS) return fail(`At most ${MAX_INCENTIVE_SLABS} slabs.`);

  const errors: string[] = [];
  const slabs: IncentiveSlab[] = [];
  const seen = new Set<string>();
  input.slabs.forEach((draft, index) => {
    const n = index + 1;
    const slabErrors: string[] = [];
    const metricId = draft.metricId.trim();
    const unit = draft.unit.trim();
    const description = (draft.description ?? "").trim();
    if (metricId.length === 0 || metricId.length > 100) slabErrors.push(`Slab ${n}: enter the metric (up to 100 characters).`);
    if (unit.length === 0 || unit.length > 60) slabErrors.push(`Slab ${n}: enter the unit (up to 60 characters).`);
    if (description.length > 500) slabErrors.push(`Slab ${n}: the description can be at most 500 characters.`);

    const lower = parseBound(draft.lowerBoundText, `Slab ${n} lower bound`);
    if (!lower.ok) slabErrors.push(...lower.errors);
    let upper: number | null = null;
    if (draft.upperBoundText.trim().length > 0) {
      const parsedUpper = parseBound(draft.upperBoundText, `Slab ${n} upper bound`);
      if (!parsedUpper.ok) slabErrors.push(...parsedUpper.errors);
      else upper = parsedUpper.value;
    }
    if (lower.ok && upper !== null && upper <= lower.value) slabErrors.push(`Slab ${n}: the upper bound must exceed the lower bound.`);

    const amount = parseMoneyInputToMinor(draft.amountText);
    if (!amount.ok) slabErrors.push(`Slab ${n} amount: ${amount.message}`);

    const slabRef = (draft.slabRef ?? "").trim() || `slab-${n}`;
    if (slabRef.length > 100) slabErrors.push(`Slab ${n}: the reference can be at most 100 characters.`);
    if (seen.has(slabRef)) slabErrors.push(`Slab ${n}: slab references must be unique.`);
    seen.add(slabRef);

    if (slabErrors.length > 0) errors.push(...slabErrors);
    else if (lower.ok && amount.ok) slabs.push({ slabRef, metricId, lowerBound: lower.value, upperBound: upper, unit, amountMinor: amount.amountMinor, description: description.length > 0 ? description : null });
  });
  return errors.length > 0 ? fail(...errors) : okResult({ applicable: true, narrative: narrative.length > 0 ? narrative : null, slabs });
}

// --- LFC / SFC (only when the Agreement states the rule explicitly) ------------------------------------------------------------------------------
export type LfcSfcRowDraft = { format: string; kind: "LFC" | "SFC" };

export function buildLfcSfc(input: { ruleRef?: string; rows: readonly LfcSfcRowDraft[] }): ValidationResult<LfcSfc> {
  if (input.rows.length === 0) return fail("Add at least one format, or leave the LFC / SFC rule Unavailable.");
  if (input.rows.length > MAX_LFC_SFC_FORMATS) return fail(`At most ${MAX_LFC_SFC_FORMATS} formats.`);
  const errors: string[] = [];
  const byFormat: Record<string, "LFC" | "SFC"> = {};
  input.rows.forEach((row, index) => {
    const format = row.format.trim();
    if (format.length === 0 || format.length > 60) errors.push(`Format ${index + 1}: enter a name (up to 60 characters).`);
    else if (Object.prototype.hasOwnProperty.call(byFormat, format)) errors.push(`Format "${format}" is listed more than once.`);
    else if (row.kind !== "LFC" && row.kind !== "SFC") errors.push(`Format ${index + 1}: choose LFC or SFC.`);
    else byFormat[format] = row.kind;
  });
  const ruleRef = (input.ruleRef ?? "").trim();
  if (ruleRef.length > 200) errors.push("The rule reference can be at most 200 characters.");
  if (errors.length > 0) return fail(...errors);
  return okResult(ruleRef.length > 0 ? { ruleRef, byFormat } : { byFormat });
}

// --- Performance targets (warning-only) -----------------------------------------------------------------------------------------------------------
// FINAL_EXECUTION #18: periodText/anchorText carry the CONTRACT's own wording verbatim (never invented) - an empty
// string means the contract does not state one ("Period not specified"), not any assumed cadence.
export type PerformanceTargetDraft = { targetRef?: string; metricId: string; targetValueText: string; unit: string; periodText?: string; anchorText?: string };

// `affectsPayment` is ALWAYS false and `comparison` is always "at_least": neither can be set by the caller.
export function buildPerformanceTargets(rows: readonly PerformanceTargetDraft[]): ValidationResult<PerformanceTarget[]> {
  if (rows.length > MAX_PERFORMANCE_TARGETS) return fail(`At most ${MAX_PERFORMANCE_TARGETS} targets.`);
  const errors: string[] = [];
  const targets: PerformanceTarget[] = [];
  const seen = new Set<string>();
  rows.forEach((row, index) => {
    const n = index + 1;
    const metricId = row.metricId.trim();
    const unit = row.unit.trim();
    const rowErrors: string[] = [];
    if (metricId.length === 0 || metricId.length > 100) rowErrors.push(`Target ${n}: choose the metric.`);
    if (unit.length === 0 || unit.length > 60) rowErrors.push(`Target ${n}: enter the unit (up to 60 characters).`);
    const valueText = row.targetValueText.replace(/,/g, "").trim();
    const targetValue = Number(valueText);
    if (valueText.length === 0 || !/^-?\d+(\.\d+)?$/.test(valueText) || !Number.isFinite(targetValue)) rowErrors.push(`Target ${n}: enter the target value as a number.`);
    const targetRef = (row.targetRef ?? "").trim() || `target-${n}`;
    if (targetRef.length > 200) rowErrors.push(`Target ${n}: the reference can be at most 200 characters.`);
    if (seen.has(targetRef)) rowErrors.push(`Target ${n}: target references must be unique.`);
    seen.add(targetRef);
    const period = (row.periodText ?? "").trim();
    const anchor = (row.anchorText ?? "").trim();
    if (period.length > 200) rowErrors.push(`Target ${n}: the period can be at most 200 characters.`);
    if (anchor.length > 200) rowErrors.push(`Target ${n}: the anchor can be at most 200 characters.`);
    if (rowErrors.length > 0) errors.push(...rowErrors);
    else targets.push({ targetRef, metricId, targetValue, unit, comparison: "at_least", period: period.length > 0 ? period : null, anchor: anchor.length > 0 ? anchor : null, affectsPayment: false });
  });
  return errors.length > 0 ? fail(...errors) : okResult(targets);
}

// --- Content obligations (FINAL_EXECUTION #15: repeatable, additive alongside the single scalar count/unit pair) --------------------------------
// `operationalMappingText` empty = "Needs mapping" (never silently mapped); `periodText` empty = the contract does not state one.
export type ContentObligationDraft = { obligationRef?: string; label: string; quantityText: string; periodText?: string; operationalMappingText?: string };
export const blankObligation = (): ContentObligationDraft => ({ label: "", quantityText: "" });

export function buildContentObligations(rows: readonly ContentObligationDraft[]): ValidationResult<ContentObligation[]> {
  if (rows.length > MAX_CONTENT_OBLIGATIONS) return fail(`At most ${MAX_CONTENT_OBLIGATIONS} content obligations.`);
  const errors: string[] = [];
  const obligations: ContentObligation[] = [];
  const seen = new Set<string>();
  rows.forEach((row, index) => {
    const n = index + 1;
    const label = row.label.trim();
    const rowErrors: string[] = [];
    if (label.length === 0 || label.length > 200) rowErrors.push(`Obligation ${n}: enter a label (up to 200 characters).`);
    const quantityText = row.quantityText.replace(/,/g, "").trim();
    const quantity = Number(quantityText);
    if (quantityText.length === 0 || !/^\d+$/.test(quantityText) || !Number.isFinite(quantity) || quantity < 0 || quantity > 100_000) rowErrors.push(`Obligation ${n}: enter the quantity as a whole number.`);
    const obligationRef = (row.obligationRef ?? "").trim() || `obligation-${n}`;
    if (obligationRef.length > 100) rowErrors.push(`Obligation ${n}: the reference can be at most 100 characters.`);
    if (seen.has(obligationRef)) rowErrors.push(`Obligation ${n}: obligation references must be unique.`);
    seen.add(obligationRef);
    const period = (row.periodText ?? "").trim();
    const operationalMapping = (row.operationalMappingText ?? "").trim();
    if (period.length > 60) rowErrors.push(`Obligation ${n}: the period can be at most 60 characters.`);
    if (operationalMapping.length > 100) rowErrors.push(`Obligation ${n}: the operational mapping can be at most 100 characters.`);
    if (rowErrors.length > 0) errors.push(...rowErrors);
    else obligations.push({ obligationRef, label, quantity, period: period.length > 0 ? period : null, operationalMapping: operationalMapping.length > 0 ? operationalMapping : null });
  });
  return errors.length > 0 ? fail(...errors) : okResult(obligations);
}

// --- Cross-field rules of the assembled commercial terms (terms.ts superRefine) --------------------------------------------------------------------
export type CommercialTermsInput = {
  currency: string | null;
  fixedComponent: { applicable: boolean; amountMinor: number | null } | null;
  accountTransferFee: { applicable: boolean; amountMinor: number | null } | null;
  advancePayment: { applicable: boolean; amountMinor: number | null } | null;
  incentive: { applicable: boolean; slabs: readonly unknown[] } | null;
  monthlyRequiredQualifyingContentCount: number | null;
  qualifyingUnit: string | null;
};

export type CommercialIssue = { fieldKey: AgreementFieldKey; message: string };

export function hasAnyAmount(terms: Pick<CommercialTermsInput, "fixedComponent" | "accountTransferFee" | "advancePayment" | "incentive">): boolean {
  return (terms.fixedComponent?.amountMinor ?? null) !== null || (terms.accountTransferFee?.amountMinor ?? null) !== null || (terms.advancePayment?.amountMinor ?? null) !== null || (terms.incentive?.slabs.length ?? 0) > 0;
}

// The same cross-field rules the server applies at confirm: any amount needs a currency; the required count and its unit go together
// (and the unit must be a supported one).
export function validateCommercialTerms(terms: CommercialTermsInput): CommercialIssue[] {
  const issues: CommercialIssue[] = [];
  if (hasAnyAmount(terms) && terms.currency === null) issues.push({ fieldKey: "currency", message: "A currency is required when any amount is present." });
  const pair = qualifyingPairIssue(terms.monthlyRequiredQualifyingContentCount, terms.qualifyingUnit);
  if (pair) issues.push(pair);
  return issues;
}

// The Agreement type the server WILL derive from the commercial structure (a preview only: the server is authoritative and an
// extractor's guess is never read). null inputs mean "not stated".
export function previewAgreementType(terms: { fixedComponent: { applicable: boolean } | null; incentive: { applicable: boolean; slabs: readonly unknown[] } | null; monthlyRequiredQualifyingContentCount: number | null }): AgreementType {
  return deriveAgreementType({ commercial: { fixedComponent: terms.fixedComponent, incentive: terms.incentive, monthlyRequiredQualifyingContentCount: terms.monthlyRequiredQualifyingContentCount } });
}
