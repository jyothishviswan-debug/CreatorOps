import { describe, expect, it } from "vitest";

import { AGREEMENT_FIELD_BY_KEY, deriveAgreementType } from "@/server/finance-agreements/fields";
import { confirmedAgreementTermsSchema, type ConfirmedAgreementTerms, type ContactSnapshot } from "@/server/finance-agreements/terms";
import type { AgreementDraftEntryDto } from "@/server/finance-agreements/client-dto";
import type { AgreementFieldKey } from "@/server/finance-agreements/fields";

import { changedFieldKeys, diffConfirmedTerms, diffDraftAgainstPrior } from "./revision-diff";

function makeTerms(over: { fixedMinor?: number | null; cycle?: ConfirmedAgreementTerms["commercial"]["paymentCycle"]; count?: number | null; unit?: string | null; platforms?: string[]; effectiveTo?: string | null; remarks?: string | null; incentiveSlabs?: number } = {}): ConfirmedAgreementTerms {
  const fixedMinor = over.fixedMinor === undefined ? 3_500_000 : over.fixedMinor;
  const count = over.count === undefined ? 4 : over.count;
  const draft = {
    agreementNumber: "AG-1",
    dates: { signedDate: "2026-08-01", effectiveFrom: "2026-09-01", effectiveTo: over.effectiveTo === undefined ? "2027-08-31" : over.effectiveTo },
    contractTerms: { renewalTerms: null, noticeTerms: null, terminationTerms: null },
    platform: { platforms: over.platforms ?? ["instagram"], collaboratorPageLink: null, collaboratorPageName: null },
    commercial: {
      currency: "INR",
      paymentCycle: over.cycle === undefined ? "MONTHLY" : over.cycle,
      fixedComponent: fixedMinor === null ? { applicable: false, amountMinor: null } : { applicable: true, amountMinor: fixedMinor },
      monthlyRequiredQualifyingContentCount: count,
      qualifyingUnit: count === null ? null : (over.unit === undefined ? "approved_content_thread" : over.unit),
      accountTransferFee: null,
      advancePayment: null,
      invoiceRequired: null,
      invoiceDueTerms: null,
      paymentDueTerms: null,
      servicesMandated: null,
      incentive: over.incentiveSlabs
        ? { applicable: true, narrative: null, slabs: Array.from({ length: over.incentiveSlabs }, (_, i) => ({ slabRef: `s${i}`, metricId: "views", lowerBound: i * 100, upperBound: null, unit: "views", amountMinor: 1000, description: null })) }
        : null,
      lfcSfc: null,
      monetisationTerms: null,
    },
    performanceTargets: [],
    performanceEvaluationClause: null,
    admin: { onboardingProcessCompleted: null, remarks: over.remarks ?? null },
    agreementType: "UNSPECIFIED" as ConfirmedAgreementTerms["agreementType"],
  };
  draft.agreementType = deriveAgreementType(draft);
  return confirmedAgreementTermsSchema.parse(draft);
}
const CONTACT: ContactSnapshot = { counterpartyName: "Asha Nair", contactNumber: "+91 98765 43210", emailAddress: "asha@example.com", state: "Kerala", address: null, pinCode: null };
const set = (terms: ConfirmedAgreementTerms, contact: ContactSnapshot = CONTACT) => ({ terms, contactSnapshot: contact });

describe("diffConfirmedTerms - two confirmed term sets", () => {
  it("is empty for identical sets", () => {
    expect(diffConfirmedTerms(set(makeTerms()), set(makeTerms()))).toEqual([]);
  });

  it("reports exactly the changed fields, in registry order, with readable before / after text", () => {
    const changes = diffConfirmedTerms(set(makeTerms()), set(makeTerms({ fixedMinor: 4_000_000, cycle: "QUARTERLY", effectiveTo: "2028-08-31" })));
    expect(changes.map((c) => c.fieldKey)).toEqual(["terminationDate", "paymentCycle", "fixedComponent"]);
    const fixed = changes.find((c) => c.fieldKey === "fixedComponent")!;
    expect(fixed).toMatchObject({ label: "Fixed component", beforeText: "₹35,000", afterText: "₹40,000", section: "commercial_terms" });
    expect(changes.find((c) => c.fieldKey === "paymentCycle")).toMatchObject({ beforeText: "Monthly", afterText: "Quarterly" });
    expect(changes.find((c) => c.fieldKey === "terminationDate")).toMatchObject({ beforeText: "31 Aug 2027", afterText: "31 Aug 2028" });
  });

  it("includes the derived Agreement type when the commercial structure changes it", () => {
    const changes = diffConfirmedTerms(set(makeTerms()), set(makeTerms({ count: null })));
    expect(changes.map((c) => c.fieldKey)).toEqual(expect.arrayContaining(["monthlyRequiredQualifyingContentCount", "qualifyingUnit", "agreementType"]));
    expect(changes.find((c) => c.fieldKey === "agreementType")).toMatchObject({ beforeText: "Fixed + required content", afterText: "Fixed only" });
  });

  it("diffs structured values (platforms, incentive) and the contact snapshot", () => {
    const changes = diffConfirmedTerms(set(makeTerms({ platforms: ["instagram"] })), set(makeTerms({ platforms: ["instagram", "youtube"], incentiveSlabs: 2 }), { ...CONTACT, emailAddress: "new@example.com", address: "12 MG Road" }));
    const keys = changes.map((c) => c.fieldKey);
    expect(keys).toEqual(expect.arrayContaining(["platforms", "incentive", "emailAddress", "address"]));
    expect(changes.find((c) => c.fieldKey === "platforms")).toMatchObject({ beforeText: "Instagram", afterText: "Instagram + YouTube" });
    expect(changes.find((c) => c.fieldKey === "incentive")).toMatchObject({ beforeText: "—", afterText: "2 slabs" });
    expect(changes.find((c) => c.fieldKey === "emailAddress")).toMatchObject({ beforeText: "asha@example.com", afterText: "new@example.com" });
  });

  it("never reports an identity value or a KYC status (those have no stored value)", () => {
    const keys = diffConfirmedTerms(set(makeTerms()), set(makeTerms({ fixedMinor: 1 }))).map((c) => c.fieldKey);
    for (const key of keys) expect(AGREEMENT_FIELD_BY_KEY[key].identityValue).toBe(false);
    expect(keys).not.toContain("panNumber");
    expect(keys).not.toContain("gstin");
  });

  it("treats a missing side as all-null (a first-ever comparison)", () => {
    const changes = diffConfirmedTerms({ terms: null, contactSnapshot: null }, set(makeTerms()));
    expect(changes.length).toBeGreaterThan(5);
    expect(changes.find((c) => c.fieldKey === "paymentCycle")).toMatchObject({ beforeText: "—", afterText: "Monthly" });
  });

  it("changedFieldKeys collects the keys", () => {
    expect(changedFieldKeys(diffConfirmedTerms(set(makeTerms()), set(makeTerms({ cycle: "WEEKLY" }))))).toEqual(new Set<AgreementFieldKey>(["paymentCycle"]));
  });
});

describe("diffDraftAgainstPrior - an editable revision vs the prior confirmed terms", () => {
  const entry = (over: Partial<AgreementDraftEntryDto>): AgreementDraftEntryDto => ({ value: null, origin: "MANUAL", decision: "ACCEPTED", extractedValue: null, decidedByUserRef: null, decidedAt: null, provenance: { label: "Previous version 1", extractionRunRef: null, page: null, confidence: null }, ...over });
  const prior = set(makeTerms());

  it("a prefilled-and-unchanged draft has no changes", () => {
    expect(diffDraftAgainstPrior({ paymentCycle: entry({ value: "MONTHLY" }), fixedComponent: entry({ value: { applicable: true, amountMinor: 3_500_000 } }), currency: entry({ value: "INR" }) }, prior)).toEqual([]);
  });

  it("marks a field the person decided to a different value, with money formatted in the draft's currency", () => {
    const changes = diffDraftAgainstPrior({ paymentCycle: entry({ value: "QUARTERLY", decision: "CORRECTED" }), fixedComponent: entry({ value: { applicable: true, amountMinor: 4_250_000 }, decision: "CORRECTED" }) }, prior);
    expect(changes.map((c) => [c.fieldKey, c.beforeText, c.afterText])).toEqual([
      ["paymentCycle", "Monthly", "Quarterly"],
      ["fixedComponent", "₹35,000", "₹42,500"],
    ]);
  });

  it("UNAVAILABLE resolves to null and NOT_APPLICABLE to the field's not-applicable shape", () => {
    const changes = diffDraftAgainstPrior({ paymentCycle: entry({ decision: "UNAVAILABLE", value: null }), fixedComponent: entry({ decision: "NOT_APPLICABLE", value: null }) }, prior);
    expect(changes.find((c) => c.fieldKey === "paymentCycle")).toMatchObject({ after: null, afterText: "—" });
    expect(changes.find((c) => c.fieldKey === "fixedComponent")).toMatchObject({ after: { applicable: false, amountMinor: null }, afterText: "Not applicable" });
    // and a NOT_APPLICABLE that equals the prior not-applicable shape is no change
    const na = set(makeTerms({ fixedMinor: null }));
    expect(diffDraftAgainstPrior({ fixedComponent: entry({ decision: "NOT_APPLICABLE", value: null }) }, na)).toEqual([]);
  });

  it("a still-PENDING entry is undecided, not changed; a field with no entry is untouched", () => {
    expect(diffDraftAgainstPrior({ paymentCycle: entry({ decision: "PENDING", value: "QUARTERLY" }) }, prior)).toEqual([]);
    expect(diffDraftAgainstPrior({}, prior)).toEqual([]);
  });

  it("never compares the derived Agreement type (the server derives it at confirm)", () => {
    expect(diffDraftAgainstPrior({ agreementType: entry({ value: "FIXED_ONLY" }) }, prior)).toEqual([]);
  });
});
