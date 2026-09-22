import { describe, expect, it } from "vitest";

import { confirmedAgreementTermsSchema, type ConfirmedAgreementTerms, type ContactSnapshot } from "@/server/finance-agreements/terms";

import { NEEDS_MAPPING_LABEL, TARGET_MONITORING_LABEL } from "../format";
import { NOT_APPLICABLE_TEXT, NOT_STATED_TEXT, buildCommercialSummary, buildCommercialRows, buildSlabRows, buildTargetRows, buildTermsView, metricLabel, slabRange } from "./terms-view";

function terms(overrides: { commercial?: Partial<ConfirmedAgreementTerms["commercial"]>; agreementType?: ConfirmedAgreementTerms["agreementType"]; performanceTargets?: ConfirmedAgreementTerms["performanceTargets"] } = {}): ConfirmedAgreementTerms {
  return {
    agreementNumber: "AG-2026-014",
    dates: { signedDate: "2026-08-30", effectiveFrom: "2026-09-01", effectiveTo: "2027-08-31" },
    contractTerms: { renewalTerms: "Renews yearly.", noticeTerms: null, terminationTerms: "30 days notice." },
    platform: { platforms: ["instagram", "youtube"], collaboratorPageLink: "https://example.com/page", collaboratorPageName: null },
    commercial: {
      currency: "INR",
      paymentCycle: "MONTHLY",
      fixedComponent: { applicable: true, amountMinor: 3500000 },
      monthlyRequiredQualifyingContentCount: 4,
      qualifyingUnit: "approved_content_thread",
      accountTransferFee: { applicable: false, amountMinor: null, details: null },
      advancePayment: null,
      invoiceRequired: true,
      invoiceDueTerms: "Within 7 days.",
      paymentDueTerms: null,
      servicesMandated: "Line one.\nLine two.",
      incentive: { applicable: false, narrative: null, slabs: [] },
      lfcSfc: null,
      contentObligations: [],
      monetisationTerms: null,
      ...overrides.commercial,
    },
    performanceTargets: overrides.performanceTargets ?? [],
    performanceEvaluationClause: null,
    admin: { onboardingProcessCompleted: true, remarks: null },
    agreementType: overrides.agreementType ?? "FIXED_PLUS_REQUIRED_CONTENT",
  };
}

const CONTACT: ContactSnapshot = { counterpartyName: "Asha Rao", contactNumber: "+91 90000 00000", emailAddress: null, state: "Karnataka", address: null, pinCode: null };
const byKey = <T extends { key: string }>(rows: T[], key: string): T => rows.find((item) => item.key === key)!;

describe("the sample terms are valid ConfirmedAgreementTerms (so the fixtures below are realistic)", () => {
  it("parses", () => {
    expect(confirmedAgreementTermsSchema.safeParse(terms()).success).toBe(true);
  });
});

describe("payment-affecting rows", () => {
  const rows = buildCommercialRows(terms());

  it("formats money from integer minor units with Indian grouping", () => {
    expect(byKey(rows, "fixedComponent").value).toBe("₹35,000");
  });

  it("uses the canonical label for the qualifying content requirement and never 'Fixed deliverable units'", () => {
    expect(byKey(rows, "monthlyRequiredQualifyingContentCount").label).toBe("Monthly required qualifying content");
    expect(byKey(rows, "monthlyRequiredQualifyingContentCount").value).toBe("4");
    expect(rows.some((item) => /deliverable/i.test(item.label))).toBe(false);
  });

  it("maps the supported qualifying units to their labels and flags unsupported wording as Needs mapping (as written)", () => {
    expect(byKey(rows, "qualifyingUnit")).toMatchObject({ value: "Approved Content", flag: null });
    expect(byKey(buildCommercialRows(terms({ commercial: { qualifyingUnit: "approved_current_link" } })), "qualifyingUnit").value).toBe("Approved current link");
    expect(byKey(buildCommercialRows(terms({ commercial: { qualifyingUnit: "reel" } })), "qualifyingUnit")).toMatchObject({ value: "reel", flag: NEEDS_MAPPING_LABEL });
  });

  it("distinguishes 'not applicable' from 'not stated'", () => {
    expect(byKey(rows, "accountTransferFee").value).toBe(NOT_APPLICABLE_TEXT);
    expect(byKey(rows, "advancePayment").value).toBe(NOT_STATED_TEXT);
    expect(byKey(rows, "paymentDueTerms").value).toBe(NOT_STATED_TEXT);
    expect(byKey(rows, "invoiceRequired").value).toBe("Yes");
    expect(byKey(buildCommercialRows(terms({ commercial: { invoiceRequired: null } })), "invoiceRequired").value).toBe(NOT_STATED_TEXT);
  });

  it("keeps clause text and marks long clauses multiline", () => {
    expect(byKey(rows, "servicesMandated")).toMatchObject({ value: "Line one.\nLine two.", multiline: true });
  });

  it("shows the derived Agreement type as a label", () => {
    expect(byKey(rows, "agreementType").value).toBe("Fixed + required content");
  });

  it("an applicable fee or advance shows the amount and its details", () => {
    const withFee = buildCommercialRows(terms({ commercial: { accountTransferFee: { applicable: true, amountMinor: 50000, details: "Per transfer" }, advancePayment: { applicable: true, details: "Half upfront", amountMinor: null } } }));
    expect(byKey(withFee, "accountTransferFee")).toMatchObject({ value: "₹500", detail: "Per transfer" });
    expect(byKey(withFee, "advancePayment")).toMatchObject({ value: "Half upfront" });
  });

  it("LFC / SFC appears ONLY when the Agreement states a rule", () => {
    expect(rows.some((item) => item.key === "lfcSfc")).toBe(false);
    const explicit = buildTermsView(terms({ commercial: { lfcSfc: { byFormat: { reel: "SFC", video: "LFC" } } } }), CONTACT);
    expect(byKey(explicit.commercial, "lfcSfc").value).toBe("2 formats");
    expect(explicit.lfcSfc).toEqual([
      { format: "reel", rule: "SFC" },
      { format: "video", rule: "LFC" },
    ]);
    expect(buildTermsView(terms(), CONTACT).lfcSfc).toEqual([]);
  });
});

describe("incentive slabs", () => {
  const SLAB = { slabRef: "s1", metricId: "views", lowerBound: 100000, upperBound: null, unit: "views", amountMinor: 250000, description: "Bonus" };

  it("renders a range, a metric label and money", () => {
    expect(buildSlabRows([SLAB, { ...SLAB, slabRef: "s2", lowerBound: 0, upperBound: 50000 }], "INR")).toEqual([
      { slabRef: "s1", metric: "Views", range: "100000+ views", amount: "₹2,500", description: "Bonus" },
      { slabRef: "s2", metric: "Views", range: "0 to 50000 views", amount: "₹2,500", description: "Bonus" },
    ]);
    expect(slabRange({ lowerBound: 1, upperBound: 5, unit: "posts" })).toBe("1 to 5 posts");
  });

  it("slab rows exist only for an applicable incentive", () => {
    const applicable = buildTermsView(terms({ commercial: { incentive: { applicable: true, narrative: null, slabs: [SLAB] }, monthlyRequiredQualifyingContentCount: null, qualifyingUnit: null }, agreementType: "FIXED_PLUS_INCENTIVE" }), CONTACT);
    expect(applicable.slabs).toHaveLength(1);
    expect(byKey(applicable.commercial, "incentive").value).toBe("1 slab");
    expect(buildTermsView(terms(), CONTACT).slabs).toEqual([]);
    expect(byKey(buildTermsView(terms(), CONTACT).commercial, "incentive").value).toBe(NOT_APPLICABLE_TEXT);
  });
});

describe("performance targets (warning only)", () => {
  const TARGET = { targetRef: "t1", metricId: "followerGrowth", targetValue: 5000, unit: "followers", comparison: "at_least" as const, period: null, anchor: null, affectsPayment: false as const };

  it("every target reads 'Monitoring only · does not affect payment' and lives outside the payment rows", () => {
    const view = buildTermsView(terms({ performanceTargets: [TARGET, { ...TARGET, targetRef: "t2", metricId: "reach", targetValue: 90000, unit: "accounts" }] }), CONTACT);
    expect(view.targets).toEqual([
      { targetRef: "t1", metric: "Follower growth", target: "At least 5000 followers", monitoring: TARGET_MONITORING_LABEL },
      { targetRef: "t2", metric: "Reach", target: "At least 90000 accounts", monitoring: TARGET_MONITORING_LABEL },
    ]);
    expect(TARGET_MONITORING_LABEL).toBe("Monitoring only · does not affect payment");
    expect(view.commercial.some((item) => item.key === "performanceTargets" || /target/i.test(item.label))).toBe(false);
    expect(buildTargetRows([]).length).toBe(0);
  });

  it("an unknown metric id is shown as written", () => {
    expect(metricLabel("watchTime")).toBe("watchTime");
    expect(metricLabel("engagement")).toBe("Engagement");
  });
});

describe("agreement / platform / contact / admin rows", () => {
  const view = buildTermsView(terms(), CONTACT);

  it("formats dates and platform scope", () => {
    expect(byKey(view.agreement, "effectiveDate").value).toBe("1 Sep 2026");
    expect(byKey(view.agreement, "terminationDate").value).toBe("31 Aug 2027");
    expect(byKey(view.agreement, "noticeTerms").value).toBe(NOT_STATED_TEXT);
    expect(byKey(view.platform, "platforms").value).toBe("Instagram + YouTube");
  });

  it("carries the frozen contact snapshot and no restricted identity row", () => {
    expect(byKey(view.contact, "counterpartyName").value).toBe("Asha Rao");
    expect(byKey(view.contact, "emailAddress").value).toBe(NOT_STATED_TEXT);
    const allKeys = [...view.agreement, ...view.platform, ...view.contact, ...view.commercial, ...view.admin].map((item) => item.key);
    expect(allKeys.some((key) => /pan|aadhaar|gstin|bank|ifsc/i.test(key))).toBe(false);
    expect(buildTermsView(terms(), null).contact).toEqual([]);
  });

  it("an open-ended Agreement says the end date is not stated", () => {
    const open = terms();
    open.dates.effectiveTo = null;
    expect(byKey(buildTermsView(open, CONTACT).agreement, "terminationDate").value).toBe(NOT_STATED_TEXT);
  });
});

describe("commercial summary", () => {
  it("is the short list a reader wants first", () => {
    expect(buildCommercialSummary(terms()).map((item) => item.key)).toEqual(["currency", "paymentCycle", "fixedComponent", "monthlyRequiredQualifyingContentCount", "qualifyingUnit", "incentive", "agreementType"]);
  });
});
