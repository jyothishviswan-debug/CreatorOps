import type { ActorContext } from "@/server/authz/types";
import { getAgreementDetail, type AgreementDetailDto, type AgreementVersionDto, type AgreementVersionSummaryDto } from "@/server/finance-agreements";
import type { FinalizedReviewHandoffDto } from "@/server/partner-reviews/finalized-review-handoff";
import { getFinalizedReviewHandoff } from "@/server/partner-reviews/finalized-review-handoff-service";
import { derivePeriod, reviewRefFor } from "@/server/partner-reviews/period";

import type { AuthorizedPayableCounterparty } from "./finance-payables-gate";
import { payableBusinessKey } from "./ids";
import {
  GST_NOT_APPLICABLE_BASIS_PROVENANCE,
  GST_UNCONFIRMED_PROVENANCE,
  payableSourceSnapshotSchema,
  SNAPSHOT_SCHEMA_VERSION,
  SOURCE_TYPE_BY_COUNTERPARTY,
  TDS_PRODUCT_PROVENANCE,
  TDS_PRODUCT_RATE_BPS,
  type CommercialPeriod,
  type PayableBlockedCode,
  type PayableCounterpartyType,
  type PayableSourceSnapshot,
  type PayableSourceType,
} from "./types";

// Step 15A: SOURCE EVIDENCE - how a Payable is pinned to the exact commercial evidence that
// justifies it, and the immutable snapshot of that evidence (sections 5, 6, 17 and 18).
//
// DEPENDENCY DIRECTION, deliberately one-way:
//   Payable READS a finalized Partner Review        (never the other way round)
//   Payable READS a confirmed Agreement version     (never the other way round)
// Nothing here writes, and nothing here is reachable from Partner Reviews or Finance Agreements.
// Both reads go through those modules' own PUBLISHED, read-only contracts and their own
// authorization chains - never through their Firestore internals:
//   - getFinalizedReviewHandoff (partner-reviews' versioned handoff contract) applies the
//     `partner_reviews` feature gate and the LIVE Partner Record Scope. Building a Payable from a
//     Review therefore requires being allowed to read that Review.
//   - getAgreementDetail (the Finance Agreements service barrel) applies the `finance` feature
//     gate and the LIVE Partner / Vendor Record Scope of the Agreement's own counterparty.
//
// WHAT IS PINNED: a Payable pins the exact Agreement ref + version and, when applicable, the exact
// Partner Review ref + version. A later Agreement or Review revision can never silently rewrite a
// Payable's financial history - it can only be surfaced as a warning (see source-revision.ts) and
// acted on by explicitly creating a NEW Payable version.
//
// WHAT IS NOT COPIED into the snapshot (section 6): raw full Agreement text (the mandated-services
// clause, monetisation terms, renewal / notice / termination text), any KYC or identity value or
// status, PAN / Aadhaar / GST / bank, the counterparty contact snapshot, and any Campaign /
// Assignment / Content / Analytics record identifier. Only counts, results and the finance terms
// needed to explain the amount later are captured.

export type PayableSourceBlocker = { code: PayableBlockedCode; message: string };

export type ResolvedPayableSource = {
  counterpartyType: PayableCounterpartyType;
  counterpartyRef: string;
  counterpartyName: string;
  period: CommercialPeriod;
  sourceType: PayableSourceType;
  agreementRef: string;
  agreementVersion: number;
  reviewRef: string | null;
  reviewVersion: number | null;
  businessKey: string;
  snapshot: PayableSourceSnapshot;
};

export type ResolveSourceOutcome = { ok: true; resolved: ResolvedPayableSource } | { ok: false; blockers: PayableSourceBlocker[] };

const blocked = (code: PayableBlockedCode, message: string): ResolveSourceOutcome => ({ ok: false, blockers: [{ code, message }] });

// --- The governing Agreement version (pure) -----------------------------------------------------------------------------
// Mirrors the documented Agreement -> commercial-policy governing rule (see
// finance-agreements/policy-adapter.ts, rules 2-5), applied to ONE named Agreement head:
//   - only CONFIRMED versions in ACTIVE / SUSPENDED / ENDED / SUPERSEDED govern anything; a DRAFT
//     (even a confirmed, not-yet-activated one) never does;
//   - a version's governing range is [effectiveFrom, end] where `end` is effectiveTo for
//     ACTIVE / SUSPENDED (suspension is an operational hold, not a change of terms), the earlier of
//     effectiveTo and the end date for ENDED, and the earlier of effectiveTo and the day BEFORE the
//     successor's effectiveFrom for SUPERSEDED (a SUPERSEDED version whose successor is missing
//     governs nothing);
//   - the version governs the period only if its range covers the WHOLE period, first to last day.
//     A partly-covered period has NO governing version and nothing is ever prorated;
//   - when several versions cover it, the HIGHEST version number wins.
const GOVERNING_STATUSES: ReadonlySet<AgreementVersionSummaryDto["status"]> = new Set(["ACTIVE", "SUSPENDED", "ENDED", "SUPERSEDED"]);

function dayBefore(date: string): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() - 1);
  return value.toISOString().slice(0, 10);
}

const earlier = (a: string | null, b: string | null): string | null => (a === null ? b : b === null ? a : a < b ? a : b);

function governingEnd(version: AgreementVersionSummaryDto, byNumber: Map<number, AgreementVersionSummaryDto>): string | null | "none" {
  const effectiveTo = version.effectiveTo;
  if (version.status === "ENDED") return earlier(effectiveTo, version.endedAt ? version.endedAt.slice(0, 10) : null);
  if (version.status === "SUPERSEDED") {
    const successor = version.supersededByVersion === null ? undefined : byNumber.get(version.supersededByVersion);
    const successorFrom = successor?.effectiveFrom;
    if (!successorFrom) return "none";
    return earlier(effectiveTo, dayBefore(successorFrom));
  }
  return effectiveTo;
}

export function resolveGoverningAgreementVersion(versions: readonly AgreementVersionSummaryDto[], period: CommercialPeriod): number | null {
  const byNumber = new Map(versions.map((version) => [version.version, version] as const));
  let best: number | null = null;
  for (const version of versions) {
    if (!version.confirmed || !GOVERNING_STATUSES.has(version.status) || version.effectiveFrom === null) continue;
    const end = governingEnd(version, byNumber);
    if (end === "none") continue;
    if (version.effectiveFrom > period.periodStart) continue;
    if (end !== null && end < period.periodEnd) continue;
    if (best === null || version.version > best) best = version.version;
  }
  return best;
}

// A pinned version must be a confirmed, governing-capable one - never a DRAFT working copy.
export function isPinnableAgreementVersion(version: Pick<AgreementVersionDto, "confirmed" | "status">): boolean {
  return version.confirmed && GOVERNING_STATUSES.has(version.status);
}

export function counterpartyUidOf(counterparty: AuthorizedPayableCounterparty): string | null {
  return counterparty.type === "PARTNER" ? counterparty.scope.partnerUid : counterparty.scope.vendorUid;
}

// --- Snapshot assembly (pure) --------------------------------------------------------------------------------------------
type SnapshotInput = {
  counterpartyType: PayableCounterpartyType;
  counterpartyRef: string;
  period: CommercialPeriod;
  sourceType: PayableSourceType;
  agreementRef: string;
  agreementVersion: number;
  terms: NonNullable<AgreementVersionDto["terms"]>;
  handoff: FinalizedReviewHandoffDto | null;
  reviewRef: string | null;
  reviewVersion: number | null;
  capturedAt: string;
};

export function buildPayableSourceSnapshot(input: SnapshotInput): PayableSourceSnapshot {
  const { commercial } = input.terms;
  const warnings: string[] = [];
  const handoff = input.handoff;

  const deliverable = handoff?.paymentAffectingEvidence.monthlyDeliverable ?? null;
  const lfcSfc = handoff?.paymentAffectingEvidence.lfcSfc ?? null;

  // Step 15C section 6: the ONE structured signal the amount-determination engine uses to tell
  // "no monthly requirement exists" (proration doesn't apply, apply the fixed amount in full)
  // apart from "a requirement exists but its evidence is missing" (proration cannot run blind).
  const requiredContentWithoutEvidence =
    (commercial.monthlyRequiredQualifyingContentCount !== null || commercial.contentObligations.length > 0) && deliverable === null;

  if (requiredContentWithoutEvidence) {
    warnings.push("The Agreement states a qualifying-content requirement, but the pinned evidence does not report an evaluated delivery figure for this period.");
  }
  if (commercial.lfcSfc !== null && lfcSfc === null) {
    warnings.push("The Agreement states an LFC/SFC classification rule, but the pinned evidence does not report evaluated LFC/SFC counts for this period.");
  }
  if (input.sourceType === "AGREEMENT_ONLY" && (commercial.monthlyRequiredQualifyingContentCount !== null || commercial.contentObligations.length > 0)) {
    warnings.push("This payable is governed by the Agreement alone: there is no delivery evidence for the content obligations it states.");
  }

  // Step 15C.1 section 10: tax provenance. No per-counterparty or per-Agreement tax-profile source
  // exists anywhere in this codebase today (see types.ts's snapshotTaxSchema doc comment). TDS is
  // populated from the single confirmed CreatorOps product rule (10%, section 9), applied ONLY to
  // Partner-Review-sourced payables - the product rule was defined in the context of creator
  // payables, and is never extended to a Vendor basis without an explicit confirmed source.
  //
  // GST has no canonical source either, so a FRESHLY resolved snapshot (create, or a revision that
  // refreshes source) never guesses it: `gstApplicable` starts `null` ("unconfirmed" - the engine
  // raises GST_APPLICABILITY_UNCONFIRMED for it, see amount-determination.ts, rather than silently
  // treating it as "not applicable"). It becomes non-null ONLY through the dedicated
  // `confirmPayableTax` Finance action, which overrides these three fields on the payable's
  // snapshot directly (payable-service.ts) - never here. A Vendor/AGREEMENT_ONLY basis carries no
  // TDS either (see above), so it is kept a confirmed, deterministic "not applicable" - there is no
  // review workflow for a basis this module's tax rule was never defined for.
  const tax =
    input.sourceType === "PARTNER_REVIEW"
      ? { tdsApplicable: true, tdsRateBps: TDS_PRODUCT_RATE_BPS, tdsProvenance: TDS_PRODUCT_PROVENANCE, gstApplicable: null, gstRateBps: null, gstProvenance: GST_UNCONFIRMED_PROVENANCE }
      : { tdsApplicable: false, tdsRateBps: null, tdsProvenance: "NOT_APPLICABLE_AGREEMENT_ONLY_BASIS", gstApplicable: false, gstRateBps: null, gstProvenance: GST_NOT_APPLICABLE_BASIS_PROVENANCE };

  return payableSourceSnapshotSchema.parse({
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    counterparty: { type: input.counterpartyType, ref: input.counterpartyRef },
    commercialPeriod: input.period,
    sourceType: input.sourceType,
    agreement: {
      agreementRef: input.agreementRef,
      agreementVersion: input.agreementVersion,
      agreementType: input.terms.agreementType,
      effectiveFrom: input.terms.dates.effectiveFrom,
      effectiveTo: input.terms.dates.effectiveTo,
    },
    review:
      handoff && input.reviewRef !== null && input.reviewVersion !== null
        ? { reviewRef: input.reviewRef, reviewVersion: input.reviewVersion, finalizedAt: handoff.finalizedAt, sourceFingerprint: handoff.sourceFingerprint }
        : null,
    currency: commercial.currency,
    qualifyingContent: deliverable
      ? {
          requiredCount: deliverable.requiredCount,
          qualifyingUnit: deliverable.qualifyingUnit,
          actualQualifyingCount: deliverable.actualQualifyingCount,
          variance: deliverable.variance,
          evaluation: deliverable.evaluation,
          affectsPayment: true,
        }
      : null,
    requiredContentWithoutEvidence,
    lfcSfc: lfcSfc ? { ruleRef: lfcSfc.ruleRef, qualifyingUnit: lfcSfc.qualifyingUnit, lfcCount: lfcSfc.lfcCount, sfcCount: lfcSfc.sfcCount, unclassifiedCount: lfcSfc.unclassifiedCount } : null,
    contentObligations: commercial.contentObligations.map((obligation) => ({
      obligationRef: obligation.obligationRef,
      label: obligation.label,
      quantity: obligation.quantity,
      period: obligation.period,
      operationalMapping: obligation.operationalMapping,
    })),
    fixedComponent: commercial.fixedComponent ? { applicable: commercial.fixedComponent.applicable, amountMinor: commercial.fixedComponent.amountMinor } : null,
    accountTransferFee: commercial.accountTransferFee
      ? { applicable: commercial.accountTransferFee.applicable, amountMinor: commercial.accountTransferFee.amountMinor, details: commercial.accountTransferFee.details }
      : null,
    advancePayment: commercial.advancePayment ? { applicable: commercial.advancePayment.applicable, amountMinor: commercial.advancePayment.amountMinor, details: commercial.advancePayment.details } : null,
    incentive: commercial.incentive
      ? {
          applicable: commercial.incentive.applicable,
          narrative: commercial.incentive.narrative,
          slabs: commercial.incentive.slabs.map((slab) => ({ slabRef: slab.slabRef, metricId: slab.metricId, lowerBound: slab.lowerBound, upperBound: slab.upperBound, unit: slab.unit, amountMinor: slab.amountMinor })),
        }
      : null,
    paymentTerms: {
      paymentCycle: commercial.paymentCycle,
      invoiceRequired: commercial.invoiceRequired,
      invoiceDueTerms: commercial.invoiceDueTerms,
      paymentDueTerms: commercial.paymentDueTerms,
    },
    performanceTargets: (handoff?.warningOnlyTargets ?? []).map((target) => ({
      targetRef: target.targetRef,
      metricId: target.metricId,
      targetValue: target.targetValue,
      unit: target.unit,
      actualValue: target.actualValue,
      evaluation: target.evaluation,
      affectsPayment: false,
    })),
    tax,
    warnings: warnings.slice(0, 30),
    capturedAt: input.capturedAt,
  });
}

// --- Resolution (reads the two published contracts) ------------------------------------------------------------------------
// The counterparty has ALREADY been authorized by the caller (loadAuthorizedPayableCounterparty);
// this function never re-decides scope, it only resolves evidence.
export async function resolvePayableSource(
  actor: ActorContext,
  counterparty: AuthorizedPayableCounterparty,
  commercialPeriod: string,
  requestedAgreementRef: string | undefined,
  now: () => Date = () => new Date(),
): Promise<ResolveSourceOutcome> {
  const derived = derivePeriod(commercialPeriod);
  if (!derived) return blocked("SOURCE_VERSION_INVALID", "The commercial period is not a valid YYYY-MM month.");
  const period: CommercialPeriod = { periodKey: derived.periodKey, periodStart: derived.periodStart, periodEnd: derived.periodEnd };

  if (counterpartyUidOf(counterparty) === null) return blocked("COUNTERPARTY_UNRESOLVED", "The counterparty of this payable could not be resolved.");

  const sourceType = SOURCE_TYPE_BY_COUNTERPARTY[counterparty.type];
  const capturedAt = now().toISOString();

  let handoff: FinalizedReviewHandoffDto | null = null;
  let reviewRef: string | null = null;
  let reviewVersion: number | null = null;
  let agreementRef: string;

  if (sourceType === "PARTNER_REVIEW") {
    // The review's identity is deterministic in (partnerRef, periodKey) - never client-supplied.
    reviewRef = reviewRefFor(counterparty.ref, period.periodKey);
    const handoffResult = await getFinalizedReviewHandoff(actor, reviewRef);
    if (!handoffResult.ok) {
      if (handoffResult.code === "not_found") return blocked("REVIEW_NOT_FOUND", `There is no Partner Review for ${period.periodKey}. Generate and finalize the review before creating a payable.`);
      if (handoffResult.code === "invalid_input") return blocked("REVIEW_NOT_FINALIZED", `The Partner Review for ${period.periodKey} is not finalized. Finalize it before creating a payable.`);
      // A feature / scope denial on the Review is reported as "not finalized evidence available"
      // would be misleading; surface it as a source blocker without revealing which gate refused.
      return blocked("REVIEW_NOT_FOUND", `The finalized Partner Review for ${period.periodKey} is not available.`);
    }
    handoff = handoffResult.data;
    if (handoff.partner.partnerRef !== counterparty.ref) return blocked("COUNTERPARTY_UNRESOLVED", "The finalized Partner Review does not belong to this Partner.");
    if (handoff.period.periodKey !== period.periodKey) return blocked("SOURCE_VERSION_INVALID", "The finalized Partner Review does not cover this commercial period.");
    if (handoff.policyConflict) {
      return blocked(
        "AGREEMENT_SOURCE_CONFLICT",
        `More than one Agreement applied to ${period.periodKey}, so the governing commercial terms are unresolved. Correct the overlapping Agreements in Finance; no Agreement is guessed here.`,
      );
    }
    if (handoff.governingAgreement === null) return blocked("AGREEMENT_VERSION_UNAVAILABLE", `No Agreement version governs ${period.periodKey} for this Partner, so there are no commercial terms to pay against.`);
    reviewVersion = handoff.reviewVersion;
    agreementRef = handoff.governingAgreement.agreementRef;
  } else {
    if (!requestedAgreementRef) return blocked("AGREEMENT_VERSION_UNAVAILABLE", "This payable names no Agreement to pay against.");
    agreementRef = requestedAgreementRef;
  }

  const detail = await getAgreementDetail(actor, agreementRef, handoff?.governingAgreement ? { version: handoff.governingAgreement.agreementVersion } : {});
  if (!detail.ok) return blocked("AGREEMENT_VERSION_UNAVAILABLE", "The Agreement that governs this period is not available.");

  const agreementCounterparty = detail.data.head.counterparty;
  if (agreementCounterparty.type !== counterparty.type || agreementCounterparty.ref !== counterparty.ref) {
    return blocked("AGREEMENT_COUNTERPARTY_MISMATCH", "That Agreement belongs to a different counterparty than this payable.");
  }

  const pinned = await pinnedAgreementVersion(actor, detail.data, period, handoff?.governingAgreement?.agreementVersion ?? null);
  if (!pinned.ok) return pinned;

  const snapshot = buildPayableSourceSnapshot({
    counterpartyType: counterparty.type,
    counterpartyRef: counterparty.ref,
    period,
    sourceType,
    agreementRef,
    agreementVersion: pinned.version.version,
    terms: pinned.terms,
    handoff,
    reviewRef,
    reviewVersion,
    capturedAt,
  });

  if (snapshot.currency === null) {
    return blocked("CURRENCY_MISSING", "The governing Agreement version states no currency, so no payable amount can be determined.");
  }

  return {
    ok: true,
    resolved: {
      counterpartyType: counterparty.type,
      counterpartyRef: counterparty.ref,
      counterpartyName: counterparty.displayName,
      period,
      sourceType,
      agreementRef,
      agreementVersion: pinned.version.version,
      reviewRef,
      reviewVersion,
      businessKey: payableBusinessKey({
        counterpartyType: counterparty.type,
        counterpartyRef: counterparty.ref,
        commercialPeriod: period.periodKey,
        sourceType,
        agreementRef,
        agreementVersion: pinned.version.version,
        reviewRef,
        reviewVersion,
      }),
      snapshot,
    },
  };
}

type PinnedVersion = { ok: true; version: AgreementVersionDto; terms: NonNullable<AgreementVersionDto["terms"]> } | { ok: false; blockers: PayableSourceBlocker[] };

// For a Partner payable the Review already determined which Agreement version governs its period -
// that pin is honoured verbatim (it is what keeps the Payable and the Review telling the same
// story). For a Vendor payable there is no Review, so the governing version is resolved here from
// the Agreement's own version chain with the documented rule.
async function pinnedAgreementVersion(actor: ActorContext, detail: AgreementDetailDto, period: CommercialPeriod, reviewPinnedVersion: number | null): Promise<PinnedVersion> {
  const fail = (code: PayableBlockedCode, message: string): PinnedVersion => ({ ok: false, blockers: [{ code, message }] });

  const wanted = reviewPinnedVersion ?? resolveGoverningAgreementVersion(detail.versions, period);
  if (wanted === null) {
    return fail("AGREEMENT_VERSION_UNAVAILABLE", `No confirmed Agreement version covers the whole of ${period.periodKey}. A partly-covered period is never prorated - correct the Agreement's effective dates first.`);
  }

  let selected = detail.selectedVersion;
  if (!selected || selected.version !== wanted) {
    const refetched = await getAgreementDetail(actor, detail.head.agreementRef, { version: wanted });
    if (!refetched.ok || !refetched.data.selectedVersion) return fail("AGREEMENT_VERSION_UNAVAILABLE", `Version ${wanted} of the governing Agreement could not be read.`);
    selected = refetched.data.selectedVersion;
  }

  if (!isPinnableAgreementVersion(selected)) {
    return fail("SOURCE_VERSION_INVALID", `Version ${selected.version} of the governing Agreement is ${selected.status.toLowerCase()} and not confirmed for operation, so it cannot govern a payable.`);
  }
  if (selected.terms === null) return fail("SOURCE_VERSION_INVALID", `Version ${selected.version} of the governing Agreement carries no confirmed terms.`);

  return { ok: true, version: selected, terms: selected.terms };
}
