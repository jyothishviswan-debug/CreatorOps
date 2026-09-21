import { describe, expect, it } from "vitest";

import { buildCommercialEvidence } from "./commercial-builder";
import { commercialOrNeutral, neutralCommercialEvidence } from "./commercial-neutral";
import type { GoverningCommercialPolicy } from "./commercial-policy";
import { buildEvidence, type BuildEvidenceInput } from "./evidence-builder";
import { buildFinalizedReviewHandoff } from "./finalized-review-handoff";
import { derivePeriod, reviewRefFor } from "./period";
import { computeReviewListSummary } from "./review-list-summary";
import { NO_SOURCE_ACCESS, redactVersionForActor } from "./source-context-redaction";
import { commercialEvidenceSchema, evidenceSnapshotSchema, partnerReviewHeadDocSchema, partnerReviewVersionDocSchema } from "./types";

// Step 14C: an OVERLAP conflict in the evidence builder, the fingerprint, the actor redaction, the handoff and the list projection.
// Pure - no Firestore. Nothing is picked, merged or thrown; the commercial evidence is unavailable with a typed reason.

const period = derivePeriod("2026-03")!;
const CONFLICT = { reason: "multiple_applicable_agreements" as const, agreementRefs: ["agr-a", "agr-b"] };
const POLICY: GoverningCommercialPolicy = { agreementRef: "agr-a", agreementVersion: 2, monthlyDeliverableRequirement: { requiredCount: 3, qualifyingUnit: "approved_content_thread" } };

function input(over: Partial<BuildEvidenceInput> = {}): BuildEvidenceInput {
  return {
    partnerRef: "partner-1",
    period,
    evidenceCutoff: "2026-05-01T00:00:00.000Z",
    assignments: [],
    assignmentScanTruncated: false,
    assignmentsScanned: 0,
    threads: [],
    analyticsRecords: [],
    analyticsScanTruncated: false,
    analyticsRecordsScanned: 0,
    ...over,
  };
}
const build = (over: Partial<BuildEvidenceInput> = {}) => buildEvidence(input(over));

describe("the conflict commercial section", () => {
  it("every section is unavailable with the typed conflict reason, governingAgreement is null and the marker names the sorted refs", () => {
    const { commercial, channelSourceRefs } = buildCommercialEvidence({
      partnerRef: "partner-1",
      period,
      policy: null,
      policyConflict: { reason: "multiple_applicable_agreements", agreementRefs: ["agr-b", "agr-a"] },
      production: [],
      records: [],
      assignmentsTruncated: false,
      analyticsTruncated: false,
      channelRecords: [],
      channelScanTruncated: false,
    });
    expect(channelSourceRefs).toEqual([]);
    expect(commercial.governingAgreement).toBeNull();
    expect(commercial.monthlyDeliverable).toMatchObject({ requiredCount: null, requirementSource: null, actualQualifyingCount: null, variance: null, evaluation: "unavailable", unavailableReason: "multiple_applicable_agreements", affectsPayment: false });
    expect(commercial.lfcSfc).toMatchObject({ status: "unavailable", unavailableReason: "multiple_applicable_agreements", lfcCount: null, sfcCount: null, unclassifiedCount: null, affectsPayment: false });
    expect(commercial.targets).toEqual([]);
    expect(commercial.policyConflict).toEqual({ reason: "multiple_applicable_agreements", agreementRefs: ["agr-a", "agr-b"] });
    expect(() => commercialEvidenceSchema.parse(commercial)).not.toThrow();
  });

  it("buildEvidence carries the marker into the strict snapshot; a policy wins over a stray conflict input (mutually exclusive)", () => {
    const conflicted = build({ commercialPolicyConflict: CONFLICT });
    expect(() => evidenceSnapshotSchema.parse(conflicted.snapshot)).not.toThrow();
    expect(conflicted.snapshot.commercial!.policyConflict).toEqual(CONFLICT);
    const both = build({ commercialPolicy: POLICY, commercialPolicyConflict: CONFLICT });
    expect(both.snapshot.commercial!.policyConflict).toBeUndefined();
    expect(both.snapshot.commercial!.governingAgreement).toEqual({ agreementRef: "agr-a", agreementVersion: 2 });
  });

  it("a snapshot with NO conflict has no marker key at all (old and conflict-free versions are byte-stable) and still parses", () => {
    const plain = build();
    expect("policyConflict" in plain.snapshot.commercial!).toBe(false);
    expect(JSON.stringify(plain.snapshot.commercial)).not.toContain("policyConflict");
    // an OLD stored snapshot (no commercial key) still parses and reads as neutral
    const { commercial: _omitted, ...old } = plain.snapshot;
    void _omitted;
    const parsedOld = evidenceSnapshotSchema.parse(old);
    expect(commercialOrNeutral(parsedOld)).toEqual(neutralCommercialEvidence());
  });
});

describe("fingerprint: the conflict participates ONLY when present", () => {
  it("no conflict / a null conflict hash byte-identically to the pre-14C input", () => {
    const base = build().sourceFingerprint;
    expect(build({ commercialPolicyConflict: null }).sourceFingerprint).toBe(base);
    expect(build({ commercialPolicy: null, commercialPolicyConflict: null }).sourceFingerprint).toBe(base);
  });

  it("a conflict changes the fingerprint; the same refs in any order hash the same; different refs differ", () => {
    const base = build().sourceFingerprint;
    const ab = build({ commercialPolicyConflict: { reason: "multiple_applicable_agreements", agreementRefs: ["agr-a", "agr-b"] } }).sourceFingerprint;
    const ba = build({ commercialPolicyConflict: { reason: "multiple_applicable_agreements", agreementRefs: ["agr-b", "agr-a"] } }).sourceFingerprint;
    const ac = build({ commercialPolicyConflict: { reason: "multiple_applicable_agreements", agreementRefs: ["agr-a", "agr-c"] } }).sourceFingerprint;
    expect(ab).not.toBe(base);
    expect(ab).toBe(ba);
    expect(ac).not.toBe(ab);
  });

  it("resolving the conflict flips the fingerprint whether it resolves to one policy or to nothing", () => {
    const conflicted = build({ commercialPolicyConflict: CONFLICT }).sourceFingerprint;
    expect(build({ commercialPolicy: POLICY }).sourceFingerprint).not.toBe(conflicted);
    expect(build().sourceFingerprint).not.toBe(conflicted);
  });
});

describe("what an actor and a downstream consumer see", () => {
  const finalizedDocs = (built: ReturnType<typeof build>) => {
    const head = partnerReviewHeadDocSchema.parse({
      reviewRef: reviewRefFor("partner-1", "2026-03"),
      partnerRef: "partner-1",
      partnerUid: "partner-uid-1",
      periodKey: "2026-03",
      periodStart: period.periodStart,
      periodEnd: period.periodEnd,
      latestVersion: 1,
      latestStatus: "FINALIZED",
      currentFinalizedVersion: 1,
      openVersion: null,
      docVersion: 4,
      ownerUid: "owner-uid-1",
      regionIds: ["Kerala"],
      teamIds: ["team-1"],
      createdAt: "2026-05-01T00:00:00.000Z",
      createdByUserRef: "user-ref-1",
      updatedAt: "2026-05-01T00:00:00.000Z",
      updatedByUserRef: "user-ref-1",
    });
    const version = partnerReviewVersionDocSchema.parse({
      reviewRef: head.reviewRef,
      version: 1,
      status: "FINALIZED",
      docVersion: 3,
      snapshot: built.snapshot,
      evidenceCutoff: built.snapshot.evidenceCutoff,
      sourceFingerprint: built.sourceFingerprint,
      sourceRefs: built.sourceRefs,
      generatedAt: "2026-05-01T00:00:00.000Z",
      generatedByUserRef: "user-ref-1",
      finalizedAt: "2026-05-02T00:00:00.000Z",
      finalizedByUserRef: "user-ref-2",
      supersededAt: null,
      supersededByVersion: null,
      createdAt: "2026-05-01T00:00:00.000Z",
      createdByUserRef: "user-ref-1",
    });
    return { head, version };
  };

  it("the actor view carries the reason and a COUNT only - never an Agreement ref", () => {
    const { version } = finalizedDocs(build({ commercialPolicyConflict: { reason: "multiple_applicable_agreements", agreementRefs: ["agr-secret-1", "agr-secret-2", "agr-secret-3"] } }));
    const view = redactVersionForActor(version, NO_SOURCE_ACCESS);
    expect(view.snapshot.commercial.policyConflict).toEqual({ reason: "multiple_applicable_agreements", conflictCount: 3 });
    expect(view.snapshot.commercial.governingAgreement).toBeNull();
    const json = JSON.stringify(view);
    expect(json).not.toContain("agr-secret");
    expect(json).not.toContain("agreementRefs");
  });

  it("a conflict-free actor view has no policyConflict key (unchanged shape)", () => {
    const { version } = finalizedDocs(build());
    expect("policyConflict" in redactVersionForActor(version, NO_SOURCE_ACCESS).snapshot.commercial).toBe(false);
  });

  it("the handoff gains an ADDITIVE policyConflict {reason, conflictCount} only when a conflict exists, with empty payment-affecting evidence and no refs", () => {
    const conflicted = finalizedDocs(build({ commercialPolicyConflict: { reason: "multiple_applicable_agreements", agreementRefs: ["agr-secret-1", "agr-secret-2"] } }));
    const dto = buildFinalizedReviewHandoff({ ...conflicted, partnerDisplayName: "Partner One" });
    expect(dto.policyConflict).toEqual({ reason: "multiple_applicable_agreements", conflictCount: 2 });
    expect(dto.governingAgreement).toBeNull();
    expect(dto.paymentAffectingEvidence).toEqual({ monthlyDeliverable: null, lfcSfc: null });
    expect(dto.warningOnlyTargets).toEqual([]);
    expect(dto.contractVersion).toBe(1);
    expect(JSON.stringify(dto)).not.toContain("agr-secret");

    const clean = buildFinalizedReviewHandoff({ ...finalizedDocs(build()), partnerDisplayName: "Partner One" });
    expect("policyConflict" in clean).toBe(false);
  });

  it("the list projection of a conflicted snapshot reads as no governing Agreement with an unavailable requirement (never 'not met')", () => {
    const summary = computeReviewListSummary(build({ commercialPolicyConflict: CONFLICT }).snapshot);
    expect(summary.commercial.governing).toBeNull();
    expect(summary.commercial.deliverable).toMatchObject({ required: null, actual: null, variance: null, evaluation: "unavailable", affectsPayment: false });
    expect(summary.commercial.lfcSfc).toMatchObject({ status: "unavailable" });
    expect(summary.commercial.targets).toMatchObject({ total: 0, notMet: 0 });
  });
});
