// Step 14C - Partner Reviews x Finance Agreements THROUGH THE REAL REGISTRATION PATH, against the running Firestore/Auth emulator.
//
// beforeAll calls registerServerProviders() - exactly what src/instrumentation.ts does at server start - and NO test in this file
// installs a provider through the test-only override. Every review below is therefore governed by the production-registered Agreement
// adapter. Proven here:
//   - the required count appears only with a SUPPORTED unit, LFC/SFC only with an explicit rule, targets are warning-only, and
//     unsupported / missing Analytics reads Unavailable - never "Not met";
//   - the Agreement policy identity/version is in the review fingerprint: activating an applicable v2 makes a draft `refresh_available`
//     and a finalized review `revision_available`; refresh / a revision picks v2 up; the old FINALIZED review stays immutable with v1;
//   - UNRELATED Agreement changes (another Partner's Agreement, a Vendor Agreement, an unactivated revision with different remarks / fixed
//     amount, suspend / resume, an end after the month) do NOT change the fingerprint;
//   - an OVERLAP of two Agreements never crashes or picks: the review generates with the commercial evidence unavailable + the conflict
//     marker, the fingerprint flips when the overlap is resolved, nothing is merged;
//   - no fixed amount / currency / payment term / incentive / invoice term reaches any Partner Review DTO, snapshot or handoff (JSON walk),
//     and generating / refreshing / finalizing writes nothing to any financeAgreement* / financeContract* collection.
// Hermetic (private Partners, 2019 dates, private region) and the registry state is restored afterwards.
import { readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { collectPartnerEvidence } from "@/server/partner-reviews/evidence-collector";
import { getRegisteredCommercialPolicyProviderId, resetRegisteredCommercialPolicyProviderForTests } from "@/server/partner-reviews/commercial-policy";
import { getFinalizedReviewHandoff } from "@/server/partner-reviews/finalized-review-handoff-service";
import { PARTNER_REVIEWS_COLLECTIONS, partnerReviewVersionsCollection } from "@/server/partner-reviews/firestore";
import { createPartnerReviewRevision, finalizePartnerReview, submitPartnerReviewForReview } from "@/server/partner-reviews/partner-review-lifecycle-service";
import { generatePartnerReviewDraft, getPartnerReview, inspectPartnerReviewFreshness, refreshPartnerReviewEvidence } from "@/server/partner-reviews/partner-review-service";
import { derivePeriod } from "@/server/partner-reviews/period";
import { computeReviewListSummary } from "@/server/partner-reviews/review-list-summary";
import { endAgreement, resumeAgreement, suspendAgreement } from "@/server/finance-agreements";
import { createPolicyHarness, FIXED_AMOUNT_MINOR, INCENTIVE_AMOUNT_MINOR, SUPPORTED_UNIT, DEFAULT_PERIOD as PERIOD } from "@/server/finance-agreements/testing/policy-harness";

import { AGREEMENT_COMMERCIAL_POLICY_PROVIDER_ID, registerServerProviders } from "./register-providers";

vi.setConfig({ testTimeout: 120_000 });

const h = createPolicyHarness("reg");
const { decisionsWith, policyTerms } = h;

beforeAll(async () => {
  await h.setup();
  registerServerProviders(); // the production composition path (what src/instrumentation.ts runs at server start)
}, 90_000);

afterAll(async () => {
  resetRegisteredCommercialPolicyProviderForTests(); // restore the null default for whatever runs next in this worker
  await h.teardown();
});

// ---- helpers -----------------------------------------------------------------------------------------------------------
type Stored = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const storedVersion = async (reviewRef: string, version = 1): Promise<Stored> => (await partnerReviewVersionsCollection(reviewRef).doc(String(version)).get()).data() as Stored;

async function generate(partnerRef: string, periodKey = PERIOD) {
  const manager = await h.actorFor("partnership_manager");
  const generated = await generatePartnerReviewDraft(manager, { partnerRef, periodKey }, h.requestId());
  if (!generated.ok) throw new Error(`generate: ${generated.code} ${generated.message}`);
  const reviewRef = generated.data.review.head.reviewRef;
  h.trackReview(reviewRef);
  return { reviewRef, detail: generated.data.review };
}

async function freshness(reviewRef: string) {
  const manager = await h.actorFor("partnership_manager");
  const result = await inspectPartnerReviewFreshness(manager, reviewRef);
  if (!result.ok) throw new Error(`freshness: ${result.code} ${result.message}`);
  return result.data.freshness.state;
}

async function refresh(reviewRef: string) {
  const manager = await h.actorFor("partnership_manager");
  const before = await getPartnerReview(manager, reviewRef);
  if (!before.ok) throw new Error(`read: ${before.message}`);
  const refreshed = await refreshPartnerReviewEvidence(manager, reviewRef, { expectedDocVersion: before.data.selectedVersion!.docVersion }, h.requestId());
  if (!refreshed.ok) throw new Error(`refresh: ${refreshed.code} ${refreshed.message}`);
  return refreshed.data;
}

async function submitAndFinalize(reviewRef: string) {
  const manager = await h.actorFor("partnership_manager");
  const head = await h.actorFor("partnership_head");
  const current = await getPartnerReview(manager, reviewRef);
  if (!current.ok) throw new Error(`read: ${current.message}`);
  const submitted = await submitPartnerReviewForReview(manager, reviewRef, { expectedDocVersion: current.data.selectedVersion!.docVersion }, h.requestId());
  if (!submitted.ok) throw new Error(`submit: ${submitted.message}`);
  const finalized = await finalizePartnerReview(head, reviewRef, { expectedDocVersion: submitted.data.selectedVersion!.docVersion }, h.requestId());
  if (!finalized.ok) throw new Error(`finalize: ${finalized.message}`);
  return finalized.data;
}

async function currentFingerprint(partnerRef: string, periodKey = PERIOD): Promise<string> {
  return (await collectPartnerEvidence(partnerRef, derivePeriod(periodKey)!)).sourceFingerprint;
}

// The states in which a review is NOT stale (the fixture has no Analytics, so "evidence_incomplete" is its own honest steady state).
const NOT_STALE = ["current", "evidence_incomplete"];

// =====================================================================================================================
describe("the registration itself", () => {
  it("the provider in the slot is the composition module's Agreement provider (no test override is used anywhere in this file)", () => {
    expect(getRegisteredCommercialPolicyProviderId()).toBe(AGREEMENT_COMMERCIAL_POLICY_PROVIDER_ID);
    const source = readFileSync(path.join(import.meta.dirname, "commercial-policy-registration.emulator.test.ts"), "utf8");
    const forbidden = ["setCommercialPolicy", "ProviderForTests"].join("");
    expect(source.split("\n").filter((line) => line.includes(forbidden) && !line.includes("forbidden")).filter((line) => !/^\s*(\/\/|\*)/.test(line) && !line.includes('["'))).toEqual([]);
  });

  it("a Partner with no Agreement keeps the all-unavailable shape through the registered provider (production behavior unchanged for them)", async () => {
    const partner = await h.seedPartner();
    await h.seedEvidence(partner);
    const { reviewRef } = await generate(partner.partnerRef);
    const commercial = (await storedVersion(reviewRef)).snapshot.commercial;
    expect(commercial.governingAgreement).toBeNull();
    expect(commercial.monthlyDeliverable).toMatchObject({ requiredCount: null, evaluation: "unavailable", unavailableReason: "no_agreement_requirement" });
    expect(commercial.lfcSfc).toMatchObject({ status: "unavailable", unavailableReason: "no_agreement_rule" });
    expect(commercial.targets).toEqual([]);
    expect("policyConflict" in commercial).toBe(false);
  });
});

// =====================================================================================================================
describe("commercial evidence under the registered Agreement provider", () => {
  it("required count + supported unit -> evaluated against approved Content; explicit LFC/SFC rule -> classified; targets stay warning-only and unavailable data is Unavailable, never Not met", async () => {
    const partner = await h.seedPartner();
    await h.seedEvidence(partner); // one approved reel thread, no Analytics at all
    const agreement = await h.activeAgreement(
      partner,
      decisionsWith(
        policyTerms({
          lfcSfc: h.seed("lfcSfc", { byFormat: { reel: "LFC" } }),
          performanceTargets: h.seed("performanceTargets", [
            { targetRef: "t-views", metricId: "views", targetValue: 5000, unit: "views", comparison: "at_least", affectsPayment: false },
            { targetRef: "t-reach", metricId: "reach", targetValue: 9000, unit: "reach", comparison: "at_least", affectsPayment: false },
            { targetRef: "t-growth", metricId: "followerGrowth", targetValue: 1000, unit: "followers", comparison: "at_least", affectsPayment: false },
          ]),
        }),
      ),
    );
    const ref = agreement.head.agreementRef;

    const { reviewRef, detail } = await generate(partner.partnerRef);
    const commercial = (await storedVersion(reviewRef)).snapshot.commercial;
    expect(commercial.governingAgreement).toEqual({ agreementRef: ref, agreementVersion: 1 });
    expect(commercial.monthlyDeliverable).toMatchObject({ requiredCount: 2, qualifyingUnit: SUPPORTED_UNIT, actualQualifyingCount: 1, variance: -1, evaluation: "below_requirement", unavailableReason: null, requirementSource: { agreementRef: ref, agreementVersion: 1, requirementSourceRef: `${ref}@1` } });
    expect(commercial.lfcSfc).toMatchObject({ status: "evaluated", ruleRef: `${ref}@1:lfc-sfc`, lfcCount: 1, sfcCount: 0 });

    // every target: warning-only, and with no verified Analytics it is Unavailable (never "not_met")
    expect(commercial.targets).toHaveLength(3);
    for (const target of commercial.targets as Array<{ affectsPayment: boolean; evaluation: string; actualValue: unknown; unavailableReason: string | null }>) {
      expect(target.affectsPayment).toBe(false);
      expect(target.evaluation).toBe("unavailable");
      expect(target.evaluation).not.toBe("not_met");
      expect(target.actualValue).toBeNull();
    }
    const byId = Object.fromEntries((commercial.targets as Array<{ metricId: string; unavailableReason: string }>).map((target) => [target.metricId, target.unavailableReason]));
    expect(byId).toEqual({ views: "no_verified_values", reach: "unsupported_metric", followerGrowth: "insufficient_follower_snapshots" });

    // the actor-facing DTO says the same
    expect(detail.selectedVersion!.snapshot.commercial.targets.every((target) => target.evaluation === "unavailable" && target.affectsPayment === false)).toBe(true);
  });

  it("an unsupported qualifying unit -> the requirement is Unavailable (not guessed, not Not met); no explicit rule -> LFC/SFC Unavailable", async () => {
    const partner = await h.seedPartner();
    await h.seedEvidence(partner);
    const agreement = await h.activeAgreement(partner, decisionsWith(policyTerms({ qualifyingUnit: h.seed("qualifyingUnit", "reel"), lfcSfc: h.decide("lfcSfc", "UNAVAILABLE"), performanceTargets: h.decide("performanceTargets", "NOT_APPLICABLE") })));
    const { reviewRef } = await generate(partner.partnerRef);
    const commercial = (await storedVersion(reviewRef)).snapshot.commercial;
    expect(commercial.governingAgreement).toEqual({ agreementRef: agreement.head.agreementRef, agreementVersion: 1 });
    expect(commercial.monthlyDeliverable).toMatchObject({ requiredCount: null, evaluation: "unavailable", unavailableReason: "no_agreement_requirement", affectsPayment: false });
    expect(commercial.monthlyDeliverable.evaluation).not.toBe("below_requirement");
    expect(commercial.lfcSfc).toMatchObject({ status: "unavailable", unavailableReason: "no_agreement_rule", lfcCount: null, sfcCount: null });
    expect(commercial.targets).toEqual([]);
  });

  it("qualifying content counts only APPROVED Content: a thread still under review leaves the count at zero (below requirement), never inflated", async () => {
    const partner = await h.seedPartner();
    await h.seedEvidence(partner, { threadStatus: "UNDER_REVIEW" });
    await h.activeAgreement(partner, decisionsWith(policyTerms()));
    const { reviewRef } = await generate(partner.partnerRef);
    expect((await storedVersion(reviewRef)).snapshot.commercial.monthlyDeliverable).toMatchObject({ requiredCount: 2, actualQualifyingCount: 0, variance: -2, evaluation: "below_requirement" });
  });
});

// =====================================================================================================================
describe("policy identity in the fingerprint, staleness and immutability", () => {
  it("activating an applicable v2 makes a DRAFT review refresh_available; refresh picks v2 up; the fingerprint carries the policy identity", async () => {
    const partner = await h.seedPartner();
    await h.seedEvidence(partner);
    const v1 = await h.activeAgreement(partner, decisionsWith(policyTerms()));
    const ref = v1.head.agreementRef;
    const { reviewRef } = await generate(partner.partnerRef);
    const fingerprint1 = (await storedVersion(reviewRef)).sourceFingerprint;
    expect(NOT_STALE).toContain(await freshness(reviewRef));

    await h.reviseAndActivate(v1, [h.seed("monthlyRequiredQualifyingContentCount", 3)]);
    expect(await freshness(reviewRef)).toBe("refresh_available");
    expect(await currentFingerprint(partner.partnerRef)).not.toBe(fingerprint1);

    const refreshed = await refresh(reviewRef);
    const stored = await storedVersion(reviewRef);
    expect(stored.snapshot.commercial.governingAgreement).toEqual({ agreementRef: ref, agreementVersion: 2 });
    expect(stored.snapshot.commercial.monthlyDeliverable).toMatchObject({ requiredCount: 3, variance: -2, requirementSource: { agreementRef: ref, agreementVersion: 2 } });
    expect(stored.sourceFingerprint).not.toBe(fingerprint1);
    expect(refreshed.selectedVersion!.snapshot.commercial.governingAgreement).toEqual({ agreementRef: ref, agreementVersion: 2 });
    expect(NOT_STALE).toContain(await freshness(reviewRef));
  });

  it("an old FINALIZED review stays immutable with v1 evidence: v2 makes it revision_available, a revision picks v2 up, version 1 is byte-identical and its handoff still says v1", async () => {
    const manager = await h.actorFor("partnership_manager");
    const admin = await h.actorFor("super_admin");
    const partner = await h.seedPartner();
    await h.seedEvidence(partner);
    const v1 = await h.activeAgreement(partner, decisionsWith(policyTerms()));
    const ref = v1.head.agreementRef;
    const { reviewRef } = await generate(partner.partnerRef);
    const finalized = await submitAndFinalize(reviewRef);
    const before = await storedVersion(reviewRef);
    expect(before.status).toBe("FINALIZED");
    expect(before.snapshot.commercial.governingAgreement).toEqual({ agreementRef: ref, agreementVersion: 1 });
    expect(NOT_STALE).toContain(await freshness(reviewRef));

    await h.reviseAndActivate(v1, [h.seed("monthlyRequiredQualifyingContentCount", 4)]);
    expect(await freshness(reviewRef)).toBe("revision_available");
    expect(await storedVersion(reviewRef)).toEqual(before); // the finalized version did not move at all

    const revision = await createPartnerReviewRevision(manager, reviewRef, { expectedDocVersion: finalized.head.docVersion }, h.requestId());
    if (!revision.ok) throw new Error(`revision: ${revision.code} ${revision.message}`);
    const version2 = await storedVersion(reviewRef, 2);
    expect(version2.snapshot.commercial.governingAgreement).toEqual({ agreementRef: ref, agreementVersion: 2 });
    expect(version2.snapshot.commercial.monthlyDeliverable).toMatchObject({ requiredCount: 4 });
    expect(version2.sourceFingerprint).not.toBe(before.sourceFingerprint);
    expect(await storedVersion(reviewRef, 1)).toEqual(before);

    const oldHandoff = await getFinalizedReviewHandoff(admin, reviewRef, 1);
    if (!oldHandoff.ok) throw new Error(oldHandoff.message);
    expect(oldHandoff.data.governingAgreement).toEqual({ agreementRef: ref, agreementVersion: 1 });
    expect(oldHandoff.data.paymentAffectingEvidence.monthlyDeliverable).toMatchObject({ requiredCount: 2, requirementSource: { agreementVersion: 1 } });
  });

  it("UNRELATED Agreement changes leave the fingerprint (and freshness) untouched: another Partner's / a Vendor's Agreement, an UNACTIVATED revision with other remarks / fixed amount, suspend + resume, an end after the month", async () => {
    const head = await h.actorFor("partnership_head");
    const partner = await h.seedPartner();
    await h.seedEvidence(partner);
    const v1 = await h.activeAgreement(partner, decisionsWith(policyTerms()));
    const { reviewRef } = await generate(partner.partnerRef);
    const baseline = (await storedVersion(reviewRef)).sourceFingerprint;
    const assertUnchanged = async (label: string) => {
      expect(await currentFingerprint(partner.partnerRef), label).toBe(baseline);
      expect(NOT_STALE, label).toContain(await freshness(reviewRef));
    };
    await assertUnchanged("baseline");

    // (a) another Partner's Agreement
    const other = await h.seedPartner();
    await h.activeAgreement(other, decisionsWith(policyTerms({ monthlyRequiredQualifyingContentCount: h.seed("monthlyRequiredQualifyingContentCount", 9) })));
    await assertUnchanged("another Partner's Agreement");

    // (b) a Vendor Agreement
    const vendor = await h.seedVendor();
    const vendorDraft = await h.createDraft({ type: "VENDOR", vendorRef: vendor.vendorRef });
    const manager = await h.actorFor("partnership_manager");
    await h.activate(head, await h.confirm(manager, await h.acceptPending(manager, await h.decideAll(manager, vendorDraft, decisionsWith(policyTerms())))));
    await assertUnchanged("a Vendor Agreement");

    // (c) a revision that is confirmed but NOT activated - with other remarks and another fixed amount (money + notes never reach a review)
    const detail = await h.reviseAndConfirm(v1, [h.seed("remarks", "Internal note that must not matter"), h.seed("fixedComponent", { applicable: true, amountMinor: 1_111_111 }), h.seed("monthlyRequiredQualifyingContentCount", 7)]);
    expect(detail.head.status).toBe("ACTIVE"); // v1 is still the governing version
    await assertUnchanged("an unactivated revision");

    // (d) suspend + resume the governing version (an operational hold, not a change of terms)
    const afterRevision = detail.head;
    const suspended = h.must(await suspendAgreement(head, { agreementRef: afterRevision.agreementRef, expectedDocVersion: afterRevision.docVersion, reason: "Hold" }, h.requestId()), "suspend");
    await assertUnchanged("suspended");
    const resumed = h.must(await resumeAgreement(head, { agreementRef: afterRevision.agreementRef, expectedDocVersion: suspended.head.docVersion }, h.requestId()), "resume");
    await assertUnchanged("resumed");

    // (e) the Agreement is ENDED after the month (it ended long after 2019): it still governs March 2019 exactly as before
    h.must(await endAgreement(head, { agreementRef: afterRevision.agreementRef, expectedDocVersion: resumed.head.docVersion, reason: "Closed after the month" }, h.requestId()), "end");
    await assertUnchanged("ended after the month");
  });

  it("DOCUMENTED CONSERVATIVE BEHAVIOR: a newly ACTIVATED version changes the policy identity, so it refreshes the review even when only remarks / the fixed amount changed", async () => {
    const partner = await h.seedPartner();
    await h.seedEvidence(partner);
    const v1 = await h.activeAgreement(partner, decisionsWith(policyTerms()));
    const { reviewRef } = await generate(partner.partnerRef);
    await h.reviseAndActivate(v1, [h.seed("remarks", "Only a note changed"), h.seed("fixedComponent", { applicable: true, amountMinor: 2_222_222 })]);
    expect(await freshness(reviewRef)).toBe("refresh_available"); // identity {agreementRef, agreementVersion} changed; the evaluated evidence itself is identical
    await refresh(reviewRef);
    const commercial = (await storedVersion(reviewRef)).snapshot.commercial;
    expect(commercial.governingAgreement.agreementVersion).toBe(2);
    expect(commercial.monthlyDeliverable).toMatchObject({ requiredCount: 2, evaluation: "below_requirement" }); // same requirement, nothing else moved
  });
});

// =====================================================================================================================
describe("overlapping Agreements: the review neither crashes nor picks", () => {
  it("generates fine with the commercial evidence unavailable + the conflict marker; the actor sees the exact reason and a count, never a ref; nothing is merged", async () => {
    const partner = await h.seedPartner();
    await h.seedEvidence(partner);
    const a = await h.activeAgreement(partner, decisionsWith(policyTerms()));
    const b = await h.activeAgreement(partner, decisionsWith(policyTerms({ monthlyRequiredQualifyingContentCount: h.seed("monthlyRequiredQualifyingContentCount", 6) })));
    const refs = [a.head.agreementRef, b.head.agreementRef].sort();

    const io = h.instrumentWrites();
    let detail;
    let reviewRef = "";
    try {
      ({ reviewRef, detail } = await generate(partner.partnerRef)); // must not throw
    } finally {
      io.stop();
    }
    const stored = await storedVersion(reviewRef);
    const commercial = stored.snapshot.commercial;
    expect(commercial.governingAgreement).toBeNull();
    expect(commercial.policyConflict).toEqual({ reason: "multiple_applicable_agreements", agreementRefs: refs });
    expect(commercial.monthlyDeliverable).toMatchObject({ requiredCount: null, actualQualifyingCount: null, evaluation: "unavailable", unavailableReason: "multiple_applicable_agreements", affectsPayment: false });
    expect(commercial.lfcSfc).toMatchObject({ status: "unavailable", unavailableReason: "multiple_applicable_agreements" });
    expect(commercial.targets).toEqual([]);

    // the actor-facing DTO: exact reason + a count, no Agreement ref anywhere
    const dtoCommercial = detail.selectedVersion!.snapshot.commercial;
    expect(dtoCommercial.policyConflict).toEqual({ reason: "multiple_applicable_agreements", conflictCount: 2 });
    expect(dtoCommercial.governingAgreement).toBeNull();
    const dtoJson = JSON.stringify(detail);
    for (const ref of refs) expect(dtoJson).not.toContain(ref);

    // the review wrote Partner Review documents only (no Agreement was merged, ended or touched)
    expect(io.paths.length).toBeGreaterThan(0);
    expect(io.paths.filter((p) => /^(financeAgreement|financeContract)/.test(p))).toEqual([]);
    for (const p of io.paths) expect(p.startsWith(`${PARTNER_REVIEWS_COLLECTIONS.partnerReviews}/`)).toBe(true);

    // no false staleness while the conflict stands
    expect(NOT_STALE).toContain(await freshness(reviewRef));
  });

  it("the fingerprint flips when the overlap is resolved (one Agreement corrected) and the refreshed review is governed by the survivor; a conflict review can be finalized and its handoff says so without refs", async () => {
    const admin = await h.actorFor("super_admin");
    const partner = await h.seedPartner();
    await h.seedEvidence(partner);
    const a = await h.activeAgreement(partner, decisionsWith(policyTerms()));
    const b = await h.activeAgreement(partner, decisionsWith(policyTerms()));
    const { reviewRef } = await generate(partner.partnerRef);
    const conflicted = await storedVersion(reviewRef);
    expect(conflicted.snapshot.commercial.policyConflict).toBeDefined();
    const conflictFingerprint = conflicted.sourceFingerprint;

    // a second, independent draft-time proof: same inputs, same conflict, same fingerprint
    expect(await currentFingerprint(partner.partnerRef)).toBe(conflictFingerprint);

    // Resolve: B is corrected to end in February (a revision, activated by the Head). Only A now covers March.
    await h.reviseAndActivate(b, [h.seed("terminationDate", "2019-02-28")]);
    expect(await freshness(reviewRef)).toBe("refresh_available");
    expect(await currentFingerprint(partner.partnerRef)).not.toBe(conflictFingerprint);

    await refresh(reviewRef);
    const resolved = await storedVersion(reviewRef);
    expect(resolved.snapshot.commercial.policyConflict).toBeUndefined();
    expect(resolved.snapshot.commercial.governingAgreement).toEqual({ agreementRef: a.head.agreementRef, agreementVersion: 1 });
    expect(resolved.snapshot.commercial.monthlyDeliverable).toMatchObject({ requiredCount: 2, evaluation: "below_requirement" });
    expect(resolved.sourceFingerprint).not.toBe(conflictFingerprint);

    // a review generated while the conflict stands can be finalized; its handoff carries the additive marker and no refs
    const other = await h.seedPartner();
    await h.seedEvidence(other);
    const x = await h.activeAgreement(other, decisionsWith(policyTerms()));
    const y = await h.activeAgreement(other, decisionsWith(policyTerms()));
    const generated = await generate(other.partnerRef);
    await submitAndFinalize(generated.reviewRef);
    const handoff = await getFinalizedReviewHandoff(admin, generated.reviewRef);
    if (!handoff.ok) throw new Error(handoff.message);
    expect(handoff.data.policyConflict).toEqual({ reason: "multiple_applicable_agreements", conflictCount: 2 });
    expect(handoff.data.governingAgreement).toBeNull();
    expect(handoff.data.paymentAffectingEvidence).toEqual({ monthlyDeliverable: null, lfcSfc: null });
    expect(handoff.data.contractVersion).toBe(1);
    for (const ref of [x.head.agreementRef, y.head.agreementRef]) expect(JSON.stringify(handoff.data)).not.toContain(ref);
  });
});

// =====================================================================================================================
describe("no money reaches Partner Reviews", () => {
  // Every key of every Partner Review DTO / snapshot / handoff must be free of money vocabulary (only the two accepted markers are allowed).
  const MONEY_KEY = /amountMinor|fixedComponent|currency|payable|invoice|incentive|slab|advance|accountTransfer|paymentCycle|paymentDue|^payment|Payment(?!Affect)/i;
  // ("versionCurrency" is the handoff's up-to-dateness marker for a review version - "currency" in the sense of "current" - not money.)
  const ALLOWED_KEYS = new Set(["affectsPayment", "paymentAffectingEvidence", "versionCurrency"]);

  function walk(value: unknown, keys: string[] = [], strings: string[] = []) {
    if (Array.isArray(value)) for (const item of value) walk(item, keys, strings);
    else if (value !== null && typeof value === "object") {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        keys.push(key);
        walk(child, keys, strings);
      }
    } else if (typeof value === "string") strings.push(value);
    else if (typeof value === "number") strings.push(String(value));
    return { keys, strings };
  }

  it("a fully governed, finalized review: no money-shaped key and none of the Agreement's money values anywhere in the DTO, stored snapshot, list summary or handoff; only Partner Review documents are written", async () => {
    const manager = await h.actorFor("partnership_manager");
    const admin = await h.actorFor("super_admin");
    const partner = await h.seedPartner();
    await h.seedEvidence(partner);
    await h.activeAgreement(partner, decisionsWith(policyTerms({ lfcSfc: h.seed("lfcSfc", { byFormat: { reel: "SFC" } }) })));

    const io = h.instrumentWrites();
    let reviewRef = "";
    let detailDto: unknown;
    let handoffDto: unknown;
    try {
      const generated = await generate(partner.partnerRef);
      reviewRef = generated.reviewRef;
      await refresh(reviewRef);
      await submitAndFinalize(reviewRef);
      const detail = await getPartnerReview(manager, reviewRef);
      if (!detail.ok) throw new Error(detail.message);
      detailDto = detail.data;
      const handoff = await getFinalizedReviewHandoff(admin, reviewRef);
      if (!handoff.ok) throw new Error(handoff.message);
      handoffDto = handoff.data;
    } finally {
      io.stop();
    }

    const stored = await storedVersion(reviewRef);
    const listSummary = computeReviewListSummary(stored.snapshot);
    const surfaces: Record<string, unknown> = { detailDto, handoffDto, storedSnapshot: stored.snapshot, storedSourceRefs: stored.sourceRefs, listSummary };
    for (const [name, surface] of Object.entries(surfaces)) {
      const { keys, strings } = walk(surface);
      expect(keys.length, name).toBeGreaterThan(5);
      expect(keys.filter((key) => MONEY_KEY.test(key) && !ALLOWED_KEYS.has(key)), `${name}: money-shaped key`).toEqual([]);
      const text = JSON.stringify(surface);
      for (const token of [String(FIXED_AMOUNT_MINOR), String(INCENTIVE_AMOUNT_MINOR), "INR", "MONTHLY", "Payment within 30 days", "Invoice by the 5th"]) {
        expect(text.includes(token), `${name} leaks ${token}`).toBe(false);
      }
      expect(strings.some((s) => /payable|invoice/i.test(s)), name).toBe(false);
    }

    // generate / refresh / submit / finalize / read / handoff wrote Partner Review documents ONLY
    expect(io.paths.length).toBeGreaterThan(5);
    expect(io.paths.filter((p) => /^(financeAgreement|financeContract)/.test(p))).toEqual([]);
    for (const p of io.paths) expect(p.startsWith(`${PARTNER_REVIEWS_COLLECTIONS.partnerReviews}/`)).toBe(true);
  });
});
