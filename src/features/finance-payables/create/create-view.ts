// Step 15B: the PURE view/adapter logic behind the Create Payable flow (Source -> Review amount ->
// Confirm). Nothing here calls the network or touches the DOM - every function maps a DTO already in
// hand to what a screen renders, so it is unit-testable in isolation and the three stages, the tests and
// each other can never disagree about what a given server response means.
import { formatSignedMoneyMinor, lineCategoryLabel, lineSourceLabel, reviewCodeComponentLabel, type ChipSpec } from "../format";
import type { PayableLineDto, PayableSnapshotDto, PayableSourcePreviewDto } from "@/server/finance-payables/client-dto";
import type { PayableReviewCode } from "@/server/finance-payables/types";

export type CreateStage = 1 | 2 | 3;
export const CREATE_STAGE_LABELS: Record<CreateStage, string> = { 1: "Source", 2: "Review amount", 3: "Confirm" };

// --- Stage 1: Source --------------------------------------------------------------------------------------------------------------
export type SourceReadiness = { canContinue: boolean; blocked: boolean; blockerMessages: string[]; reviewMessages: string[] };

// `FINANCE_REVIEW_REQUIRED` may still continue (the backend allows creating a DRAFT with open review
// items); `BLOCKED` can never continue - generation itself was refused.
export function sourceReadiness(preview: PayableSourcePreviewDto | null): SourceReadiness {
  if (preview === null) return { canContinue: false, blocked: false, blockerMessages: [], reviewMessages: [] };
  const blocked = preview.determinationState === "BLOCKED";
  return {
    canContinue: !blocked,
    blocked,
    blockerMessages: preview.blockers.map((blocker) => blocker.message),
    reviewMessages: preview.unresolved.map((item) => item.message),
  };
}

export type SourceEvidenceSummaryRow = { label: string; value: string };

// The compact "resolved evidence" summary shown on the right of Stage 1 once a source resolves.
export function sourceEvidenceSummary(preview: PayableSourcePreviewDto): SourceEvidenceSummaryRow[] {
  const rows: SourceEvidenceSummaryRow[] = [];
  if (preview.agreementRef) rows.push({ label: "Agreement", value: `${preview.agreementRef}${preview.agreementVersion ? ` · v${preview.agreementVersion}` : ""}` });
  if (preview.reviewRef) rows.push({ label: "Partner Review", value: `${preview.reviewRef}${preview.reviewVersion ? ` · v${preview.reviewVersion}` : ""}` });
  rows.push({ label: "Commercial period", value: preview.commercialPeriod.periodKey });
  rows.push({ label: "Currency", value: preview.currency ?? "Not resolved" });
  if (preview.existingPayableRef) rows.push({ label: "Existing Payable", value: preview.existingPayableRef });
  return rows;
}

// --- Stage 2 / Detail: amount breakdown -------------------------------------------------------------------------------------------
// One unified row for the breakdown table: either a concrete, calculated line, or an unresolved item
// that still needs Finance to act (no money yet). Both come from the same server response, so a screen
// never invents contract interpretation the backend didn't already decide.
export type BreakdownRowView =
  | { kind: "line"; key: string; component: string; basis: string; amountText: string; source: string; status: ChipSpec; manual: boolean; lineRef: string }
  | { kind: "unresolved"; key: string; component: string; basis: string; amountText: string; source: string; status: ChipSpec; code: PayableReviewCode };

const CALCULATED_CHIP: ChipSpec = { label: "Calculated", tone: "default" };
const REVIEW_CHIP: ChipSpec = { label: "Needs Finance review", tone: "orange" };

export function breakdownLineRow(line: PayableLineDto, currency: string, amountsVisible: boolean): BreakdownRowView {
  return {
    kind: "line",
    key: line.lineRef,
    component: lineCategoryLabel(line.category),
    basis: line.reason,
    amountText: formatSignedMoneyMinor(line.amountMinorSigned, currency, { amountsVisible }),
    source: line.sourceRef ?? lineSourceLabel(line.source),
    status: CALCULATED_CHIP,
    manual: line.category === "MANUAL_ADJUSTMENT",
    lineRef: line.lineRef,
  };
}

export function unresolvedRow(item: { code: PayableReviewCode; message: string; sourceRef: string | null }): BreakdownRowView {
  return {
    kind: "unresolved",
    key: `unresolved:${item.code}`,
    component: reviewCodeComponentLabel(item.code),
    basis: item.message,
    amountText: "—",
    source: item.sourceRef ?? "—",
    status: REVIEW_CHIP,
    code: item.code,
  };
}

export function breakdownRows(input: { lines: PayableLineDto[]; unresolved: Array<{ code: PayableReviewCode; message: string; sourceRef: string | null }>; currency: string; amountsVisible: boolean }): BreakdownRowView[] {
  return [...input.lines.map((line) => breakdownLineRow(line, input.currency, input.amountsVisible)), ...input.unresolved.map(unresolvedRow)];
}

export function breakdownTotalText(totalAmountMinorSigned: number | null, currency: string, amountsVisible: boolean): string {
  return formatSignedMoneyMinor(totalAmountMinorSigned, currency, { amountsVisible });
}

// --- Source evidence side panel (Stage 2 / Detail) --------------------------------------------------------------------------------
export type SourceEvidenceSection = { title: string; rows: SourceEvidenceSummaryRow[] };

export function agreementEvidenceSection(snapshot: PayableSnapshotDto): SourceEvidenceSection {
  const rows: SourceEvidenceSummaryRow[] = [
    { label: "Agreement", value: `${snapshot.agreement.agreementRef} · v${snapshot.agreement.agreementVersion}` },
    { label: "Type", value: snapshot.agreement.agreementType },
    { label: "Effective", value: snapshot.agreement.effectiveTo ? `${snapshot.agreement.effectiveFrom} – ${snapshot.agreement.effectiveTo}` : `${snapshot.agreement.effectiveFrom} – ongoing` },
  ];
  if (snapshot.fixedComponent) rows.push({ label: "Fixed amount", value: snapshot.fixedComponent.applicable ? "Applicable" : "Not applicable" });
  if (snapshot.accountTransferFee) rows.push({ label: "Transfer fee", value: snapshot.accountTransferFee.applicable ? "Applicable" : "Not applicable" });
  if (snapshot.paymentTerms.paymentCycle) rows.push({ label: "Payment cycle", value: snapshot.paymentTerms.paymentCycle });
  if (snapshot.paymentTerms.invoiceDueTerms) rows.push({ label: "Invoice terms", value: snapshot.paymentTerms.invoiceDueTerms });
  if (snapshot.paymentTerms.paymentDueTerms) rows.push({ label: "Payment terms", value: snapshot.paymentTerms.paymentDueTerms });
  return { title: "Agreement", rows };
}

export function reviewEvidenceSection(snapshot: PayableSnapshotDto): SourceEvidenceSection | null {
  if (!snapshot.review) return null;
  const rows: SourceEvidenceSummaryRow[] = [
    { label: "Partner Review", value: `${snapshot.review.reviewRef} · v${snapshot.review.reviewVersion}` },
    { label: "Finalized", value: snapshot.review.finalizedAt },
  ];
  if (snapshot.qualifyingContent) {
    rows.push({ label: "Qualifying content", value: `${snapshot.qualifyingContent.actualQualifyingCount} of ${snapshot.qualifyingContent.requiredCount} ${snapshot.qualifyingContent.qualifyingUnit}` });
    rows.push({ label: "Evaluation", value: evaluationLabel(snapshot.qualifyingContent.evaluation) });
  }
  if (snapshot.lfcSfc) rows.push({ label: "LFC / SFC", value: `${snapshot.lfcSfc.lfcCount} LFC · ${snapshot.lfcSfc.sfcCount} SFC` });
  return { title: "Partner Review", rows };
}

function evaluationLabel(evaluation: "met" | "below_requirement" | "exceeded"): string {
  return evaluation === "met" ? "Met" : evaluation === "exceeded" ? "Exceeded" : "Below requirement";
}

export function performanceTargetsSection(snapshot: PayableSnapshotDto): SourceEvidenceSection | null {
  if (snapshot.performanceTargets.length === 0) return null;
  return {
    title: "Performance targets · Monitoring only · does not affect payment",
    rows: snapshot.performanceTargets.map((target) => ({
      label: target.metricId,
      value: target.actualValue === null ? `Target ${target.targetValue} ${target.unit} · not yet available` : `${target.actualValue} of ${target.targetValue} ${target.unit} · ${target.evaluation === "met" ? "Met" : "Not met"}`,
    })),
  };
}

export function warningsList(snapshot: PayableSnapshotDto): string[] {
  return snapshot.warnings;
}

// --- Stage 3: Confirm -------------------------------------------------------------------------------------------------------------
export type ReadinessItem = { label: string; met: boolean };

export function confirmReadiness(preview: PayableSourcePreviewDto): ReadinessItem[] {
  return [
    { label: "Source evidence complete", met: preview.determinationState !== "BLOCKED" },
    { label: "Agreement pinned", met: preview.agreementRef !== null },
    { label: "Partner Review pinned / finalized", met: preview.sourceType !== "PARTNER_REVIEW" || preview.reviewRef !== null },
    { label: "Amount breakdown complete", met: preview.lines.length > 0 || preview.unresolved.length === 0 },
    { label: "Finance review items resolved", met: preview.unresolved.length === 0 },
    { label: "Manual adjustments carry a reason", met: true },
  ];
}

export const DRAFT_LIFECYCLE_WORDING = "The Payable will be created as Draft.";

export function canCreatePayable(preview: PayableSourcePreviewDto | null): boolean {
  return preview !== null && preview.determinationState !== "BLOCKED";
}
