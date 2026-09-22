import { describe, expect, it } from "vitest";

import type { AgreementDraftEntryDto, AgreementVersionDto } from "@/server/finance-agreements/client-dto";
import type { ConfirmedAgreementTerms, ContactSnapshot } from "@/server/finance-agreements/terms";

import { buildRevisionChanges, groupChangesBySection } from "./revision-changes";

const CONTACT: ContactSnapshot = { counterpartyName: "Asha Rao", contactNumber: null, emailAddress: null, state: null, address: null, pinCode: null };

function terms(fixedMinor: number, cycle: "MONTHLY" | "QUARTERLY" = "MONTHLY"): ConfirmedAgreementTerms {
  return {
    agreementNumber: null,
    dates: { signedDate: null, effectiveFrom: "2026-09-01", effectiveTo: null },
    contractTerms: { renewalTerms: null, noticeTerms: null, terminationTerms: null },
    platform: { platforms: ["instagram"], collaboratorPageLink: null, collaboratorPageName: null },
    commercial: {
      currency: "INR",
      paymentCycle: cycle,
      fixedComponent: { applicable: true, amountMinor: fixedMinor },
      monthlyRequiredQualifyingContentCount: null,
      qualifyingUnit: null,
      accountTransferFee: null,
      advancePayment: null,
      invoiceRequired: null,
      invoiceDueTerms: null,
      paymentDueTerms: null,
      servicesMandated: null,
      incentive: null,
      lfcSfc: null,
      contentObligations: [],
      monetisationTerms: null,
    },
    performanceTargets: [],
    performanceEvaluationClause: null,
    admin: { onboardingProcessCompleted: null, remarks: null },
    agreementType: "FIXED_ONLY",
  };
}

const entry = (over: Partial<AgreementDraftEntryDto>): AgreementDraftEntryDto => ({ value: null, origin: "MANUAL", decision: "PENDING", extractedValue: null, decidedByUserRef: null, decidedAt: null, provenance: { label: "previous version 1", extractionRunRef: null, page: null, confidence: null }, ...over });

const PRIOR = { version: 1, terms: terms(3500000), contactSnapshot: CONTACT };
const draftRevision = (draft: AgreementVersionDto["draft"]) => ({ version: 2, terms: null, contactSnapshot: null, draft });

describe("buildRevisionChanges", () => {
  it("a draft revision marks the fields already decided to a different value (with before / after text)", () => {
    const result = buildRevisionChanges({ viewed: draftRevision({ fixedComponent: entry({ decision: "CORRECTED", value: { applicable: true, amountMinor: 4000000 } }), paymentCycle: entry({ decision: "ACCEPTED", value: "MONTHLY" }) }), prior: PRIOR })!;
    expect(result.basis).toBe("draft");
    expect(result.priorVersion).toBe(1);
    expect(result.changes.map((change) => change.fieldKey)).toEqual(["fixedComponent"]);
    expect(result.changes[0]).toMatchObject({ beforeText: "₹35,000", afterText: "₹40,000" });
    expect(result.changedKeys.has("fixedComponent")).toBe(true);
    expect(result.changedKeys.has("paymentCycle")).toBe(false);
  });

  it("a still-PENDING draft entry is undecided (not changed) and is counted", () => {
    const result = buildRevisionChanges({ viewed: draftRevision({ fixedComponent: entry({ decision: "PENDING", value: { applicable: true, amountMinor: 999 } }), paymentCycle: entry({ decision: "PENDING", value: "QUARTERLY" }) }), prior: PRIOR })!;
    expect(result.changes).toEqual([]);
    expect(result.pendingCount).toBe(2);
  });

  it("a confirmed replacement is compared field by field with the version it replaces", () => {
    const result = buildRevisionChanges({ viewed: { version: 2, terms: terms(4000000, "QUARTERLY"), contactSnapshot: CONTACT, draft: {} }, prior: PRIOR })!;
    expect(result.basis).toBe("confirmed");
    expect(result.changes.map((change) => change.fieldKey).sort()).toEqual(["fixedComponent", "paymentCycle"]);
    expect(result.pendingCount).toBe(0);
  });

  it("identical terms produce no changes", () => {
    const result = buildRevisionChanges({ viewed: { version: 2, terms: terms(3500000), contactSnapshot: CONTACT, draft: {} }, prior: PRIOR })!;
    expect(result.changes).toEqual([]);
  });

  it("returns null when there is nothing to compare with (no prior, an unconfirmed prior, or the same version)", () => {
    expect(buildRevisionChanges({ viewed: draftRevision({}), prior: null })).toBeNull();
    expect(buildRevisionChanges({ viewed: null, prior: PRIOR })).toBeNull();
    expect(buildRevisionChanges({ viewed: draftRevision({}), prior: { version: 1, terms: null, contactSnapshot: null } })).toBeNull();
    expect(buildRevisionChanges({ viewed: { ...draftRevision({}), version: 1 }, prior: PRIOR })).toBeNull();
  });

  it("groups changes by the intake section they are edited in", () => {
    const result = buildRevisionChanges({ viewed: { version: 2, terms: terms(4000000, "QUARTERLY"), contactSnapshot: { ...CONTACT, contactNumber: "+91 9" }, draft: {} }, prior: PRIOR })!;
    const groups = groupChangesBySection(result.changes);
    expect(groups.map((group) => group.label).sort()).toEqual(["Commercial terms", "Cross-verification"]);
    expect(groups.find((group) => group.label === "Commercial terms")!.changes.map((change) => change.fieldKey).sort()).toEqual(["fixedComponent", "paymentCycle"]);
  });
});
