import { percentBpsOfMinor, prorateMinor } from "./money";
import { deterministicPayableLineRef, sourceVersionRef } from "./ids";
import { CURRENT_PAYABLE_CALCULATION_RULE_VERSION, TDS_PRODUCT_PROVENANCE, TDS_PRODUCT_RATE_BPS } from "./types";
import type { PayableBlockedCode, PayableCalculationRuleVersion, PayableDeterminationState, PayableLine, PayableReviewCode, PayableSourceSnapshot, PayableUnresolvedItem } from "./types";

// Step 15A/15C: the Payable AMOUNT DETERMINATION engine.
//
// PURE, deterministic and actor-independent: the same immutable snapshot always produces the same
// breakdown. It reads no clock, no Firestore, no actor and no permission - the service applies
// those around it. That is what makes an amount reproducible from the stored evidence years later.
//
// THE GOVERNING PRINCIPLE (section 7 of Step 15A, still the rule for everything OTHER than the
// fixed/prorated base): no commercial mathematics is invented here. Something is calculated
// automatically ONLY when the CONFIRMED Agreement terms (plus, for the base, the pinned Review's
// evaluated monthly evidence) explicitly support the calculation. Anything else is handed to
// Finance as an explicit, named item to confirm - it is never guessed, defaulted or silently
// dropped.
//
// Three outcomes:
//   DETERMINISTIC            every commercial term in scope converted without ambiguity.
//   FINANCE_REVIEW_REQUIRED  at least one named item needs a human Finance decision. The amount
//                            computed so far is still shown; nothing has been reduced or guessed.
//   BLOCKED                  the evidence cannot support a payable at all. Never persisted (see
//                            payableVersionDocSchema) - it is a refusal to generate.
//
// STEP 15C - THE CORRECTED BASE-PROVISION RULE, superseding Step 15A's old "never prorated" rule:
// the monthly fixed component IS now prorated against the Review's pinned, evaluated monthly
// qualifying-content evidence -
//   serviceBase = fixedAmountMinor / requiredCount * min(actualCount, requiredCount)
// - a CreatorOps product rule (see money.ts's documented half-up rounding), not tax advice and not
// a Content-derived recomputation: `requiredCount`/`actualCount` are read verbatim from the
// snapshot's `qualifyingContent`, itself copied verbatim from the pinned FINALIZED Partner Review
// version's evaluated `monthlyDeliverable` (the canonical monthly-evidence record this codebase
// has - see source-evidence.ts's header comment for why no separate "Monthly Analytics" collection
// exists or is invented here). Proration runs ONLY for a Partner-Review-sourced basis with
// evaluated delivery evidence; a Vendor (AGREEMENT_ONLY) basis, or a Partner basis with no monthly
// content requirement at all, has no monthly evidence to prorate against and applies the fixed
// amount in full (BASE_FIXED) exactly as Step 15A always did. A Partner basis whose Agreement DOES
// require content but whose pinned Review has no evaluated evidence for it cannot run proration
// blind - REQUIRED_COUNT_EVIDENCE_MISSING_FOR_PRORATION is raised instead (see
// `requiredContentWithoutEvidence` on the snapshot).

export type PayableDeterminationResult = {
  state: PayableDeterminationState;
  // Engine-derived breakdown lines only, in a stable order. Manual adjustments are appended by
  // the service; the engine never invents one.
  lines: PayableLine[];
  unresolved: PayableUnresolvedItem[];
  blocked: Array<{ code: PayableBlockedCode; message: string }>;
  warnings: string[];
  // Step 15C section 10's five distinct totals. Null exactly when there is no fixed/prorated
  // component to compute a base from (see payableVersionDocSchema's own invariant on these).
  serviceBaseMinor: number | null;
  gstMinor: number;
  grossInvoiceExpectedMinor: number | null;
  tdsMinor: number;
  expectedNetPaymentMinor: number | null;
  calculationRuleVersion: PayableCalculationRuleVersion;
};

type Builder = {
  lines: PayableLine[];
  unresolved: PayableUnresolvedItem[];
  warnings: string[];
};

function addUnresolved(builder: Builder, code: PayableReviewCode, message: string, sourceRef: string | null): void {
  if (builder.unresolved.some((item) => item.code === code)) return;
  builder.unresolved.push({ code, message, sourceRef });
}

// --- Fixed / prorated base component (Step 15C sections 4-6) --------------------------------------------------------------
function applyBaseComponent(
  builder: Builder,
  snapshot: PayableSourceSnapshot,
  payableRef: string,
  agreementSourceRef: string,
  reviewSourceRef: string | null,
): { serviceBaseMinor: number | null } {
  const fixed = snapshot.fixedComponent;
  if (!fixed || !fixed.applicable || fixed.amountMinor === null) return { serviceBaseMinor: null };

  const pushFullFixed = (reason: string): number => {
    builder.lines.push({
      lineRef: deterministicPayableLineRef(payableRef, "BASE_FIXED", "agreement-fixed-component"),
      label: "Fixed component",
      category: "BASE_FIXED",
      amountMinorSigned: fixed.amountMinor!,
      source: "AGREEMENT",
      sourceRef: agreementSourceRef,
      reason,
      actor: null,
      resolvesCode: null,
    });
    return fixed.amountMinor!;
  };

  // No monthly evidence chain exists for this basis at all - proration has nothing to run
  // against. Apply the fixed amount in full, exactly as Step 15A always did.
  if (snapshot.sourceType !== "PARTNER_REVIEW") {
    return { serviceBaseMinor: pushFullFixed("Fixed component stated by the confirmed Agreement terms (no monthly Partner Review evidence exists for this basis - proration does not apply).") };
  }

  const delivery = snapshot.qualifyingContent;
  if (delivery === null) {
    if (snapshot.requiredContentWithoutEvidence) {
      addUnresolved(
        builder,
        "REQUIRED_COUNT_EVIDENCE_MISSING_FOR_PRORATION",
        "The Agreement states a monthly required-content term, but the pinned Partner Review evidence has no evaluated delivery figure for this period. Proration cannot run without it - Finance must confirm the amount as a manual adjustment.",
        agreementSourceRef,
      );
      return { serviceBaseMinor: null };
    }
    // The Agreement states no monthly content requirement at all - there is nothing to prorate
    // against, and that is expected, not a gap.
    return { serviceBaseMinor: pushFullFixed("Fixed component stated by the confirmed Agreement terms (the Agreement states no monthly required-content term to prorate against).") };
  }

  if (delivery.requiredCount <= 0) {
    // A stated requirement of exactly zero has no proration base either - full fixed amount.
    return { serviceBaseMinor: pushFullFixed("Fixed component stated by the confirmed Agreement terms (the stated monthly requirement is zero).") };
  }

  const cappedActualCount = Math.min(delivery.actualQualifyingCount, delivery.requiredCount);
  const serviceBaseMinor = prorateMinor(fixed.amountMinor, cappedActualCount, delivery.requiredCount);
  const cappedNote = delivery.actualQualifyingCount > delivery.requiredCount ? ` (${delivery.actualQualifyingCount} delivered · ${cappedActualCount} counted for payable)` : "";

  builder.lines.push({
    lineRef: deterministicPayableLineRef(payableRef, "PRORATED_BASE", "agreement-fixed-component-prorated"),
    label: `Prorated service base${cappedNote}`,
    category: "PRORATED_BASE",
    amountMinorSigned: serviceBaseMinor,
    source: "PARTNER_REVIEW",
    sourceRef: reviewSourceRef,
    reason: `Calculated under calculation rule ${CURRENT_PAYABLE_CALCULATION_RULE_VERSION}: the Agreement's fixed monthly amount, prorated by ${cappedActualCount} of ${delivery.requiredCount} required ${delivery.qualifyingUnit} (finalized Partner Review evidence, agreement basis ${agreementSourceRef}).`,
    actor: null,
    resolvesCode: null,
  });

  if (delivery.evaluation === "below_requirement") {
    builder.warnings.push(
      `Qualifying content was under-delivered (${delivery.actualQualifyingCount} of ${delivery.requiredCount} ${delivery.qualifyingUnit}); the monthly service base was prorated accordingly.`,
    );
  } else if (delivery.evaluation === "exceeded") {
    builder.warnings.push(`Qualifying content exceeded the monthly requirement (${delivery.actualQualifyingCount} of ${delivery.requiredCount} ${delivery.qualifyingUnit}); the service base is capped at the required count.`);
  }

  return { serviceBaseMinor };
}

// --- LFC / SFC classification warnings (Step 15C section 7) ---------------------------------------------------------------
// Compliance/warning dimension ONLY - never a separate price weighting (no Agreement field in this
// codebase states a required LFC count or a required SFC count distinct from the single total
// requirement handled above, so no LFC/SFC shortfall comparison is fabricated here - only what the
// pinned evidence itself can support: whether the evidence classified everything it counted).
function applyLfcSfcWarnings(builder: Builder, snapshot: PayableSourceSnapshot): void {
  const lfcSfc = snapshot.lfcSfc;
  if (!lfcSfc) return;
  if (lfcSfc.unclassifiedCount > 0) {
    builder.warnings.push(`${lfcSfc.unclassifiedCount} ${lfcSfc.qualifyingUnit} could not be classified as LFC or SFC by the pinned evidence (Analytics classification incomplete).`);
  }
}

// --- Monthly performance target warnings (Step 15C section 8) -------------------------------------------------------------
// Every target is `affectsPayment: false` by the schema's own literal type - these warnings are
// informational only and never alter a review code, a blocked state or an amount.
function applyTargetWarnings(builder: Builder, snapshot: PayableSourceSnapshot): void {
  for (const target of snapshot.performanceTargets) {
    if (target.evaluation === "not_met") {
      builder.warnings.push(`Monthly target missed: ${target.metricId} (${target.actualValue ?? "unavailable"} of ${target.targetValue} ${target.unit}) - monitoring only, does not affect payment.`);
    } else if (target.evaluation === "unavailable") {
      builder.warnings.push(`Monthly target evidence unavailable: ${target.metricId} - monitoring only, does not affect payment.`);
    }
  }
}

// --- Account transfer fee ---------------------------------------------------------------------------------------------------
// Unchanged from Step 15A: its own separate TRANSFER_FEE line, never merged into the base. Step
// 15C section 11: the existing data states no tax-basis rule for the transfer fee (no field says
// whether it is GST/TDS-bearing), so it stays OUTSIDE the GST/TDS basis and outside
// grossInvoiceExpectedMinor/expectedNetPaymentMinor - it only ever affects totalAmountMinorSigned
// (the full payout sum), exactly as before. A warning makes that exclusion explicit rather than
// silent whenever the fee is present.
function applyTransferFee(builder: Builder, snapshot: PayableSourceSnapshot, payableRef: string, agreementSourceRef: string): void {
  const fee = snapshot.accountTransferFee;
  if (!fee || !fee.applicable) return;
  if (fee.amountMinor === null) {
    addUnresolved(
      builder,
      "TRANSFER_FEE_APPLICATION_UNSPECIFIED",
      "The Agreement ticks an account transfer fee as applicable but states no amount. Finance must confirm the amount as a manual adjustment.",
      agreementSourceRef,
    );
    return;
  }
  builder.lines.push({
    lineRef: deterministicPayableLineRef(payableRef, "TRANSFER_FEE", "agreement-transfer-fee"),
    label: "Account transfer fee",
    category: "TRANSFER_FEE",
    amountMinorSigned: fee.amountMinor,
    source: "AGREEMENT",
    sourceRef: agreementSourceRef,
    reason: fee.details ? `Account transfer fee stated by the confirmed Agreement terms: ${fee.details}` : "Account transfer fee stated by the confirmed Agreement terms.",
    actor: null,
    resolvesCode: null,
  });
  builder.warnings.push("The account transfer fee's GST/TDS tax-basis interaction is not defined by any confirmed source, so it is kept separate from GST/TDS and from the gross expected Invoice total pending Finance review.");
}

// --- Advance payment ---------------------------------------------------------------------------------------------------------
function applyAdvance(builder: Builder, snapshot: PayableSourceSnapshot, agreementSourceRef: string): void {
  const advance = snapshot.advancePayment;
  if (!advance || !advance.applicable) return;
  addUnresolved(
    builder,
    "ADVANCE_APPLICATION_UNSPECIFIED",
    "The Agreement states an advance payment but not how it applies to this commercial period. Finance must confirm the adjustment.",
    agreementSourceRef,
  );
}

// --- Incentive ----------------------------------------------------------------------------------------------------------------
function applyIncentive(builder: Builder, snapshot: PayableSourceSnapshot, payableRef: string, agreementSourceRef: string): void {
  const incentive = snapshot.incentive;
  if (!incentive || !incentive.applicable) return;

  if (incentive.narrative !== null) {
    addUnresolved(builder, "NARRATIVE_INCENTIVE", "The Agreement states a discretionary incentive in words rather than a structured schedule. Finance must decide the amount, if any.", agreementSourceRef);
  }
  if (incentive.slabs.length === 0) return;

  const measured = new Map<string, number>();
  for (const target of snapshot.performanceTargets) {
    if (target.evaluation !== "unavailable" && target.actualValue !== null) measured.set(target.metricId, target.actualValue);
  }

  const byMetric = new Map<string, typeof incentive.slabs>();
  for (const slab of incentive.slabs) byMetric.set(slab.metricId, [...(byMetric.get(slab.metricId) ?? []), slab]);

  for (const metricId of [...byMetric.keys()].sort()) {
    const slabs = byMetric.get(metricId)!;
    const actual = measured.get(metricId);
    if (actual === undefined) {
      addUnresolved(builder, "INCENTIVE_METRIC_EVIDENCE_MISSING", `The Agreement's incentive schedule is measured on "${metricId}", which the pinned evidence does not report. Finance must confirm the incentive, if any.`, agreementSourceRef);
      continue;
    }

    const matching = slabs.filter((slab) => actual >= slab.lowerBound && (slab.upperBound === null || actual < slab.upperBound));
    if (matching.length > 1) {
      addUnresolved(builder, "INCENTIVE_THRESHOLD_AMBIGUOUS", `More than one incentive slab of "${metricId}" matches the measured value. Finance must confirm which applies.`, agreementSourceRef);
      continue;
    }
    if (matching.length === 0) {
      const lowest = Math.min(...slabs.map((slab) => slab.lowerBound));
      if (actual < lowest) {
        builder.warnings.push(`No incentive is payable for "${metricId}": the measured value is below the lowest slab the Agreement states.`);
        continue;
      }
      addUnresolved(builder, "INCENTIVE_THRESHOLD_AMBIGUOUS", `The measured value for "${metricId}" falls between the incentive slabs the Agreement states. Finance must confirm the incentive, if any.`, agreementSourceRef);
      continue;
    }

    const slab = matching[0]!;
    builder.lines.push({
      lineRef: deterministicPayableLineRef(payableRef, "INCENTIVE", slab.slabRef),
      label: `Incentive - ${metricId}`,
      category: "INCENTIVE",
      amountMinorSigned: slab.amountMinor,
      source: "AGREEMENT",
      sourceRef: agreementSourceRef,
      reason: `Incentive slab "${slab.slabRef}" of the confirmed Agreement terms: ${metricId} measured at ${actual} ${slab.unit}.`,
      actor: null,
      resolvesCode: null,
    });
  }
}

// --- Tax: GST + TDS (Step 15C section 9) -----------------------------------------------------------------------------------
// Basis is the service base ONLY (never the transfer fee, incentive, advance or a manual line -
// section 11). TDS is calculated on the service base before separately stated GST, per the
// CreatorOps business rule (section 9.2) - both percentages are of the SAME base, never compounded
// on one another.
function applyTax(builder: Builder, snapshot: PayableSourceSnapshot, payableRef: string, serviceBaseMinor: number | null): { gstMinor: number; tdsMinor: number } {
  if (serviceBaseMinor === null || serviceBaseMinor === 0) return { gstMinor: 0, tdsMinor: 0 };
  const tax = snapshot.tax;

  let gstMinor = 0;
  if (tax.gstApplicable) {
    if (tax.gstRateBps === null) {
      addUnresolved(builder, "GST_RATE_UNKNOWN", "GST is applicable to this Payable but no confirmed rate is available. Finance must confirm the GST rate before the gross expected Invoice total is accurate.", null);
    } else {
      gstMinor = percentBpsOfMinor(serviceBaseMinor, tax.gstRateBps);
      builder.lines.push({
        lineRef: deterministicPayableLineRef(payableRef, "GST", "tax-gst"),
        label: `GST (${(tax.gstRateBps / 100).toFixed(2).replace(/\.?0+$/, "")}%)`,
        category: "GST",
        amountMinorSigned: gstMinor,
        source: "PLATFORM_RULE",
        sourceRef: null,
        reason: `GST calculated on the prorated service base at the confirmed rate (source: ${tax.gstProvenance}).`,
        actor: null,
        resolvesCode: null,
      });
    }
  }

  let tdsMinor = 0;
  if (tax.tdsApplicable) {
    if (tax.tdsRateBps === null) {
      addUnresolved(builder, "TDS_RATE_UNKNOWN", "TDS is applicable to this Payable but no confirmed rate is available. Finance must confirm the TDS rate before the expected net payment is accurate.", null);
    } else {
      tdsMinor = percentBpsOfMinor(serviceBaseMinor, tax.tdsRateBps);
      builder.lines.push({
        lineRef: deterministicPayableLineRef(payableRef, "TDS", "tax-tds"),
        label: `TDS (${(tax.tdsRateBps / 100).toFixed(2).replace(/\.?0+$/, "")}%)`,
        category: "TDS",
        // A deduction: signed negative, exactly like every other reduction this engine represents.
        amountMinorSigned: -tdsMinor,
        source: "PLATFORM_RULE",
        sourceRef: null,
        reason: `TDS withheld on the prorated service base at the confirmed rate (source: ${tax.tdsProvenance}). This is platform payment treatment, separate from any Invoice-declared total.`,
        actor: null,
        resolvesCode: null,
      });
    }
  }

  return { gstMinor, tdsMinor };
}

// The whole determination for one immutable evidence snapshot. `payableRef` only seeds the
// deterministic engine line refs; it never changes an amount.
export function determinePayableAmount(snapshot: PayableSourceSnapshot, payableRef: string): PayableDeterminationResult {
  if (snapshot.currency === null) {
    return {
      state: "BLOCKED",
      lines: [],
      unresolved: [],
      blocked: [{ code: "CURRENCY_MISSING", message: "The Agreement states no currency, so no amount can be determined." }],
      warnings: [],
      serviceBaseMinor: null,
      gstMinor: 0,
      grossInvoiceExpectedMinor: null,
      tdsMinor: 0,
      expectedNetPaymentMinor: null,
      calculationRuleVersion: CURRENT_PAYABLE_CALCULATION_RULE_VERSION,
    };
  }

  const agreementSourceRef = sourceVersionRef(snapshot.agreement.agreementRef, snapshot.agreement.agreementVersion);
  const reviewSourceRef = snapshot.review ? sourceVersionRef(snapshot.review.reviewRef, snapshot.review.reviewVersion) : null;
  const builder: Builder = { lines: [], unresolved: [], warnings: [] };

  const { serviceBaseMinor } = applyBaseComponent(builder, snapshot, payableRef, agreementSourceRef, reviewSourceRef);
  applyLfcSfcWarnings(builder, snapshot);
  applyTargetWarnings(builder, snapshot);
  applyTransferFee(builder, snapshot, payableRef, agreementSourceRef);
  const { gstMinor, tdsMinor } = applyTax(builder, snapshot, payableRef, serviceBaseMinor);
  applyIncentive(builder, snapshot, payableRef, agreementSourceRef);
  applyAdvance(builder, snapshot, agreementSourceRef);

  const grossInvoiceExpectedMinor = serviceBaseMinor === null ? null : serviceBaseMinor + gstMinor;
  const expectedNetPaymentMinor = serviceBaseMinor === null ? null : serviceBaseMinor + gstMinor - tdsMinor;

  return {
    state: builder.unresolved.length > 0 ? "FINANCE_REVIEW_REQUIRED" : "DETERMINISTIC",
    lines: builder.lines,
    unresolved: builder.unresolved,
    blocked: [],
    warnings: builder.warnings,
    serviceBaseMinor,
    gstMinor,
    grossInvoiceExpectedMinor,
    tdsMinor,
    expectedNetPaymentMinor,
    calculationRuleVersion: CURRENT_PAYABLE_CALCULATION_RULE_VERSION,
  };
}

// The signed total of a full breakdown (engine lines plus any manual adjustments).
export function totalOfLines(lines: readonly PayableLine[]): number {
  return lines.reduce((sum, line) => sum + line.amountMinorSigned, 0);
}

// What still needs a Finance decision on a given version: the determination's unresolved items
// minus the ones a manual adjustment in the same breakdown explicitly resolves.
export function openReviewCodesOf(unresolved: readonly PayableUnresolvedItem[], lines: readonly PayableLine[]): PayableReviewCode[] {
  const resolved = new Set(lines.map((line) => line.resolvesCode).filter((code): code is string => code !== null));
  return [...new Set(unresolved.map((item) => item.code).filter((code) => !resolved.has(code)))];
}

// Convenience re-export so callers building a snapshot don't need to import ./types AND ./money
// separately for the one canonical TDS product-rule pairing.
export { TDS_PRODUCT_PROVENANCE, TDS_PRODUCT_RATE_BPS };
