import type { AgreementFieldKey } from "@/server/finance-agreements/fields";
import type { ConfirmedAgreementTerms, ContactSnapshot, IncentiveSlab, PerformanceTarget } from "@/server/finance-agreements/terms";

import {
  NEEDS_MAPPING_LABEL,
  TARGET_MONITORING_LABEL,
  agreementTypeLabel,
  fieldLabel,
  formatMoneyMinor,
  formatPlatformList,
  formatUtcDate,
  paymentCycleLabel,
  qualifyingUnitLabel,
  isSupportedQualifyingUnit,
} from "../format";

// Step 14B: the CONFIRMED structured terms of one Agreement version -> display rows (pure). Only frozen terms are ever mapped
// here - a draft has none. Two separate groups by design: the payment-affecting terms, and the warning-only performance targets
// (each of which always reads "Monitoring only · does not affect payment"). Money is integer minor units -> formatMoneyMinor;
// the qualifying unit goes through the label map (an unsupported wording is shown as written and marked "Needs mapping").
export const NOT_STATED_TEXT = "Not stated";
export const NOT_APPLICABLE_TEXT = "Not applicable";

export type TermRow = {
  key: string;
  // The registry field this row shows (used to mark changed fields in a revision); null for a composite row.
  fieldKey: AgreementFieldKey | null;
  label: string;
  value: string;
  // A quiet second line (a unit wording, a clause note ...).
  detail?: string | null;
  // A visible flag beside the value ("Needs mapping").
  flag?: string | null;
  // Long clause text keeps its line breaks.
  multiline?: boolean;
};

export type SlabRow = { slabRef: string; metric: string; range: string; amount: string; description: string | null };
export type FormatRuleRow = { format: string; rule: "LFC" | "SFC" };
export type TargetRow = { targetRef: string; metric: string; target: string; monitoring: typeof TARGET_MONITORING_LABEL };

export type TermsView = {
  agreement: TermRow[];
  platform: TermRow[];
  contact: TermRow[];
  // The payment-affecting terms (currency ... Agreement type). The LFC / SFC row exists only when the Agreement states one.
  commercial: TermRow[];
  slabs: SlabRow[];
  lfcSfc: FormatRuleRow[];
  // Warning-only targets: a separate group, never mixed into `commercial`.
  targets: TargetRow[];
  admin: TermRow[];
};

const METRIC_LABELS: Record<string, string> = {
  followerGrowth: "Follower growth",
  profileFollowers: "Profile followers",
  reach: "Reach",
  views: "Views",
  engagement: "Engagement",
  likes: "Likes",
  comments: "Comments",
};
export const metricLabel = (metricId: string): string => METRIC_LABELS[metricId] ?? metricId;

const row = (key: string, fieldKey: AgreementFieldKey | null, label: string, value: string, extra: Partial<Pick<TermRow, "detail" | "flag" | "multiline">> = {}): TermRow => ({ key, fieldKey, label, value, ...extra });

function text(value: string | null | undefined): string {
  return value === null || value === undefined || value.trim().length === 0 ? NOT_STATED_TEXT : value;
}

function yesNo(value: boolean | null): string {
  return value === null ? NOT_STATED_TEXT : value ? "Yes" : "No";
}

function textRow(key: string, fieldKey: AgreementFieldKey, value: string | null | undefined, extra: Partial<Pick<TermRow, "detail" | "flag" | "multiline">> = {}): TermRow {
  return row(key, fieldKey, fieldLabel(fieldKey), text(value), extra);
}

// { applicable, amountMinor, details? } components: null -> Not stated; not applicable -> Not applicable; else amount and / or details.
function componentValue(value: { applicable: boolean; amountMinor: number | null; details?: string | null } | null, currency: string | null): { value: string; detail: string | null } {
  if (value === null) return { value: NOT_STATED_TEXT, detail: null };
  if (!value.applicable) return { value: NOT_APPLICABLE_TEXT, detail: null };
  const amount = value.amountMinor === null ? null : formatMoneyMinor(value.amountMinor, currency ?? "INR");
  if (amount) return { value: amount, detail: value.details ?? null };
  return { value: value.details ?? "Applicable", detail: null };
}

export function slabRange(slab: Pick<IncentiveSlab, "lowerBound" | "upperBound" | "unit">): string {
  return slab.upperBound === null ? `${slab.lowerBound}+ ${slab.unit}` : `${slab.lowerBound} to ${slab.upperBound} ${slab.unit}`;
}

export function buildSlabRows(slabs: readonly IncentiveSlab[], currency: string | null): SlabRow[] {
  return slabs.map((slab) => ({
    slabRef: slab.slabRef,
    metric: metricLabel(slab.metricId),
    range: slabRange(slab),
    amount: formatMoneyMinor(slab.amountMinor, currency ?? "INR"),
    description: slab.description,
  }));
}

export function buildTargetRows(targets: readonly PerformanceTarget[]): TargetRow[] {
  // `affectsPayment` is the literal false in the stored terms; the row deliberately never renders anything but the monitoring label.
  return targets.map((target) => ({
    targetRef: target.targetRef,
    metric: metricLabel(target.metricId),
    target: `At least ${target.targetValue} ${target.unit}`,
    monitoring: TARGET_MONITORING_LABEL,
  }));
}

export function buildCommercialRows(terms: ConfirmedAgreementTerms): TermRow[] {
  const commercial = terms.commercial;
  const currency = commercial.currency;
  const rows: TermRow[] = [];

  rows.push(row("currency", "currency", fieldLabel("currency"), text(currency)));
  rows.push(row("paymentCycle", "paymentCycle", fieldLabel("paymentCycle"), commercial.paymentCycle === null ? NOT_STATED_TEXT : paymentCycleLabel(commercial.paymentCycle)));

  const fixed = componentValue(commercial.fixedComponent, currency);
  rows.push(row("fixedComponent", "fixedComponent", fieldLabel("fixedComponent"), fixed.value, { detail: fixed.detail }));

  rows.push(row("monthlyRequiredQualifyingContentCount", "monthlyRequiredQualifyingContentCount", fieldLabel("monthlyRequiredQualifyingContentCount"), commercial.monthlyRequiredQualifyingContentCount === null ? NOT_STATED_TEXT : String(commercial.monthlyRequiredQualifyingContentCount)));
  const unit = commercial.qualifyingUnit;
  rows.push(
    row("qualifyingUnit", "qualifyingUnit", fieldLabel("qualifyingUnit"), unit === null ? NOT_STATED_TEXT : qualifyingUnitLabel(unit), {
      flag: unit !== null && !isSupportedQualifyingUnit(unit) ? NEEDS_MAPPING_LABEL : null,
    }),
  );

  const transfer = componentValue(commercial.accountTransferFee, currency);
  rows.push(row("accountTransferFee", "accountTransferFee", fieldLabel("accountTransferFee"), transfer.value, { detail: transfer.detail }));
  const advance = componentValue(commercial.advancePayment, currency);
  rows.push(row("advancePayment", "advancePayment", fieldLabel("advancePayment"), advance.value, { detail: advance.detail }));

  rows.push(row("invoiceRequired", "invoiceRequired", fieldLabel("invoiceRequired"), yesNo(commercial.invoiceRequired)));
  rows.push(textRow("invoiceDueTerms", "invoiceDueTerms", commercial.invoiceDueTerms, { multiline: true }));
  rows.push(textRow("paymentDueTerms", "paymentDueTerms", commercial.paymentDueTerms, { multiline: true }));
  rows.push(textRow("servicesMandated", "servicesMandated", commercial.servicesMandated, { multiline: true }));

  const incentive = commercial.incentive;
  rows.push(
    row("incentive", "incentive", fieldLabel("incentive"), incentive === null ? NOT_STATED_TEXT : !incentive.applicable ? NOT_APPLICABLE_TEXT : `${incentive.slabs.length} slab${incentive.slabs.length === 1 ? "" : "s"}`),
  );

  // LFC / SFC exists in the UI ONLY when the Agreement states an explicit rule (null = not explicit; never guessed).
  if (commercial.lfcSfc !== null) {
    const count = Object.keys(commercial.lfcSfc.byFormat).length;
    rows.push(row("lfcSfc", "lfcSfc", fieldLabel("lfcSfc"), `${count} format${count === 1 ? "" : "s"}`, { detail: commercial.lfcSfc.ruleRef ?? null }));
  }

  rows.push(row("agreementType", "agreementType", fieldLabel("agreementType"), agreementTypeLabel(terms.agreementType), { detail: "Derived from the confirmed terms" }));
  return rows;
}

export function buildTermsView(terms: ConfirmedAgreementTerms, contact: ContactSnapshot | null): TermsView {
  const currency = terms.commercial.currency;
  const dates = terms.dates;
  const agreement: TermRow[] = [
    textRow("agreementNumber", "agreementNumber", terms.agreementNumber),
    row("signedDate", "signedDate", fieldLabel("signedDate"), dates.signedDate ? formatUtcDate(dates.signedDate) : NOT_STATED_TEXT),
    row("effectiveDate", "effectiveDate", fieldLabel("effectiveDate"), formatUtcDate(dates.effectiveFrom)),
    row("terminationDate", "terminationDate", fieldLabel("terminationDate"), dates.effectiveTo ? formatUtcDate(dates.effectiveTo) : NOT_STATED_TEXT),
    textRow("renewalTerms", "renewalTerms", terms.contractTerms.renewalTerms, { multiline: true }),
    textRow("noticeTerms", "noticeTerms", terms.contractTerms.noticeTerms, { multiline: true }),
    textRow("terminationTerms", "terminationTerms", terms.contractTerms.terminationTerms, { multiline: true }),
  ];

  const platform: TermRow[] = [
    row("platforms", "platforms", fieldLabel("platforms"), terms.platform.platforms.length === 0 ? NOT_STATED_TEXT : formatPlatformList(terms.platform.platforms)),
    textRow("collaboratorPageLink", "collaboratorPageLink", terms.platform.collaboratorPageLink),
    textRow("collaboratorPageName", "collaboratorPageName", terms.platform.collaboratorPageName),
  ];

  const contactRows: TermRow[] = contact
    ? [
        textRow("counterpartyName", "counterpartyName", contact.counterpartyName),
        textRow("contactNumber", "contactNumber", contact.contactNumber),
        textRow("emailAddress", "emailAddress", contact.emailAddress),
        textRow("state", "state", contact.state),
        textRow("address", "address", contact.address, { multiline: true }),
        textRow("pinCode", "pinCode", contact.pinCode),
      ]
    : [];

  const incentive = terms.commercial.incentive;
  const admin: TermRow[] = [
    row("onboardingProcessCompleted", "onboardingProcessCompleted", fieldLabel("onboardingProcessCompleted"), yesNo(terms.admin.onboardingProcessCompleted)),
    textRow("remarks", "remarks", terms.admin.remarks, { multiline: true }),
  ];

  return {
    agreement,
    platform,
    contact: contactRows,
    commercial: buildCommercialRows(terms),
    slabs: incentive && incentive.applicable ? buildSlabRows(incentive.slabs, currency) : [],
    lfcSfc: terms.commercial.lfcSfc ? Object.entries(terms.commercial.lfcSfc.byFormat).map(([format, rule]) => ({ format, rule })) : [],
    targets: buildTargetRows(terms.performanceTargets),
    admin,
  };
}

// The short commercial summary on the Overview: the terms a reader looks for first.
export function buildCommercialSummary(terms: ConfirmedAgreementTerms): TermRow[] {
  const keys = new Set(["agreementType", "fixedComponent", "monthlyRequiredQualifyingContentCount", "qualifyingUnit", "incentive", "paymentCycle", "currency"]);
  return buildCommercialRows(terms).filter((item) => keys.has(item.key));
}
