import { commercialOrNeutral } from "./commercial-neutral";
import type { EvidenceGoverningIdentity, EvidenceLfcSfc, EvidenceMonthlyDeliverable, EvidenceTarget, PartnerReviewHeadDoc, PartnerReviewVersionDoc, QualifyingUnit } from "./types";

// Step 13A.1 (revised): the stable, versioned, READ-ONLY handoff contract of a
// FINALIZED Partner Review, for a future downstream consumer. Partner Reviews
// owns and versions this interface; nothing downstream is built or touched
// here - no collection, no route, no import of anything downstream.
//
// What it carries: the finalized Review's commercial EVIDENCE - the governing
// Agreement identity, the payment-affecting results (monthly deliverable count
// and LFC/SFC classification counts, present ONLY when Agreement-governed AND
// evaluated) and the warning-only target results - together with the exact
// reviewRef + reviewVersion + sourceFingerprint they came from. It never
// carries a monetary value, and it carries NO Campaign / Assignment / Content /
// Analytics-record identifier (counts and results only), so it needs no
// per-source redaction and is identical for every actor who may read the review.
//
// STALE-VERSION SIGNAL: a downstream consumer stores (reviewRef, reviewVersion)
// when it consumes a Review. Later it can ask for that version's handoff again
// (or getReviewVersionCurrency) and compare: `versionCurrency.state` is
// "current_finalized" while that version is still the review's current
// finalized version, and "referenced_review_version_is_stale" once a revision
// has been finalized (the version is then SUPERSEDED; its snapshot and
// fingerprint are byte-identical to when it was finalized and it stays fully
// addressable). `currentFinalizedVersion` tells the consumer which version to
// move to. Only FINALIZED or SUPERSEDED versions are handoff-able.

export const FINALIZED_REVIEW_HANDOFF_CONTRACT_VERSION = 1;

export type ReviewVersionCurrencyState = "current_finalized" | "referenced_review_version_is_stale";

export type ReviewVersionCurrency = {
  state: ReviewVersionCurrencyState;
  // The review's current finalized version now (null only if none exists).
  currentFinalizedVersion: number | null;
  // The version the consumer referenced.
  referencedVersion: number;
};

// Pure and deterministic. FINALIZED and still the head's current finalized
// version -> current_finalized; anything else (SUPERSEDED, or a newer
// finalized version exists) -> referenced_review_version_is_stale.
export function evaluateReviewVersionCurrency(head: Pick<PartnerReviewHeadDoc, "currentFinalizedVersion">, referenced: Pick<PartnerReviewVersionDoc, "version" | "status">): ReviewVersionCurrency {
  const current = referenced.status === "FINALIZED" && head.currentFinalizedVersion === referenced.version;
  return {
    state: current ? "current_finalized" : "referenced_review_version_is_stale",
    currentFinalizedVersion: head.currentFinalizedVersion,
    referencedVersion: referenced.version,
  };
}

// Results only - never the source records that produced them.
export type HandoffMonthlyDeliverable = {
  requiredCount: number;
  requirementSource: NonNullable<EvidenceMonthlyDeliverable["requirementSource"]>;
  qualifyingUnit: QualifyingUnit;
  actualQualifyingCount: number;
  variance: number;
  evaluation: "met" | "below_requirement" | "exceeded";
};

export type HandoffLfcSfc = {
  ruleRef: string;
  ruleSource: EvidenceGoverningIdentity;
  qualifyingUnit: QualifyingUnit;
  lfcCount: number;
  sfcCount: number;
  unclassifiedCount: number;
};

export type HandoffWarningOnlyTarget = Pick<EvidenceTarget, "targetRef" | "metricId" | "targetValue" | "unit" | "actualValue" | "evaluation" | "unavailableReason" | "affectsPayment">;

export type FinalizedReviewHandoffDto = {
  contractVersion: typeof FINALIZED_REVIEW_HANDOFF_CONTRACT_VERSION;
  reviewRef: string;
  reviewVersion: number;
  partner: { partnerRef: string; displayName: string | null };
  period: { periodKey: string; periodStart: string; periodEnd: string };
  finalizedAt: string;
  evidenceCutoff: string;
  sourceFingerprint: string;
  governingAgreement: EvidenceGoverningIdentity | null;
  // Each present ONLY when Agreement-governed AND evaluated; otherwise null.
  paymentAffectingEvidence: {
    monthlyDeliverable: HandoffMonthlyDeliverable | null;
    lfcSfc: HandoffLfcSfc | null;
  };
  // Warnings only: a target result never alters paymentAffectingEvidence.
  warningOnlyTargets: HandoffWarningOnlyTarget[];
  versionCurrency: ReviewVersionCurrency;
};

function handoffDeliverable(section: EvidenceMonthlyDeliverable): HandoffMonthlyDeliverable | null {
  if (!section.affectsPayment || section.evaluation === "unavailable") return null;
  if (section.requiredCount === null || section.requirementSource === null || section.qualifyingUnit === null || section.actualQualifyingCount === null || section.variance === null) return null;
  return {
    requiredCount: section.requiredCount,
    requirementSource: { ...section.requirementSource },
    qualifyingUnit: section.qualifyingUnit,
    actualQualifyingCount: section.actualQualifyingCount,
    variance: section.variance,
    evaluation: section.evaluation,
  };
}

function handoffLfcSfc(section: EvidenceLfcSfc): HandoffLfcSfc | null {
  if (!section.affectsPayment || section.status !== "evaluated") return null;
  if (section.ruleRef === null || section.ruleSource === null || section.qualifyingUnit === null || section.lfcCount === null || section.sfcCount === null || section.unclassifiedCount === null) return null;
  return {
    ruleRef: section.ruleRef,
    ruleSource: { ...section.ruleSource },
    qualifyingUnit: section.qualifyingUnit,
    lfcCount: section.lfcCount,
    sfcCount: section.sfcCount,
    unclassifiedCount: section.unclassifiedCount,
  };
}

// Pure: builds the handoff DTO from a FINALIZED or SUPERSEDED version doc.
// (The caller rejects any other status before calling.)
export function buildFinalizedReviewHandoff(args: { head: PartnerReviewHeadDoc; version: PartnerReviewVersionDoc; partnerDisplayName: string | null }): FinalizedReviewHandoffDto {
  const { head, version } = args;
  const commercial = commercialOrNeutral(version.snapshot);

  return {
    contractVersion: FINALIZED_REVIEW_HANDOFF_CONTRACT_VERSION,
    reviewRef: head.reviewRef,
    reviewVersion: version.version,
    partner: { partnerRef: head.partnerRef, displayName: args.partnerDisplayName },
    period: { periodKey: head.periodKey, periodStart: head.periodStart, periodEnd: head.periodEnd },
    // Non-null by construction: only FINALIZED / SUPERSEDED versions get here.
    finalizedAt: version.finalizedAt as string,
    evidenceCutoff: version.evidenceCutoff,
    sourceFingerprint: version.sourceFingerprint,
    governingAgreement: commercial.governingAgreement ? { ...commercial.governingAgreement } : null,
    paymentAffectingEvidence: {
      monthlyDeliverable: handoffDeliverable(commercial.monthlyDeliverable),
      lfcSfc: handoffLfcSfc(commercial.lfcSfc),
    },
    warningOnlyTargets: commercial.targets.map((target) => ({
      targetRef: target.targetRef,
      metricId: target.metricId,
      targetValue: target.targetValue,
      unit: target.unit,
      actualValue: target.actualValue,
      evaluation: target.evaluation,
      unavailableReason: target.unavailableReason,
      affectsPayment: false,
    })),
    versionCurrency: evaluateReviewVersionCurrency(head, version),
  };
}
