// Step 14C - APPLICABILITY CERTIFICATION of the Agreement commercial-policy adapter against the running Firestore/Auth emulator, on
// real Agreement data created through the real services (no hand-written Agreement documents except the one documented `endedAt`
// move). Every rule of the 14C design is pinned here:
//   - a version governs a month only if its confirmed effective range covers the WHOLE month (no proration);
//   - v1 governs the months before a forward v2; v2 governs from its effective start; a forward v2 never rewrites v1's historical months;
//   - a month that STRADDLES the v1/v2 boundary has NO policy (unavailable) - it is never attributed to either version;
//   - ENDED governs only through its end date; SUPERSEDED stays valid historical policy for the months it governed;
//   - a DRAFT (even a confirmed, unactivated one) never governs; a Vendor Agreement never yields a Partner policy;
//   - the required count only with a supported unit; LFC/SFC only when explicit; targets are warning-only (no payment flag at all);
//   - the output carries NO fixed amount, currency, payment terms, incentive or invoice term;
//   - two different Agreements covering one month => the neutral conflict object (sorted refs), never a pick / merge / throw.
// Hermetic: private Partners, 2019 dates, everything removed afterwards.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { governingCommercialPolicySchema } from "@/server/partner-reviews/commercial-policy";

import { financeAgreementVersionsCollection } from "./firestore";
import { endAgreement, suspendAgreement } from "./index";
import { getAgreementCommercialPolicy } from "./policy-adapter";
import { createPolicyHarness, FIXED_AMOUNT_MINOR, INCENTIVE_AMOUNT_MINOR, SUPPORTED_UNIT } from "./testing/policy-harness";

vi.setConfig({ testTimeout: 90_000 });

const h = createPolicyHarness("apl");
const { decisionsWith, policyTerms, seed, decide } = h;

beforeAll(() => h.setup(), 60_000);
afterAll(() => h.teardown());

const at = (partnerRef: string, period: string) => getAgreementCommercialPolicy(partnerRef, period);

describe("v1 / v2 forward revision", () => {
  it("v1 governs the months BEFORE v2 starts, v2 governs from its effective start, and v2 never rewrites v1's historical months", async () => {
    const partner = await h.seedPartner();
    const v1 = await h.activeAgreement(partner, decisionsWith(policyTerms()));
    const ref = v1.head.agreementRef;
    // v2: forward revision effective 2019-07-01 (a whole-month boundary), requirement 5, same end date
    const v2 = await h.reviseAndActivate(v1, [seed("effectiveDate", "2019-07-01"), seed("monthlyRequiredQualifyingContentCount", 5)]);
    expect(v2.head.activeVersion).toBe(2);
    expect((await financeAgreementVersionsCollection(ref).doc("1").get()).data()).toMatchObject({ status: "SUPERSEDED", supersededByVersion: 2 });

    // months BEFORE v2 starts: v1's requirement (SUPERSEDED stays valid historical policy)
    for (const month of ["2019-01", "2019-03", "2019-06"]) {
      expect(await at(partner.partnerRef, month), month).toMatchObject({ agreementRef: ref, agreementVersion: 1, monthlyDeliverableRequirement: { requiredCount: 2 } });
    }
    // from v2's effective start
    for (const month of ["2019-07", "2019-09", "2019-12"]) {
      expect(await at(partner.partnerRef, month), month).toMatchObject({ agreementRef: ref, agreementVersion: 2, monthlyDeliverableRequirement: { requiredCount: 5 } });
    }
    // outside every confirmed range: nothing governs
    expect(await at(partner.partnerRef, "2018-12")).toBeNull();
    expect(await at(partner.partnerRef, "2020-01")).toBeNull();
  });

  it("a month that STRADDLES the v1/v2 boundary (v2 effective mid-month) has NO policy: unavailable, never mis-attributed to either version", async () => {
    const partner = await h.seedPartner();
    const v1 = await h.activeAgreement(partner, decisionsWith(policyTerms()));
    await h.reviseAndActivate(v1, [seed("effectiveDate", "2019-07-15"), seed("monthlyRequiredQualifyingContentCount", 5)]);
    expect(await at(partner.partnerRef, "2019-06")).toMatchObject({ agreementVersion: 1 });
    expect(await at(partner.partnerRef, "2019-07")).toBeNull(); // v1 ends 07-14, v2 starts 07-15: neither covers the WHOLE month
    expect(await at(partner.partnerRef, "2019-08")).toMatchObject({ agreementVersion: 2 });
  });

  it("a same-dates correction supersedes v1 entirely (v1 governs nothing, v2 governs every month v1 did)", async () => {
    const partner = await h.seedPartner();
    const v1 = await h.activeAgreement(partner, decisionsWith(policyTerms()));
    await h.reviseAndActivate(v1, [seed("monthlyRequiredQualifyingContentCount", 3)]);
    for (const month of ["2019-01", "2019-06", "2019-12"]) expect(await at(partner.partnerRef, month), month).toMatchObject({ agreementVersion: 2, monthlyDeliverableRequirement: { requiredCount: 3 } });
  });

  it("an Agreement starting mid-month has no policy for that partial month; an open-ended range governs later months", async () => {
    const partner = await h.seedPartner();
    await h.activeAgreement(partner, decisionsWith(policyTerms({ effectiveDate: seed("effectiveDate", "2019-02-15"), terminationDate: decide("terminationDate", "UNAVAILABLE") })));
    expect(await at(partner.partnerRef, "2019-02")).toBeNull();
    expect(await at(partner.partnerRef, "2019-03")).toMatchObject({ agreementVersion: 1 });
    expect(await at(partner.partnerRef, "2031-07")).toMatchObject({ agreementVersion: 1 });
  });
});

describe("lifecycle status: DRAFT, ACTIVE, SUSPENDED, ENDED", () => {
  it("a DRAFT never governs - neither an unconfirmed one nor a CONFIRMED one that is not activated - and an activation makes it govern", async () => {
    const manager = await h.actorFor("partnership_manager");
    const head = await h.actorFor("partnership_head");
    const partner = await h.seedPartner();

    const created = await h.createDraft(h.partnerCp(partner));
    expect(await at(partner.partnerRef, "2019-03")).toBeNull(); // unconfirmed draft

    const decided = await h.decideAll(manager, created, decisionsWith(policyTerms()));
    const confirmed = await h.confirm(manager, await h.acceptPending(manager, decided));
    expect(confirmed.head.status).toBe("DRAFT");
    expect(confirmed.selectedVersion!.confirmed).toBe(true);
    expect(await at(partner.partnerRef, "2019-03")).toBeNull(); // confirmed, awaiting activation

    await h.activate(head, confirmed);
    expect(await at(partner.partnerRef, "2019-03")).toMatchObject({ agreementVersion: 1 });
  });

  it("SUSPENDED keeps governing the months its range covers; ENDED governs only THROUGH its end date (min(effectiveTo, endedAt))", async () => {
    const head = await h.actorFor("partnership_head");
    const partner = await h.seedPartner();
    const active = await h.activeAgreement(partner, decisionsWith(policyTerms()));
    const ref = active.head.agreementRef;

    const suspended = h.must(await suspendAgreement(head, { agreementRef: ref, expectedDocVersion: active.head.docVersion, reason: "Audit hold" }, h.requestId()), "suspend");
    expect(suspended.head.status).toBe("SUSPENDED");
    expect(await at(partner.partnerRef, "2019-03")).toMatchObject({ agreementVersion: 1 });

    const ended = h.must(await endAgreement(head, { agreementRef: ref, expectedDocVersion: suspended.head.docVersion, reason: "Contract closed" }, h.requestId()), "end");
    expect(ended.head.status).toBe("ENDED");
    // ended long after the range: every month of the range still governed, the months after it are not
    expect(await at(partner.partnerRef, "2019-12")).toMatchObject({ agreementVersion: 1 });
    expect(await at(partner.partnerRef, "2020-01")).toBeNull();
    // an EARLY end (the one documented document move: endedAt back to 2019-03-10): governs Feb, not the partial March or later
    await financeAgreementVersionsCollection(ref).doc("1").update({ endedAt: "2019-03-10T00:00:00.000Z" });
    expect(await at(partner.partnerRef, "2019-02")).toMatchObject({ agreementVersion: 1 });
    expect(await at(partner.partnerRef, "2019-03")).toBeNull();
    expect(await at(partner.partnerRef, "2019-04")).toBeNull();
    // ... and an end on the LAST day of a month keeps that whole month governed
    await financeAgreementVersionsCollection(ref).doc("1").update({ endedAt: "2019-03-31T23:00:00.000Z" });
    expect(await at(partner.partnerRef, "2019-03")).toMatchObject({ agreementVersion: 1 });
    expect(await at(partner.partnerRef, "2019-04")).toBeNull();
  });

  it("a Vendor Agreement never yields a Partner policy (not for the Vendor's ref, not for any Partner)", async () => {
    const manager = await h.actorFor("partnership_manager");
    const head = await h.actorFor("partnership_head");
    const vendor = await h.seedVendor();
    const created = await h.createDraft({ type: "VENDOR", vendorRef: vendor.vendorRef });
    const confirmed = await h.confirm(manager, await h.acceptPending(manager, await h.decideAll(manager, created, decisionsWith(policyTerms()))));
    const active = await h.activate(head, confirmed);
    expect(active.head).toMatchObject({ status: "ACTIVE", counterparty: { type: "VENDOR" } });
    expect(await at(vendor.vendorRef, "2019-03")).toBeNull();
    expect(await at((await h.seedPartner()).partnerRef, "2019-03")).toBeNull();
  });
});

describe("what the policy carries", () => {
  it("the required count only with a SUPPORTED unit: an unsupported free-text unit, or no stated requirement at all, leaves the requirement out (unavailable, never guessed)", async () => {
    const withUnit = async (over: Record<string, ReturnType<typeof seed> | null>) => {
      const partner = await h.seedPartner();
      const active = await h.activeAgreement(partner, decisionsWith(policyTerms(over)));
      return { partner, ref: active.head.agreementRef };
    };

    const supported = await withUnit({});
    expect(await at(supported.partner.partnerRef, "2019-03")).toMatchObject({ monthlyDeliverableRequirement: { requiredCount: 2, qualifyingUnit: SUPPORTED_UNIT } });
    const otherSupported = await withUnit({ qualifyingUnit: seed("qualifyingUnit", "approved_current_link") });
    expect(await at(otherSupported.partner.partnerRef, "2019-03")).toMatchObject({ monthlyDeliverableRequirement: { qualifyingUnit: "approved_current_link" } });

    const unsupported = await withUnit({ qualifyingUnit: seed("qualifyingUnit", "reel") });
    const unsupportedPolicy = await at(unsupported.partner.partnerRef, "2019-03");
    expect(unsupportedPolicy).toMatchObject({ agreementRef: unsupported.ref, agreementVersion: 1 });
    expect(unsupportedPolicy).not.toHaveProperty("monthlyDeliverableRequirement");

    // (a count without a unit - or a unit without a count - cannot even be confirmed: the Agreement requires them together)
    const neither = await withUnit({ monthlyRequiredQualifyingContentCount: decide("monthlyRequiredQualifyingContentCount", "UNAVAILABLE"), qualifyingUnit: decide("qualifyingUnit", "UNAVAILABLE") });
    expect(await at(neither.partner.partnerRef, "2019-03")).not.toHaveProperty("monthlyDeliverableRequirement");
  });

  it("LFC/SFC only when the confirmed terms state an explicit rule - never derived from the format list, the unit or the platform", async () => {
    const explicit = await h.seedPartner();
    await h.activeAgreement(explicit, decisionsWith(policyTerms({ lfcSfc: seed("lfcSfc", { byFormat: { reel: "LFC", story: "SFC" } }) })));
    expect(await at(explicit.partnerRef, "2019-03")).toMatchObject({ lfcSfcRule: { byFormat: { reel: "LFC", story: "SFC" }, affectsPayment: true } });

    const none = await h.seedPartner();
    await h.activeAgreement(none, decisionsWith(policyTerms({ lfcSfc: decide("lfcSfc", "UNAVAILABLE") })));
    expect(await at(none.partnerRef, "2019-03")).not.toHaveProperty("lfcSfcRule");
    const notApplicable = await h.seedPartner();
    await h.activeAgreement(notApplicable, decisionsWith(policyTerms({ lfcSfc: decide("lfcSfc", "NOT_APPLICABLE") })));
    expect(await at(notApplicable.partnerRef, "2019-03")).not.toHaveProperty("lfcSfcRule");
  });

  it("targets are warning-only: the policy carries NO payment flag at all, and the Agreement's stored flag is the literal false", async () => {
    const partner = await h.seedPartner();
    const active = await h.activeAgreement(
      partner,
      decisionsWith(
        policyTerms({
          performanceTargets: seed("performanceTargets", [
            { targetRef: "t-views", metricId: "views", targetValue: 5000, unit: "views", comparison: "at_least", affectsPayment: false },
            { targetRef: "t-growth", metricId: "followerGrowth", targetValue: 1000, unit: "followers", comparison: "at_least", affectsPayment: false },
          ]),
        }),
      ),
    );
    for (const target of active.selectedVersion!.terms!.performanceTargets) expect(target.affectsPayment).toBe(false);
    const policy = await at(partner.partnerRef, "2019-03");
    expect(policy).toMatchObject({ targets: [{ targetRef: "t-views" }, { targetRef: "t-growth" }] });
    // (the LFC/SFC rule carries Partner Reviews' own rule-shape flag; a TARGET never does)
    expect(JSON.stringify((policy as { targets: unknown }).targets)).not.toMatch(/affectsPayment|payment/i);
    expect(governingCommercialPolicySchema.safeParse(policy).success).toBe(true);
  });

  it("the output carries NO fixed amount, currency, payment terms, incentive or invoice term (the Agreement HAS them; Partner Reviews never sees them)", async () => {
    const partner = await h.seedPartner();
    const active = await h.activeAgreement(partner, decisionsWith(policyTerms()));
    // sanity: the confirmed terms really do hold money terms
    const commercial = active.selectedVersion!.terms!.commercial as unknown as Record<string, unknown>;
    expect(JSON.stringify(commercial)).toContain(String(FIXED_AMOUNT_MINOR));
    expect(commercial.currency).toBe("INR");

    const policy = await at(partner.partnerRef, "2019-03");
    expect(policy).not.toBeNull();
    const json = JSON.stringify(policy);
    expect(json).not.toContain(String(FIXED_AMOUNT_MINOR));
    expect(json).not.toContain(String(INCENTIVE_AMOUNT_MINOR));
    expect(json).not.toMatch(/amountMinor|fixedComponent|currency|INR|paymentCycle|paymentDue|invoice|incentive|slab|advance|accountTransfer|payable/i);
    // the top-level keys are exactly the documented, money-free set
    expect(Object.keys(policy as object).sort()).toEqual(["agreementRef", "agreementVersion", "lfcSfcRule", "monthlyDeliverableRequirement", "targets"]);
  });
});

describe("overlap: two different Agreements of one Partner cover the month", () => {
  it("returns the neutral conflict (sorted refs) for exactly the months both cover; a one-sided month is that Agreement's policy; nothing is merged", async () => {
    const partner = await h.seedPartner();
    // A covers 2019 entirely; B covers 2019-03 .. 2019-12 (starts on the 1st of March)
    const a = await h.activeAgreement(partner, decisionsWith(policyTerms()));
    const b = await h.activeAgreement(partner, decisionsWith(policyTerms({ effectiveDate: seed("effectiveDate", "2019-03-01") })));
    const refs = [a.head.agreementRef, b.head.agreementRef].sort();

    expect(await at(partner.partnerRef, "2019-02")).toMatchObject({ agreementRef: a.head.agreementRef }); // only A covers February
    for (const month of ["2019-03", "2019-08", "2019-12"]) {
      expect(await at(partner.partnerRef, month), month).toEqual({ kind: "conflict", reason: "multiple_applicable_agreements", agreementRefs: refs });
    }
    expect(await at(partner.partnerRef, "2020-01")).toBeNull();
  });

  it("a SUPERSEDED / non-governing version of the same Agreement is not a second Agreement (one Agreement, however many versions, never conflicts with itself)", async () => {
    const partner = await h.seedPartner();
    const v1 = await h.activeAgreement(partner, decisionsWith(policyTerms()));
    await h.reviseAndActivate(v1, [seed("monthlyRequiredQualifyingContentCount", 4)]);
    expect(await at(partner.partnerRef, "2019-03")).toMatchObject({ agreementRef: v1.head.agreementRef, agreementVersion: 2 });
  });

  it("a conflict resolves when a revision corrects one Agreement's range (no automatic merge) - and a third Agreement makes it a three-way conflict", async () => {
    const partner = await h.seedPartner();
    const a = await h.activeAgreement(partner, decisionsWith(policyTerms()));
    const b = await h.activeAgreement(partner, decisionsWith(policyTerms()));
    expect(await at(partner.partnerRef, "2019-03")).toMatchObject({ kind: "conflict" });

    // B is corrected to end in February: from March on only A governs
    await h.reviseAndActivate(b, [seed("terminationDate", "2019-02-28")]);
    expect(await at(partner.partnerRef, "2019-03")).toMatchObject({ agreementRef: a.head.agreementRef, agreementVersion: 1 });
    expect(await at(partner.partnerRef, "2019-02")).toMatchObject({ kind: "conflict" });

    const c = await h.activeAgreement(partner, decisionsWith(policyTerms()));
    const conflict = (await at(partner.partnerRef, "2019-03")) as { kind: string; agreementRefs: string[] };
    expect(conflict.kind).toBe("conflict");
    expect(conflict.agreementRefs).toEqual([a.head.agreementRef, c.head.agreementRef].sort());
  });
});
