import { deterministicPayableLineRef, sourceVersionRef } from "./ids";
import type { PayableBlockedCode, PayableDeterminationState, PayableLine, PayableReviewCode, PayableSourceSnapshot, PayableUnresolvedItem } from "./types";

// Step 15A: the Payable AMOUNT DETERMINATION engine.
//
// PURE, deterministic and actor-independent: the same immutable snapshot always produces the same
// breakdown. It reads no clock, no Firestore, no actor and no permission - the service applies
// those around it. That is what makes an amount reproducible from the stored evidence years later.
//
// THE GOVERNING PRINCIPLE (section 7): no commercial mathematics is invented here. Something is
// calculated automatically ONLY when the CONFIRMED Agreement terms explicitly support the
// calculation. Anything else is handed to Finance as an explicit, named item to confirm - it is
// never guessed, defaulted, prorated or silently dropped.
//
// Three outcomes:
//   DETERMINISTIC            every commercial term in scope converted without ambiguity.
//   FINANCE_REVIEW_REQUIRED  at least one named item needs a human Finance decision. The amount
//                            computed so far is still shown; nothing has been reduced or guessed.
//   BLOCKED                  the evidence cannot support a payable at all. Never persisted (see
//                            payableVersionDocSchema) - it is a refusal to generate.
//
// THE UNDER-DELIVERY RULE, stated explicitly because it is the easiest thing to get wrong:
// a fixed fee is NEVER prorated, penalised, deducted or zeroed because qualifying-content
// obligations were missed. The confirmed-terms model carries NO payment-consequence term for
// under-delivery at all, so an explicit supported consequence can never exist in it today; missed
// obligations therefore raise UNDER_DELIVERY_NO_STATED_CONSEQUENCE (Finance looks) and change the
// amount by exactly zero. Performance targets are warning-only by construction
// (`affectsPayment: false`) and never change an amount either - only an explicit incentive slab
// naming a metric can turn a measured value into money.

export type PayableDeterminationResult = {
  state: PayableDeterminationState;
  // Engine-derived breakdown lines only, in a stable order. Manual adjustments are appended by
  // the service; the engine never invents one.
  lines: PayableLine[];
  unresolved: PayableUnresolvedItem[];
  blocked: Array<{ code: PayableBlockedCode; message: string }>;
  warnings: string[];
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

// --- Fixed component -----------------------------------------------------------------------------------------------------
// The one genuinely deterministic case: the Agreement states an applicable fixed amount, and the
// confirmed terms state no payment-reduction formula of any kind (none is representable), so the
// amount is the amount.
function applyFixedComponent(builder: Builder, snapshot: PayableSourceSnapshot, payableRef: string, agreementSourceRef: string): void {
  const fixed = snapshot.fixedComponent;
  if (!fixed || !fixed.applicable || fixed.amountMinor === null) return;
  builder.lines.push({
    lineRef: deterministicPayableLineRef(payableRef, "BASE_FIXED", "agreement-fixed-component"),
    label: "Fixed component",
    category: "BASE_FIXED",
    amountMinorSigned: fixed.amountMinor,
    source: "AGREEMENT",
    sourceRef: agreementSourceRef,
    reason: "Fixed component stated by the confirmed Agreement terms.",
    actor: null,
    resolvesCode: null,
  });
}

// --- Qualifying-content delivery -------------------------------------------------------------------------------------------
// Evidence only. Under-delivery NEVER reduces anything here; it raises a named Finance item.
function applyDeliveryEvidence(builder: Builder, snapshot: PayableSourceSnapshot, agreementSourceRef: string): void {
  const delivery = snapshot.qualifyingContent;
  if (!delivery) return;
  if (delivery.evaluation === "below_requirement") {
    addUnresolved(
      builder,
      "UNDER_DELIVERY_NO_STATED_CONSEQUENCE",
      `Qualifying content was under-delivered (${delivery.actualQualifyingCount} of ${delivery.requiredCount} ${delivery.qualifyingUnit}). The Agreement states no payment consequence for this, so nothing has been deducted - Finance must decide.`,
      agreementSourceRef,
    );
  }
}

// --- Account transfer fee ---------------------------------------------------------------------------------------------------
// Same shape as the fixed component (section 7's own example of a safe deterministic case): the
// Agreement ticks the fee applicable and states its amount, so the fee is added as its own
// breakdown line - a separate TRANSFER_FEE category, never merged into BASE_FIXED, so a future
// Invoice consuming this version's lines can show/handle it as its own item. Ticked applicable
// with NO stated amount is the genuinely ambiguous case (there is no number to use) and is handed
// to Finance rather than guessed.
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
}

// --- Advance payment ---------------------------------------------------------------------------------------------------------
// Same shape: an advance exists, but the Agreement does not unambiguously state how much of it (if
// any) applies to THIS period. Never amortised, never split evenly, never fully recovered here.
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
// Deterministic ONLY for an explicit structured slab where all four conditions of section 7 hold:
//   1. the Agreement explicitly makes the incentive payable (`applicable`);
//   2. the metric is supported - the pinned evidence actually measured it;
//   3. source evidence exists - that measurement is a real number, not "unavailable";
//   4. threshold interpretation is unambiguous - exactly one slab of that metric matches, or the
//      measurement is below every slab of it (which unambiguously means "no incentive").
// Anything else (a narrative/discretionary clause, an unmeasured metric, overlapping slabs, a gap
// between slabs) is a named Finance item and contributes no money.
//
// The measured value comes from the pinned Review's performance targets, which are themselves
// warning-only: their met/not-met EVALUATION never affects an amount. Only the Agreement's own
// explicit slab schedule turns a measurement into money.
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

// The whole determination for one immutable evidence snapshot. `payableRef` only seeds the
// deterministic engine line refs; it never changes an amount.
export function determinePayableAmount(snapshot: PayableSourceSnapshot, payableRef: string): PayableDeterminationResult {
  if (snapshot.currency === null) {
    return { state: "BLOCKED", lines: [], unresolved: [], blocked: [{ code: "CURRENCY_MISSING", message: "The Agreement states no currency, so no amount can be determined." }], warnings: [] };
  }

  const agreementSourceRef = sourceVersionRef(snapshot.agreement.agreementRef, snapshot.agreement.agreementVersion);
  const builder: Builder = { lines: [], unresolved: [], warnings: [] };

  applyFixedComponent(builder, snapshot, payableRef, agreementSourceRef);
  applyDeliveryEvidence(builder, snapshot, agreementSourceRef);
  applyTransferFee(builder, snapshot, payableRef, agreementSourceRef);
  applyIncentive(builder, snapshot, payableRef, agreementSourceRef);
  applyAdvance(builder, snapshot, agreementSourceRef);

  return {
    state: builder.unresolved.length > 0 ? "FINANCE_REVIEW_REQUIRED" : "DETERMINISTIC",
    lines: builder.lines,
    unresolved: builder.unresolved,
    blocked: [],
    warnings: builder.warnings,
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
