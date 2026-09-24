import { describe, expect, it } from "vitest";

import type { AgreementVersionSummaryDto } from "@/server/finance-agreements";
import type { FinalizedReviewHandoffDto } from "@/server/partner-reviews/finalized-review-handoff";

import { buildPayableSourceSnapshot, isPinnableAgreementVersion, resolveGoverningAgreementVersion } from "./source-evidence";
import type { CommercialPeriod } from "./types";

// Step 15A section 19 (Source selection): the PURE halves of source resolution - which Agreement
// version governs a commercial period, which versions may be pinned at all, and what the immutable
// evidence snapshot copies (and refuses to copy). The authorization-dependent halves (a finalized
// Review, an Agreement conflict, a wrong Agreement/Review relationship) are proven end-to-end in
// finance-payables.emulator.test.ts against real records.

const PERIOD: CommercialPeriod = { periodKey: "2024-03", periodStart: "2024-03-01", periodEnd: "2024-03-31" };

function summary(overrides: Partial<AgreementVersionSummaryDto> & { version: number }): AgreementVersionSummaryDto {
  return {
    status: "ACTIVE",
    docVersion: 1,
    sourceMode: "MANUAL",
    confirmed: true,
    confirmedAt: "2023-12-20T00:00:00.000Z",
    confirmedByUserRef: "u",
    activatedAt: "2023-12-21T00:00:00.000Z",
    activatedByUserRef: "u",
    supersededVersion: null,
    supersededByVersion: null,
    suspendedAt: null,
    suspendReason: null,
    endedAt: null,
    endReason: null,
    signedDate: null,
    effectiveFrom: "2024-01-01",
    effectiveTo: null,
    agreementType: "FIXED_ONLY",
    createdAt: "2023-12-01T00:00:00.000Z",
    createdByUserRef: "u",
    updatedAt: "2023-12-21T00:00:00.000Z",
    updatedByUserRef: "u",
    document: { status: "NOT_APPLICABLE", fileName: null, storedAt: null, hasLink: false, attemptCount: 0, message: null, canStore: false },
    ...overrides,
  };
}

describe("which Agreement version governs a commercial period", () => {
  it("an ACTIVE version whose range covers the whole month governs it", () => {
    expect(resolveGoverningAgreementVersion([summary({ version: 1 })], PERIOD)).toBe(1);
  });

  it("a DRAFT version never governs, even when it is confirmed and its dates cover the month", () => {
    expect(resolveGoverningAgreementVersion([summary({ version: 1, status: "DRAFT", activatedAt: null, activatedByUserRef: null })], PERIOD)).toBeNull();
  });

  it("an unconfirmed version never governs", () => {
    expect(resolveGoverningAgreementVersion([summary({ version: 1, confirmed: false, confirmedAt: null, confirmedByUserRef: null })], PERIOD)).toBeNull();
  });

  it("a SUSPENDED version keeps governing (suspension is an operational hold, not a change of terms)", () => {
    expect(resolveGoverningAgreementVersion([summary({ version: 1, status: "SUSPENDED", suspendedAt: "2024-03-10T00:00:00.000Z", suspendReason: "On hold" })], PERIOD)).toBe(1);
  });

  it("a partly-covered month has NO governing version - nothing is ever prorated", () => {
    expect(resolveGoverningAgreementVersion([summary({ version: 1, effectiveFrom: "2024-03-15" })], PERIOD)).toBeNull();
    expect(resolveGoverningAgreementVersion([summary({ version: 1, effectiveTo: "2024-03-20" })], PERIOD)).toBeNull();
  });

  it("an ENDED version stops governing after the earlier of its end date and its termination date", () => {
    expect(resolveGoverningAgreementVersion([summary({ version: 1, status: "ENDED", endedAt: "2024-02-15T00:00:00.000Z", endReason: "Closed" })], PERIOD)).toBeNull();
    expect(resolveGoverningAgreementVersion([summary({ version: 1, status: "ENDED", endedAt: "2024-05-15T00:00:00.000Z", endReason: "Closed" })], PERIOD)).toBe(1);
  });

  it("a SUPERSEDED version governs only up to the day before its successor's effective date", () => {
    const v1 = summary({ version: 1, status: "SUPERSEDED", supersededByVersion: 2 });
    const forwardRevision = [v1, summary({ version: 2, effectiveFrom: "2024-07-01" })];
    expect(resolveGoverningAgreementVersion(forwardRevision, PERIOD)).toBe(1);

    const sameDateCorrection = [v1, summary({ version: 2, effectiveFrom: "2024-01-01" })];
    expect(resolveGoverningAgreementVersion(sameDateCorrection, PERIOD)).toBe(2);
  });

  it("a SUPERSEDED version whose successor is missing governs nothing (it is never trusted)", () => {
    expect(resolveGoverningAgreementVersion([summary({ version: 1, status: "SUPERSEDED", supersededByVersion: 2 })], PERIOD)).toBeNull();
  });

  it("when several versions cover the month, the highest version number wins", () => {
    expect(resolveGoverningAgreementVersion([summary({ version: 1 }), summary({ version: 3 }), summary({ version: 2 })], PERIOD)).toBe(3);
  });

  it("only confirmed, operationally-reached versions may be pinned at all", () => {
    expect(isPinnableAgreementVersion({ confirmed: true, status: "ACTIVE" })).toBe(true);
    expect(isPinnableAgreementVersion({ confirmed: true, status: "SUPERSEDED" })).toBe(true);
    expect(isPinnableAgreementVersion({ confirmed: true, status: "DRAFT" })).toBe(false);
    expect(isPinnableAgreementVersion({ confirmed: false, status: "ACTIVE" })).toBe(false);
  });
});

// A confirmed-terms slice with everything the snapshot may legitimately copy, plus the three
// clause-text fields it must never copy.
const TERMS = {
  agreementNumber: "AGR-1",
  dates: { signedDate: "2023-12-20", effectiveFrom: "2024-01-01", effectiveTo: "2024-12-31" },
  contractTerms: { renewalTerms: "Renews annually unless terminated.", noticeTerms: "Thirty days' written notice.", terminationTerms: "Either party may terminate for cause." },
  platform: { platforms: ["instagram"], collaboratorPageLink: null, collaboratorPageName: null },
  commercial: {
    currency: "INR" as const,
    paymentCycle: "MONTHLY" as const,
    fixedComponent: { applicable: true, amountMinor: 5_000_000 },
    monthlyRequiredQualifyingContentCount: 8,
    qualifyingUnit: "approved_content_thread",
    contentObligations: [{ obligationRef: "o-1", label: "Long-format content", quantity: 4, period: "Monthly", operationalMapping: null }],
    accountTransferFee: { applicable: true, amountMinor: 50_000, details: "Transfer charges apply." },
    advancePayment: { applicable: false, amountMinor: null, details: null },
    invoiceRequired: true,
    invoiceDueTerms: "Invoice by the 5th.",
    paymentDueTerms: "Payment within 30 days.",
    servicesMandated: "THE FULL MANDATED SERVICES CLAUSE TEXT OF THE CONTRACT, WHICH MUST NEVER BE COPIED.",
    incentive: { applicable: true, narrative: null, slabs: [{ slabRef: "s-1", metricId: "views", lowerBound: 1, upperBound: null, unit: "views", amountMinor: 250_000, description: "Tier 1" }] },
    lfcSfc: { byFormat: { reel: "SFC" as const } },
    monetisationTerms: "AD REVENUE SHARE CLAUSE TEXT, ALSO NEVER COPIED.",
  },
  performanceTargets: [],
  performanceEvaluationClause: null,
  admin: { onboardingProcessCompleted: null, remarks: "INTERNAL REMARKS, NEVER COPIED." },
  agreementType: "FIXED_PLUS_INCENTIVE_PLUS_REQUIRED_CONTENT" as const,
};

const HANDOFF: FinalizedReviewHandoffDto = {
  contractVersion: 1,
  reviewRef: "pr_0123456789abcdef0123",
  reviewVersion: 2,
  partner: { partnerRef: "partner-fixture", displayName: "Acme" },
  period: { periodKey: "2024-03", periodStart: "2024-03-01", periodEnd: "2024-03-31" },
  finalizedAt: "2024-04-02T00:00:00.000Z",
  evidenceCutoff: "2024-04-01T00:00:00.000Z",
  sourceFingerprint: "c".repeat(64),
  governingAgreement: { agreementRef: "agr_0123456789abcdef0123", agreementVersion: 2 },
  paymentAffectingEvidence: {
    monthlyDeliverable: { requiredCount: 8, requirementSource: { agreementRef: "agr_0123456789abcdef0123", agreementVersion: 2, requirementSourceRef: "agr_0123456789abcdef0123@2" }, qualifyingUnit: "approved_content_thread", actualQualifyingCount: 9, variance: 1, evaluation: "exceeded" },
    lfcSfc: { ruleRef: "agr_0123456789abcdef0123@2:lfc-sfc", ruleSource: { agreementRef: "agr_0123456789abcdef0123", agreementVersion: 2 }, qualifyingUnit: "approved_content_thread", lfcCount: 2, sfcCount: 7, unclassifiedCount: 0 },
  },
  warningOnlyTargets: [{ targetRef: "t-1", metricId: "views", targetValue: 100_000, unit: "views", actualValue: 300_000, evaluation: "met", unavailableReason: null, affectsPayment: false }],
  versionCurrency: { state: "current_finalized", currentFinalizedVersion: 2, referencedVersion: 2 },
};

describe("immutable evidence snapshot assembly", () => {
  const snapshot = buildPayableSourceSnapshot({
    counterpartyType: "PARTNER",
    counterpartyRef: "partner-fixture",
    period: PERIOD,
    sourceType: "PARTNER_REVIEW",
    agreementRef: "agr_0123456789abcdef0123",
    agreementVersion: 2,
    terms: TERMS,
    handoff: HANDOFF,
    reviewRef: "pr_0123456789abcdef0123",
    reviewVersion: 2,
    capturedAt: "2024-04-03T00:00:00.000Z",
  });

  it("pins the exact Agreement ref/version and the exact Partner Review ref/version", () => {
    expect(snapshot.agreement).toEqual({ agreementRef: "agr_0123456789abcdef0123", agreementVersion: 2, agreementType: "FIXED_PLUS_INCENTIVE_PLUS_REQUIRED_CONTENT", effectiveFrom: "2024-01-01", effectiveTo: "2024-12-31" });
    expect(snapshot.review).toEqual({ reviewRef: "pr_0123456789abcdef0123", reviewVersion: 2, finalizedAt: "2024-04-02T00:00:00.000Z", sourceFingerprint: "c".repeat(64) });
  });

  // Step 15C.1 section 10: a FRESHLY resolved Partner-Review-sourced snapshot never guesses GST -
  // it pins gstApplicable:null ("unconfirmed"), never false ("confirmed not applicable"). TDS is
  // the one confirmed CreatorOps product rule and applies unconditionally on this basis.
  it("pins GST applicability as unconfirmed (null), never a silent 'not applicable', for a Partner Review basis; TDS applies at the product rate", () => {
    expect(snapshot.tax.gstApplicable).toBeNull();
    expect(snapshot.tax.gstRateBps).toBeNull();
    expect(snapshot.tax.gstProvenance).toBe("UNCONFIRMED_NO_CANONICAL_SOURCE");
    expect(snapshot.tax.tdsApplicable).toBe(true);
    expect(snapshot.tax.tdsRateBps).toBe(1000);
  });

  it("copies the obligations, the actuals and the finance terms needed to explain the amount later", () => {
    expect(snapshot.qualifyingContent).toEqual({ requiredCount: 8, qualifyingUnit: "approved_content_thread", actualQualifyingCount: 9, variance: 1, evaluation: "exceeded", affectsPayment: true });
    expect(snapshot.lfcSfc).toEqual({ ruleRef: "agr_0123456789abcdef0123@2:lfc-sfc", qualifyingUnit: "approved_content_thread", lfcCount: 2, sfcCount: 7, unclassifiedCount: 0 });
    expect(snapshot.contentObligations).toEqual([{ obligationRef: "o-1", label: "Long-format content", quantity: 4, period: "Monthly", operationalMapping: null }]);
    expect(snapshot.fixedComponent).toEqual({ applicable: true, amountMinor: 5_000_000 });
    expect(snapshot.accountTransferFee).toEqual({ applicable: true, amountMinor: 50_000, details: "Transfer charges apply." });
    expect(snapshot.incentive?.slabs).toEqual([{ slabRef: "s-1", metricId: "views", lowerBound: 1, upperBound: null, unit: "views", amountMinor: 250_000 }]);
    expect(snapshot.paymentTerms).toEqual({ paymentCycle: "MONTHLY", invoiceRequired: true, invoiceDueTerms: "Invoice by the 5th.", paymentDueTerms: "Payment within 30 days." });
    expect(snapshot.currency).toBe("INR");
  });

  it("keeps performance targets warning-only, values and all", () => {
    expect(snapshot.performanceTargets).toEqual([{ targetRef: "t-1", metricId: "views", targetValue: 100_000, unit: "views", actualValue: 300_000, evaluation: "met", affectsPayment: false }]);
  });

  it("copies NO raw Agreement clause text and no internal remark anywhere in the stored JSON", () => {
    const serialized = JSON.stringify(snapshot);
    for (const forbidden of [TERMS.commercial.servicesMandated, TERMS.commercial.monetisationTerms, TERMS.contractTerms.renewalTerms, TERMS.contractTerms.noticeTerms, TERMS.contractTerms.terminationTerms, TERMS.admin.remarks]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("warns, rather than guessing, when the Agreement states an obligation the pinned evidence never evaluated", () => {
    const withoutEvidence = buildPayableSourceSnapshot({
      counterpartyType: "PARTNER",
      counterpartyRef: "partner-fixture",
      period: PERIOD,
      sourceType: "PARTNER_REVIEW",
      agreementRef: "agr_0123456789abcdef0123",
      agreementVersion: 2,
      terms: TERMS,
      handoff: { ...HANDOFF, paymentAffectingEvidence: { monthlyDeliverable: null, lfcSfc: null } },
      reviewRef: "pr_0123456789abcdef0123",
      reviewVersion: 2,
      capturedAt: "2024-04-03T00:00:00.000Z",
    });
    expect(withoutEvidence.qualifyingContent).toBeNull();
    expect(withoutEvidence.lfcSfc).toBeNull();
    expect(withoutEvidence.warnings.join(" ")).toMatch(/qualifying-content requirement/);
    expect(withoutEvidence.warnings.join(" ")).toMatch(/LFC\/SFC classification rule/);
  });

  it("builds a Vendor agreement-only snapshot with no fabricated Partner Review and says so in a warning", () => {
    const vendor = buildPayableSourceSnapshot({
      counterpartyType: "VENDOR",
      counterpartyRef: "vendor-fixture",
      period: PERIOD,
      sourceType: "AGREEMENT_ONLY",
      agreementRef: "agr_0123456789abcdef0123",
      agreementVersion: 2,
      terms: TERMS,
      handoff: null,
      reviewRef: null,
      reviewVersion: null,
      capturedAt: "2024-04-03T00:00:00.000Z",
    });
    expect(vendor.review).toBeNull();
    expect(vendor.qualifyingContent).toBeNull();
    expect(vendor.performanceTargets).toEqual([]);
    expect(vendor.warnings.join(" ")).toMatch(/governed by the Agreement alone/);
    // A Vendor/agreement-only basis carries no TDS/GST review workflow at all (see
    // payable-service.ts's confirmPayableTax) - it stays a confirmed, deterministic "not
    // applicable", never the "unconfirmed" state a Partner Review basis starts in.
    expect(vendor.tax).toEqual({ tdsApplicable: false, tdsRateBps: null, tdsProvenance: "NOT_APPLICABLE_AGREEMENT_ONLY_BASIS", gstApplicable: false, gstRateBps: null, gstProvenance: "NOT_APPLICABLE_AGREEMENT_ONLY_BASIS" });
  });
});
