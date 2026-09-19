import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import type { z } from "zod";

import type { PartnerReviewVersionDto } from "./client-dto";
import { buildCommercialEvidence, classifyFormats, isSupportedQualifyingUnit, selectFollowerSnapshotCandidates, type ChannelSnapshotRecordSource } from "./commercial-builder";
import { commercialOrNeutral, neutralCommercialEvidence } from "./commercial-neutral";
import {
  CommercialPolicyContractError,
  getGoverningCommercialPolicy,
  governingCommercialPolicySchema,
  policyFingerprintFacts,
  setCommercialPolicyProviderForTests,
  type GoverningCommercialPolicy,
} from "./commercial-policy";
import { buildEvidence, type AnalyticsRecordSource, type AssignmentSource, type BuildEvidenceInput, type ContentThreadSource } from "./evidence-builder";
import { buildFinalizedReviewHandoff, evaluateReviewVersionCurrency, FINALIZED_REVIEW_HANDOFF_CONTRACT_VERSION, type FinalizedReviewHandoffDto } from "./finalized-review-handoff";
import { derivePeriod, reviewRefFor } from "./period";
import { collectSnapshotSourceRefs, fullSourceAccessFor, NO_SOURCE_ACCESS, redactVersionForActor, type ActorCommercialEvidence, type ActorEvidenceSnapshot, type SourceAccess } from "./source-context-redaction";
import {
  commercialEvidenceSchema,
  evidenceSnapshotSchema,
  partnerReviewHeadDocSchema,
  partnerReviewVersionDocSchema,
  type CommercialEvidence,
  type EvidenceSnapshot,
  type PartnerReviewHeadDoc,
  type PartnerReviewVersionDoc,
} from "./types";

// Step 13A.1 (revised): the commercial evidence section, its fingerprint, its
// redaction and the finalized-review handoff - pure, no Firestore.

const period = derivePeriod("2026-03")!;
const CUTOFF = "2026-05-01T00:00:00.000Z";

// ---- Fixtures ----------------------------------------------------------------------------

function assignment(ref: string, over: { status?: AssignmentSource["status"]; formats?: string[]; dueAt?: string | null; requiredCount?: number | null } = {}): AssignmentSource {
  return {
    assignmentRef: ref,
    campaignRef: "camp-1",
    status: over.status ?? "IN_PROGRESS",
    version: 3,
    createdAt: "2026-01-10T08:00:00.000Z",
    updatedAt: "2026-02-01T08:00:00.000Z",
    brief: { campaignName: "Spring Launch", dueAt: over.dueAt === undefined ? "2026-03-10" : over.dueAt, requiredCount: over.requiredCount === undefined ? 2 : over.requiredCount, formats: over.formats ?? ["reel"], platforms: ["instagram"] },
  };
}

function thread(contentRef: string, assignmentRef: string, over: { status?: string; links?: number } = {}): ContentThreadSource {
  const links = over.links ?? 1;
  return {
    contentRef,
    assignmentRef,
    version: 4,
    status: (over.status ?? "APPROVED") as ContentThreadSource["status"],
    currentRevisionNumber: 1,
    currentLinks: Array.from({ length: links }, (_, i) => ({ platform: "instagram", originalUrl: `https://instagram.com/p/${contentRef}${i}`, normalizedUrl: `https://instagram.com/p/${contentRef}${i}`, recordedAt: "2026-03-08T10:00:00.000Z" })),
    openedAt: "2026-03-01T00:00:00.000Z",
    firstSubmittedAt: "2026-03-05T10:00:00.000Z",
    lastSubmittedAt: "2026-03-08T10:00:00.000Z",
    approvedAt: over.status === undefined || over.status === "APPROVED" ? "2026-03-09T10:00:00.000Z" : null,
    cancelledAt: null,
    updatedAt: "2026-03-09T10:00:00.000Z",
  };
}

function record(ref: string, over: Partial<AnalyticsRecordSource> = {}): AnalyticsRecordSource {
  return {
    sourceRef: ref,
    batchRef: "batch-1",
    sheetName: "Posts",
    sourceRowNumber: 2,
    platform: "instagram",
    normalizedUrl: `https://instagram.com/p/${ref}`,
    postDateTimeIso: "2026-03-09T10:00:00.000Z",
    comments: null,
    likes: null,
    views: null,
    profileFollowers: null,
    engagement: null,
    reportingPeriod: { start: "2026-03-01", end: "2026-03-31" },
    matchState: "MATCHED",
    matchEvidence: { tier: "published_url", value: `https://instagram.com/p/${ref}`, reasonCode: null, candidateCount: 1 },
    matchedContentRef: "ct-1",
    matchedAssignmentRef: "as-1",
    matchedCampaignRef: "camp-1",
    matchedPartnerRef: "partner-1",
    matchedPartnerAccountRef: null,
    correctionRevision: 1,
    createdAt: "2026-04-02T00:00:00.000Z",
    ...over,
  };
}

function channel(ref: string, over: Partial<ChannelSnapshotRecordSource> = {}): ChannelSnapshotRecordSource {
  return {
    sourceRef: ref,
    platform: "instagram",
    profileFollowers: 1000,
    reportingPeriod: { start: "2026-03-01", end: "2026-03-01" },
    matchState: "MATCHED",
    matchedPartnerRef: "partner-1",
    matchedPartnerAccountRef: "acct-1",
    correctionRevision: 1,
    createdAt: "2026-04-02T00:00:00.000Z",
    ...over,
  };
}

// Seven in-period Assignments covering every counting edge:
//   as-1 reel   APPROVED, 2 links          as-2 story  APPROVED, 1 link
//   as-3 video  UNDER_REVIEW, 3 links      as-4 reel   REVISION_REQUESTED, 4 links
//   as-5        OPEN, 0 links              as-6 CANCELLED assignment, APPROVED thread, 1 link
//   as-7        no thread at all
// => approved_content_thread = 2, approved_current_link = 3.
const ASSIGNMENTS: AssignmentSource[] = [
  assignment("as-1", { formats: ["Reel"] }),
  assignment("as-2", { formats: ["story"] }),
  assignment("as-3", { formats: ["video"] }),
  assignment("as-4", { formats: ["reel"] }),
  assignment("as-5", { formats: ["reel"] }),
  assignment("as-6", { status: "CANCELLED", formats: ["reel"] }),
  assignment("as-7", { formats: ["reel"] }),
];
const THREADS: ContentThreadSource[] = [
  thread("ct-1", "as-1", { links: 2 }),
  thread("ct-2", "as-2", { links: 1 }),
  thread("ct-3", "as-3", { status: "UNDER_REVIEW", links: 3 }),
  thread("ct-4", "as-4", { status: "REVISION_REQUESTED", links: 4 }),
  thread("ct-5", "as-5", { status: "OPEN", links: 0 }),
  thread("ct-6", "as-6", { status: "APPROVED", links: 1 }),
];

function policyOf(over: Partial<GoverningCommercialPolicy> = {}): GoverningCommercialPolicy {
  return { agreementRef: "agr-1", agreementVersion: 3, ...over };
}

function input(over: Partial<BuildEvidenceInput> = {}): BuildEvidenceInput {
  return {
    partnerRef: "partner-1",
    period,
    evidenceCutoff: CUTOFF,
    assignments: ASSIGNMENTS,
    assignmentScanTruncated: false,
    assignmentsScanned: ASSIGNMENTS.length,
    threads: THREADS,
    analyticsRecords: [],
    analyticsScanTruncated: false,
    analyticsRecordsScanned: 0,
    ...over,
  };
}

const build = (over: Partial<BuildEvidenceInput> = {}) => buildEvidence(input(over));
const commercialOf = (over: Partial<BuildEvidenceInput> = {}): CommercialEvidence => build(over).snapshot.commercial!;

const REQUIREMENT_THREADS = { requiredCount: 2, qualifyingUnit: "approved_content_thread", requirementSourceRef: "req-1" } as const;

// ---- No governing policy: everything honestly unavailable ------------------------------------------

describe("commercial evidence - no governing policy (the Agreement module is not built)", () => {
  it("every section is unavailable, affectsPayment is false everywhere and no requirement is invented", () => {
    const commercial = commercialOf();
    expect(commercial).toEqual(neutralCommercialEvidence());
    expect(commercial).toEqual({
      policyVersion: 1,
      governingAgreement: null,
      monthlyDeliverable: {
        requiredCount: null,
        requirementSource: null,
        qualifyingUnit: null,
        actualQualifyingCount: null,
        actualCountSources: null,
        variance: null,
        evaluation: "unavailable",
        unavailableReason: "no_agreement_requirement",
        affectsPayment: false,
      },
      lfcSfc: { status: "unavailable", unavailableReason: "no_agreement_rule", ruleRef: null, ruleSource: null, qualifyingUnit: null, qualifyingUnitSource: null, lfcCount: null, sfcCount: null, unclassifiedCount: null, units: [], affectsPayment: false },
      targets: [],
    });
  });

  it("an Assignment's own brief requiredCount is never promoted to a monthly requirement", () => {
    const commercial = commercialOf({ assignments: [assignment("as-1", { requiredCount: 9 })], threads: [thread("ct-1", "as-1")] });
    expect(commercial.monthlyDeliverable.requiredCount).toBeNull();
    expect(commercial.monthlyDeliverable.evaluation).toBe("unavailable");
  });

  it("a policy WITHOUT a requirement / rule / targets is still all-unavailable (only the governing Agreement identity is recorded)", () => {
    const commercial = commercialOf({ commercialPolicy: policyOf() });
    expect(commercial.governingAgreement).toEqual({ agreementRef: "agr-1", agreementVersion: 3 });
    expect(commercial.monthlyDeliverable).toMatchObject({ requiredCount: null, evaluation: "unavailable", unavailableReason: "no_agreement_requirement", affectsPayment: false });
    expect(commercial.lfcSfc).toMatchObject({ status: "unavailable", unavailableReason: "no_agreement_rule", lfcCount: null, sfcCount: null, unclassifiedCount: null, affectsPayment: false });
    expect(commercial.targets).toEqual([]);
  });

  it("the built snapshot with no policy still validates against the strict schema (old code paths unchanged)", () => {
    expect(() => evidenceSnapshotSchema.parse(build().snapshot)).not.toThrow();
  });
});

// ---- Monthly deliverable -------------------------------------------------------------------------------

describe("monthly deliverable (Agreement-governed, from canonical APPROVED Content only)", () => {
  it("approved_content_thread: met when actual equals the required count, with the exact units counted", () => {
    const { monthlyDeliverable: d } = commercialOf({ commercialPolicy: policyOf({ monthlyDeliverableRequirement: REQUIREMENT_THREADS }) });
    expect(d).toEqual({
      requiredCount: 2,
      requirementSource: { agreementRef: "agr-1", agreementVersion: 3, requirementSourceRef: "req-1" },
      qualifyingUnit: "approved_content_thread",
      actualQualifyingCount: 2,
      actualCountSources: {
        sourceType: "content_thread",
        units: [
          { assignmentRef: "as-1", contentRef: "ct-1", unitCount: 1 },
          { assignmentRef: "as-2", contentRef: "ct-2", unitCount: 1 },
        ],
      },
      variance: 0,
      evaluation: "met",
      unavailableReason: null,
      affectsPayment: true,
    });
  });

  it("below_requirement carries a negative variance; exceeded a positive one", () => {
    const below = commercialOf({ commercialPolicy: policyOf({ monthlyDeliverableRequirement: { requiredCount: 5, qualifyingUnit: "approved_content_thread" } }) }).monthlyDeliverable;
    expect(below).toMatchObject({ requiredCount: 5, actualQualifyingCount: 2, variance: -3, evaluation: "below_requirement", affectsPayment: true });
    expect(below.requirementSource).toEqual({ agreementRef: "agr-1", agreementVersion: 3, requirementSourceRef: null });

    const exceeded = commercialOf({ commercialPolicy: policyOf({ monthlyDeliverableRequirement: { requiredCount: 1, qualifyingUnit: "approved_content_thread" } }) }).monthlyDeliverable;
    expect(exceeded).toMatchObject({ actualQualifyingCount: 2, variance: 1, evaluation: "exceeded" });
  });

  it("approved_current_link: sums the current links of APPROVED threads only (2 + 1)", () => {
    const d = commercialOf({ commercialPolicy: policyOf({ monthlyDeliverableRequirement: { requiredCount: 3, qualifyingUnit: "approved_current_link" } }) }).monthlyDeliverable;
    expect(d).toMatchObject({ qualifyingUnit: "approved_current_link", actualQualifyingCount: 3, variance: 0, evaluation: "met", affectsPayment: true });
    expect(d.actualCountSources).toEqual({
      sourceType: "content_link",
      units: [
        { assignmentRef: "as-1", contentRef: "ct-1", unitCount: 2 },
        { assignmentRef: "as-2", contentRef: "ct-2", unitCount: 1 },
      ],
    });
  });

  it("raw / unapproved links never count: UNDER_REVIEW (3), REVISION_REQUESTED (4), OPEN, a thread-less Assignment and a CANCELLED Assignment's approved thread are all excluded", () => {
    const linkUnit = commercialOf({ commercialPolicy: policyOf({ monthlyDeliverableRequirement: { requiredCount: 0, qualifyingUnit: "approved_current_link" } }) }).monthlyDeliverable;
    expect(linkUnit.actualQualifyingCount).toBe(3);
    const refs = linkUnit.actualCountSources!.units.map((unit) => unit.contentRef);
    for (const excluded of ["ct-3", "ct-4", "ct-5", "ct-6"]) expect(refs).not.toContain(excluded);

    // Only unapproved threads with lots of links: the count is zero, never their links.
    const onlyUnapproved = commercialOf({
      assignments: [assignment("as-3"), assignment("as-4"), assignment("as-5")],
      threads: [thread("ct-3", "as-3", { status: "UNDER_REVIEW", links: 5 }), thread("ct-4", "as-4", { status: "REVISION_REQUESTED", links: 5 }), thread("ct-5", "as-5", { status: "OPEN", links: 5 })],
      commercialPolicy: policyOf({ monthlyDeliverableRequirement: { requiredCount: 1, qualifyingUnit: "approved_current_link" } }),
    }).monthlyDeliverable;
    expect(onlyUnapproved).toMatchObject({ actualQualifyingCount: 0, variance: -1, evaluation: "below_requirement", actualCountSources: { sourceType: "content_link", units: [] } });
  });

  it("a requirement of zero is honored (met at zero, exceeded above it)", () => {
    expect(commercialOf({ assignments: [], threads: [], commercialPolicy: policyOf({ monthlyDeliverableRequirement: { requiredCount: 0, qualifyingUnit: "approved_content_thread" } }) }).monthlyDeliverable).toMatchObject({ actualQualifyingCount: 0, variance: 0, evaluation: "met" });
  });

  it("an unsupported qualifying unit is unavailable (unsupported_qualifying_unit) - never guessed, never payment-affecting", () => {
    expect(isSupportedQualifyingUnit("approved_content_thread")).toBe(true);
    expect(isSupportedQualifyingUnit("published_post")).toBe(false);
    const d = commercialOf({ commercialPolicy: policyOf({ monthlyDeliverableRequirement: { requiredCount: 4, qualifyingUnit: "published_post" } }) }).monthlyDeliverable;
    expect(d).toMatchObject({ evaluation: "unavailable", unavailableReason: "unsupported_qualifying_unit", actualQualifyingCount: null, variance: null, qualifyingUnit: null, affectsPayment: false });
    // The requirement itself IS the policy's, so it is copied - only the count is refused.
    expect(d.requiredCount).toBe(4);
  });

  it("a truncated Assignment read refuses to evaluate (an undercount must never read as below_requirement)", () => {
    const d = commercialOf({ assignmentScanTruncated: true, commercialPolicy: policyOf({ monthlyDeliverableRequirement: REQUIREMENT_THREADS }) }).monthlyDeliverable;
    expect(d).toMatchObject({ evaluation: "unavailable", unavailableReason: "evidence_truncated", actualQualifyingCount: null, affectsPayment: false });
  });

  it("only in-period Assignments are counted", () => {
    const d = commercialOf({
      assignments: [assignment("as-1"), assignment("as-out", { dueAt: "2026-07-01" })],
      threads: [thread("ct-1", "as-1"), thread("ct-out", "as-out")],
      commercialPolicy: policyOf({ monthlyDeliverableRequirement: { requiredCount: 1, qualifyingUnit: "approved_content_thread" } }),
    }).monthlyDeliverable;
    expect(d.actualQualifyingCount).toBe(1);
    expect(d.actualCountSources!.units.map((u) => u.contentRef)).toEqual(["ct-1"]);
  });
});

// ---- LFC / SFC -------------------------------------------------------------------------------------------

describe("LFC / SFC classification", () => {
  const rule = { ruleRef: "rule-1", byFormat: { reel: "SFC", "long video": "LFC", VIDEO: "LFC" }, affectsPayment: true } as const;

  it("without an Agreement rule it is unavailable and NOTHING is inferred from platform / format / URL count / names", () => {
    const commercial = commercialOf({ commercialPolicy: policyOf({ monthlyDeliverableRequirement: REQUIREMENT_THREADS }) });
    expect(commercial.lfcSfc).toEqual(neutralCommercialEvidence().lfcSfc);
    expect(commercial.lfcSfc).toMatchObject({ status: "unavailable", lfcCount: null, sfcCount: null, unclassifiedCount: null, affectsPayment: false });
  });

  it("with a rule: classifies each qualifying unit by exact case-insensitive (trimmed) format match; no match is unclassified; counts are integers", () => {
    const lfc = commercialOf({ commercialPolicy: policyOf({ monthlyDeliverableRequirement: REQUIREMENT_THREADS, lfcSfcRule: rule }) }).lfcSfc;
    expect(lfc).toMatchObject({
      status: "evaluated",
      unavailableReason: null,
      ruleRef: "rule-1",
      ruleSource: { agreementRef: "agr-1", agreementVersion: 3 },
      qualifyingUnit: "approved_content_thread",
      qualifyingUnitSource: "agreement_requirement",
      lfcCount: 0,
      sfcCount: 1,
      unclassifiedCount: 1,
      affectsPayment: true,
    });
    expect(lfc.units).toEqual([
      // "Reel" (brief) matches "reel" (rule) case-insensitively.
      { assignmentRef: "as-1", contentRef: "ct-1", unitCount: 1, classification: "SFC", basis: { ruleRef: "rule-1", matchedFormat: "reel" } },
      // "story" is not in the rule: never guessed.
      { assignmentRef: "as-2", contentRef: "ct-2", unitCount: 1, classification: "unclassified", basis: { ruleRef: "rule-1", matchedFormat: null } },
    ]);
    for (const count of [lfc.lfcCount, lfc.sfcCount, lfc.unclassifiedCount]) expect(Number.isInteger(count)).toBe(true);
  });

  it("uses the SAME qualifying definition as the deliverable: unapproved threads and cancelled Assignments are never classified", () => {
    const lfc = commercialOf({ commercialPolicy: policyOf({ lfcSfcRule: rule }) }).lfcSfc;
    expect(lfc.units.map((unit) => unit.assignmentRef)).toEqual(["as-1", "as-2"]);
  });

  it("without any Agreement requirement the documented default unit (approved_content_thread) is used AND recorded", () => {
    const lfc = commercialOf({ commercialPolicy: policyOf({ lfcSfcRule: rule }) }).lfcSfc;
    expect(lfc).toMatchObject({ status: "evaluated", qualifyingUnit: "approved_content_thread", qualifyingUnitSource: "default_approved_content_thread" });
  });

  it("with approved_current_link the classification counts LINKS (unitCount) per qualifying thread", () => {
    const lfc = commercialOf({ commercialPolicy: policyOf({ monthlyDeliverableRequirement: { requiredCount: 3, qualifyingUnit: "approved_current_link" }, lfcSfcRule: rule }) }).lfcSfc;
    expect(lfc).toMatchObject({ qualifyingUnit: "approved_current_link", sfcCount: 2, lfcCount: 0, unclassifiedCount: 1 });
    expect(lfc.units.map((unit) => unit.unitCount)).toEqual([2, 1]);
  });

  it("a brief whose formats match both classes (a conflict) is unclassified, and the classifier never guesses", () => {
    expect(classifyFormats(["reel", "video"], rule.byFormat)).toEqual({ classification: "unclassified", matchedFormat: null });
    // two formats resolving to the SAME class are fine
    expect(classifyFormats(["Video", "long video"], rule.byFormat)).toEqual({ classification: "LFC", matchedFormat: "long video" });
    expect(classifyFormats(["  REEL  "], rule.byFormat)).toEqual({ classification: "SFC", matchedFormat: "reel" });
    expect(classifyFormats([], rule.byFormat)).toEqual({ classification: "unclassified", matchedFormat: null });
    // a rule that maps ONE format (after normalization) to both classes is ambiguous for that format
    expect(classifyFormats(["reel"], { Reel: "LFC", reel: "SFC" })).toEqual({ classification: "unclassified", matchedFormat: null });
    // partial-word / substring never match
    expect(classifyFormats(["reels"], rule.byFormat).classification).toBe("unclassified");
  });

  it("an unsupported requirement unit makes LFC/SFC unavailable too; a truncated read refuses to classify", () => {
    expect(commercialOf({ commercialPolicy: policyOf({ monthlyDeliverableRequirement: { requiredCount: 1, qualifyingUnit: "nope" }, lfcSfcRule: rule }) }).lfcSfc).toMatchObject({ status: "unavailable", unavailableReason: "unsupported_qualifying_unit", lfcCount: null, affectsPayment: false });
    expect(commercialOf({ assignmentScanTruncated: true, commercialPolicy: policyOf({ lfcSfcRule: rule }) }).lfcSfc).toMatchObject({ status: "unavailable", unavailableReason: "evidence_truncated", sfcCount: null, affectsPayment: false });
  });
});

// ---- Payment-affecting flag ---------------------------------------------------------------------------------

describe("affectsPayment is true ONLY for an evaluated Agreement-governed deliverable / LFC-SFC", () => {
  it("matrix", () => {
    const flags = (over: Partial<BuildEvidenceInput>) => {
      const c = commercialOf(over);
      return { deliverable: c.monthlyDeliverable.affectsPayment, lfcSfc: c.lfcSfc.affectsPayment, targets: c.targets.map((t) => t.affectsPayment) };
    };
    expect(flags({})).toEqual({ deliverable: false, lfcSfc: false, targets: [] });
    expect(flags({ commercialPolicy: policyOf() })).toEqual({ deliverable: false, lfcSfc: false, targets: [] });
    expect(flags({ commercialPolicy: policyOf({ monthlyDeliverableRequirement: REQUIREMENT_THREADS }) })).toEqual({ deliverable: true, lfcSfc: false, targets: [] });
    expect(flags({ commercialPolicy: policyOf({ monthlyDeliverableRequirement: { requiredCount: 1, qualifyingUnit: "bogus" } }) })).toEqual({ deliverable: false, lfcSfc: false, targets: [] });
    expect(flags({ commercialPolicy: policyOf({ lfcSfcRule: { ruleRef: "r", byFormat: { reel: "LFC" }, affectsPayment: true } }) })).toEqual({ deliverable: false, lfcSfc: true, targets: [] });
    expect(flags({ commercialPolicy: policyOf({ targets: [{ targetRef: "t1", metricId: "likes", targetValue: 1, unit: "count", comparison: "at_least" }] }) }).targets).toEqual([false]);
  });
});

// ---- Targets -----------------------------------------------------------------------------------------------------

const target = (over: Partial<NonNullable<GoverningCommercialPolicy["targets"]>[number]> = {}) => ({ targetRef: "t1", metricId: "likes", targetValue: 100, unit: "count", comparison: "at_least" as const, ...over });

describe("targets (warning only)", () => {
  it("every target carries affectsPayment:false and a miss changes neither the deliverable nor LFC/SFC", () => {
    const base = policyOf({ monthlyDeliverableRequirement: REQUIREMENT_THREADS, lfcSfcRule: { ruleRef: "rule-1", byFormat: { reel: "SFC" }, affectsPayment: true } });
    const records = [record("r1", { likes: 10 })];
    const withoutTargets = commercialOf({ analyticsRecords: records, commercialPolicy: base });
    const missed = commercialOf({ analyticsRecords: records, commercialPolicy: { ...base, targets: [target({ targetValue: 1_000_000 })] } });
    const hit = commercialOf({ analyticsRecords: records, commercialPolicy: { ...base, targets: [target({ targetValue: 1 })] } });

    expect(missed.targets[0]).toMatchObject({ evaluation: "not_met", affectsPayment: false });
    expect(hit.targets[0]).toMatchObject({ evaluation: "met", affectsPayment: false });
    // The payment-affecting sections are byte-identical whatever the targets say.
    expect(missed.monthlyDeliverable).toEqual(withoutTargets.monthlyDeliverable);
    expect(missed.lfcSfc).toEqual(withoutTargets.lfcSfc);
    expect(hit.monthlyDeliverable).toEqual(withoutTargets.monthlyDeliverable);
    expect(hit.lfcSfc).toEqual(withoutTargets.lfcSfc);
  });

  it("the literal type false: a target can never claim to affect payment", () => {
    expectTypeOf<CommercialEvidence["targets"][number]["affectsPayment"]>().toEqualTypeOf<false>();
    const result = commercialEvidenceSchema.safeParse({ ...neutralCommercialEvidence(), targets: [{ ...target(), actualValue: null, evaluation: "unavailable", unavailableReason: "x", provenance: { sourceType: "analytics_source_record", refs: [], recordsWithMetric: 0, recordsMissingMetric: 0 }, affectsPayment: true }] });
    expect(result.success).toBe(false);
  });

  it("Reach (and every other unsupported metric) is unavailable (unsupported_metric) - never not_met, never zero", () => {
    const targets = ["reach", "impressions", "shares", "saves", "watchTimeMinutes", "demographics", "authenticityScore", "totally_unknown", "profileFollowers"].map((metricId, i) => target({ targetRef: `t${i}`, metricId }));
    const built = commercialOf({ analyticsRecords: [record("r1", { likes: 10, views: 100 })], commercialPolicy: policyOf({ targets }) });
    expect(built.targets).toHaveLength(targets.length);
    for (const result of built.targets) {
      expect(result).toMatchObject({ evaluation: "unavailable", unavailableReason: "unsupported_metric", actualValue: null, affectsPayment: false });
      expect(result.provenance).toEqual({ sourceType: "analytics_source_record", refs: [], recordsWithMetric: 0, recordsMissingMetric: 0 });
    }
  });

  it("content metrics sum ONLY records that have the metric: missing is never zero, and no values at all is unavailable (no_verified_values)", () => {
    const none = commercialOf({ analyticsRecords: [record("r1"), record("r2")], commercialPolicy: policyOf({ targets: [target()] }) }).targets[0]!;
    expect(none).toMatchObject({ evaluation: "unavailable", unavailableReason: "no_verified_values", actualValue: null });
    expect(none.provenance).toMatchObject({ recordsWithMetric: 0, recordsMissingMetric: 2, refs: [] });

    // A reported ZERO is a real value (unlike missing).
    const zero = commercialOf({ analyticsRecords: [record("r1", { likes: 0 })], commercialPolicy: policyOf({ targets: [target({ targetValue: 1 })] }) }).targets[0]!;
    expect(zero).toMatchObject({ evaluation: "not_met", actualValue: 0 });
  });

  it("partial coverage: a sum that already reaches the target is met; a shortfall is unavailable (incomplete_metric_coverage), never not_met", () => {
    const records = [record("r1", { likes: 70 }), record("r2", { likes: 40 }), record("r3", { likes: null })];
    const met = commercialOf({ analyticsRecords: records, commercialPolicy: policyOf({ targets: [target({ targetValue: 100 })] }) }).targets[0]!;
    expect(met).toMatchObject({ evaluation: "met", actualValue: 110 });
    expect(met.provenance).toEqual({ sourceType: "analytics_source_record", refs: ["r1", "r2"], recordsWithMetric: 2, recordsMissingMetric: 1 });

    const short = commercialOf({ analyticsRecords: records, commercialPolicy: policyOf({ targets: [target({ targetValue: 500 })] }) }).targets[0]!;
    expect(short).toMatchObject({ evaluation: "unavailable", unavailableReason: "incomplete_metric_coverage", actualValue: null });
    expect(short.provenance).toMatchObject({ recordsWithMetric: 2, recordsMissingMetric: 1 });
  });

  it("full coverage: at or above the target is met, below it is not_met", () => {
    const records = [record("r1", { likes: 70 }), record("r2", { likes: 40 })];
    expect(commercialOf({ analyticsRecords: records, commercialPolicy: policyOf({ targets: [target({ targetValue: 110 })] }) }).targets[0]).toMatchObject({ evaluation: "met", actualValue: 110 });
    expect(commercialOf({ analyticsRecords: records, commercialPolicy: policyOf({ targets: [target({ targetValue: 111 })] }) }).targets[0]).toMatchObject({ evaluation: "not_met", actualValue: 110 });
  });

  it("a capped Analytics read is treated as incomplete coverage (never a not_met)", () => {
    const t = commercialOf({ analyticsScanTruncated: true, analyticsRecords: [record("r1", { likes: 5 })], commercialPolicy: policyOf({ targets: [target({ targetValue: 100 })] }) }).targets[0]!;
    expect(t).toMatchObject({ evaluation: "unavailable", unavailableReason: "incomplete_metric_coverage" });
  });

  it("engagement is the SOURCE-REPORTED field only - never derived from likes + comments", () => {
    const records = [record("r1", { likes: 500, comments: 500, engagement: null })];
    const derived = commercialOf({ analyticsRecords: records, commercialPolicy: policyOf({ targets: [target({ metricId: "engagement", targetValue: 10 })] }) }).targets[0]!;
    expect(derived).toMatchObject({ evaluation: "unavailable", unavailableReason: "no_verified_values", actualValue: null });
    const reported = commercialOf({ analyticsRecords: [record("r1", { likes: 1, comments: 1, engagement: 42 })], commercialPolicy: policyOf({ targets: [target({ metricId: "engagement", targetValue: 40 })] }) }).targets[0]!;
    expect(reported).toMatchObject({ evaluation: "met", actualValue: 42 });
  });

  it("comments and views sum the same way, and only in-period records of THIS Partner count", () => {
    const records = [
      record("r1", { comments: 3, views: 100 }),
      record("r2", { comments: 4, views: null }),
      record("out", { comments: 999, views: 999, reportingPeriod: { start: "2026-06-01", end: "2026-06-30" } }),
      record("other", { comments: 999, views: 999, matchedPartnerRef: "partner-2" }),
    ];
    const targets = commercialOf({ analyticsRecords: records, commercialPolicy: policyOf({ targets: [target({ targetRef: "c", metricId: "comments", targetValue: 7 }), target({ targetRef: "v", metricId: "views", targetValue: 100 })] }) }).targets;
    expect(targets.find((t) => t.targetRef === "c")).toMatchObject({ evaluation: "met", actualValue: 7 });
    expect(targets.find((t) => t.targetRef === "v")).toMatchObject({ evaluation: "met", actualValue: 100 });
  });

  it("targets are emitted in a deterministic order (targetRef)", () => {
    const targets = commercialOf({ commercialPolicy: policyOf({ targets: [target({ targetRef: "b" }), target({ targetRef: "a" })] }) }).targets;
    expect(targets.map((t) => t.targetRef)).toEqual(["a", "b"]);
  });
});

// ---- followerGrowth --------------------------------------------------------------------------------------------------

describe("followerGrowth (derived ONLY from channel snapshot Analytics records)", () => {
  const growthPolicy = (targetValue = 100) => policyOf({ targets: [target({ targetRef: "g", metricId: "followerGrowth", targetValue, unit: "followers" })] });
  const growthOf = (channelRecords: ChannelSnapshotRecordSource[], over: Partial<BuildEvidenceInput> = {}, targetValue = 100) => commercialOf({ channelRecords, commercialPolicy: growthPolicy(targetValue), ...over }).targets[0]!;
  const snap = (ref: string, day: string, followers: number | null, over: Partial<ChannelSnapshotRecordSource> = {}) => channel(ref, { reportingPeriod: { start: day, end: day }, profileFollowers: followers, ...over });

  it("is unavailable (insufficient_follower_snapshots) with zero snapshots and with a single snapshot - growth is never fabricated", () => {
    for (const records of [[], [snap("c1", "2026-03-05", 1000)]]) {
      const result = growthOf(records);
      expect(result).toMatchObject({ evaluation: "unavailable", unavailableReason: "insufficient_follower_snapshots", actualValue: null });
      expect(result.provenance.refs).toEqual([]);
    }
  });

  it("is computed as latest - earliest for >= 2 distinct verified snapshots of the SAME account", () => {
    const result = growthOf([snap("c2", "2026-03-28", 1180), snap("c1", "2026-03-02", 1000), snap("c3", "2026-03-15", 1100)], {}, 150);
    expect(result).toMatchObject({ evaluation: "met", actualValue: 180, unavailableReason: null, affectsPayment: false });
    expect(result.provenance).toEqual({ sourceType: "analytics_source_record", refs: ["c1", "c2", "c3"], recordsWithMetric: 3, recordsMissingMetric: 0 });
    expect(growthOf([snap("c2", "2026-03-28", 1180), snap("c1", "2026-03-02", 1000)], {}, 181)).toMatchObject({ evaluation: "not_met", actualValue: 180 });
  });

  it("growth may be negative", () => {
    const result = growthOf([snap("c1", "2026-03-02", 1000), snap("c2", "2026-03-30", 900)], {}, 0);
    expect(result).toMatchObject({ actualValue: -100, evaluation: "not_met" });
    expect(growthOf([snap("c1", "2026-03-02", 1000), snap("c2", "2026-03-30", 900)], {}, -100)).toMatchObject({ actualValue: -100, evaluation: "met" });
  });

  it("two DIFFERENT accounts with one snapshot each is not growth (insufficient), and one account with 2 + another with 1 is refused too", () => {
    expect(growthOf([snap("c1", "2026-03-02", 1000, { matchedPartnerAccountRef: "acct-1" }), snap("c2", "2026-03-28", 1200, { matchedPartnerAccountRef: "acct-2" })])).toMatchObject({ evaluation: "unavailable", unavailableReason: "insufficient_follower_snapshots" });
    expect(growthOf([snap("c1", "2026-03-02", 1000), snap("c2", "2026-03-28", 1200), snap("c3", "2026-03-10", 50, { matchedPartnerAccountRef: "acct-2" })])).toMatchObject({ evaluation: "unavailable", unavailableReason: "insufficient_follower_snapshots" });
  });

  it("several accounts each with >= 2 snapshots: the Partner's growth is the sum of each account's growth", () => {
    const result = growthOf(
      [snap("c1", "2026-03-02", 1000), snap("c2", "2026-03-28", 1100), snap("d1", "2026-03-02", 500, { matchedPartnerAccountRef: "acct-2" }), snap("d2", "2026-03-28", 470, { matchedPartnerAccountRef: "acct-2" })],
      {},
      70,
    );
    expect(result).toMatchObject({ actualValue: 70, evaluation: "met" });
    expect(result.provenance.refs).toEqual(["c1", "c2", "d1", "d2"]);
  });

  it("two snapshots on the SAME as-of date are one snapshot (duplicates collapse) but disagreeing values are a conflict", () => {
    expect(growthOf([snap("c1", "2026-03-02", 1000), snap("c1b", "2026-03-02", 1000)])).toMatchObject({ evaluation: "unavailable", unavailableReason: "insufficient_follower_snapshots" });
    expect(growthOf([snap("c1", "2026-03-02", 1000), snap("c1b", "2026-03-02", 1001), snap("c2", "2026-03-28", 1100)])).toMatchObject({ evaluation: "unavailable", unavailableReason: "conflicting_follower_snapshots" });
    const dupe = growthOf([snap("c1", "2026-03-02", 1000), snap("c1b", "2026-03-02", 1000), snap("c2", "2026-03-28", 1100)], {}, 100);
    expect(dupe).toMatchObject({ evaluation: "met", actualValue: 100 });
    expect(dupe.provenance.refs).toEqual(["c1", "c2"]);
  });

  it("only verified, in-window, this-Partner, MATCHED, account-matched snapshots with a reported value are used", () => {
    const records = [
      snap("ok1", "2026-03-01", 1000), // first day of the period (boundary, inclusive)
      snap("ok2", "2026-03-31", 1090), // last day of the period (boundary, inclusive)
      snap("before", "2026-02-28", 1), // outside
      snap("after", "2026-04-01", 999999), // outside
      snap("other", "2026-03-15", 5, { matchedPartnerRef: "partner-2" }),
      snap("unmatched", "2026-03-15", 5, { matchState: "UNMATCHED" }),
      snap("noaccount", "2026-03-15", 5, { matchedPartnerAccountRef: null }),
      snap("noperiod", "2026-03-15", 5, { reportingPeriod: null }),
      snap("badperiod", "2026-03-15", 5, { reportingPeriod: { start: "x", end: "y" } }),
      snap("nofollowers", "2026-03-20", null),
    ];
    const result = growthOf(records, {}, 90);
    expect(result).toMatchObject({ evaluation: "met", actualValue: 90 });
    expect(result.provenance).toEqual({ sourceType: "analytics_source_record", refs: ["ok1", "ok2"], recordsWithMetric: 2, recordsMissingMetric: 1 });
  });

  it("a capped channel read is unavailable (channel_scan_truncated) and unparseable periods never produce growth", () => {
    expect(growthOf([snap("c1", "2026-03-02", 1000), snap("c2", "2026-03-28", 1100)], { channelScanTruncated: true })).toMatchObject({ evaluation: "unavailable", unavailableReason: "channel_scan_truncated" });
    expect(growthOf([snap("c1", "soon", 1000, { reportingPeriod: { start: "soon", end: "soon" } }), snap("c2", "later", 1100, { reportingPeriod: { start: "later", end: "later" } })])).toMatchObject({ evaluation: "unavailable", unavailableReason: "insufficient_follower_snapshots" });
  });

  it("channel records are ignored entirely unless the policy names followerGrowth, and the used records join the snapshot's source refs", () => {
    const records = [snap("c1", "2026-03-02", 1000), snap("c2", "2026-03-28", 1100)];
    const noTarget = build({ channelRecords: records, commercialPolicy: policyOf({ targets: [target()] }) });
    expect(noTarget.sourceRefs.some((ref) => ref.ref === "c1")).toBe(false);

    const withTarget = build({ channelRecords: records, commercialPolicy: growthPolicy() });
    expect(withTarget.sourceRefs).toEqual(expect.arrayContaining([{ type: "analyticsSourceRecord", ref: "c1" }, { type: "analyticsSourceRecord", ref: "c2" }]));
    expect(withTarget.snapshot.sourceRefs).toEqual(withTarget.sourceRefs);
    expect(selectFollowerSnapshotCandidates("partner-1", period, records).map((entry) => entry.asOf)).toEqual(["2026-03-02", "2026-03-28"]);
  });
});

// ---- Fingerprint --------------------------------------------------------------------------------------------------------

describe("source fingerprint and the commercial policy", () => {
  // The exact fingerprint this fixture produced BEFORE commercial evidence
  // existed (commit 1d84d38): a Partner with no governing policy must hash
  // byte-for-byte the same, so existing versions stay current.
  const PINNED_NULL_POLICY_FINGERPRINT = "2ec26bb8a9dedc20eb3b1228f324f5247c8cfad2ca53472c7f3e24724a6b00b1";

  function pinnedFixture(over: Partial<BuildEvidenceInput> = {}) {
    return buildEvidence({
      partnerRef: "partner-1",
      period,
      evidenceCutoff: CUTOFF,
      assignments: [
        { assignmentRef: "as-1", campaignRef: "camp-1", status: "COMPLETED", version: 3, createdAt: "2026-01-10T08:00:00.000Z", updatedAt: "2026-02-01T08:00:00.000Z", brief: { campaignName: "Spring Launch", dueAt: "2026-03-10", requiredCount: 1, formats: ["reel"], platforms: ["instagram"] } },
        { assignmentRef: "as-2", campaignRef: "camp-1", status: "IN_PROGRESS", version: 1, createdAt: "2026-03-02T08:00:00.000Z", updatedAt: "2026-03-02T08:00:00.000Z", brief: { campaignName: "Spring Launch", dueAt: null, requiredCount: 2, formats: ["story"], platforms: ["instagram"] } },
      ],
      assignmentScanTruncated: false,
      assignmentsScanned: 2,
      threads: [
        {
          contentRef: "ct-1",
          assignmentRef: "as-1",
          version: 4,
          status: "APPROVED",
          currentRevisionNumber: 2,
          currentLinks: [{ platform: "instagram", originalUrl: "https://instagram.com/p/A", normalizedUrl: "https://instagram.com/p/a", recordedAt: "2026-03-08T10:00:00.000Z" }],
          openedAt: "2026-03-01T00:00:00.000Z",
          firstSubmittedAt: "2026-03-05T10:00:00.000Z",
          lastSubmittedAt: "2026-03-08T10:00:00.000Z",
          approvedAt: "2026-03-09T10:00:00.000Z",
          cancelledAt: null,
          updatedAt: "2026-03-09T10:00:00.000Z",
        },
      ],
      analyticsRecords: [record("src-1", { normalizedUrl: "https://instagram.com/p/a", likes: 120, matchEvidence: { tier: "published_url", value: "https://instagram.com/p/a", reasonCode: null, candidateCount: 1 } })],
      analyticsScanTruncated: false,
      analyticsRecordsScanned: 1,
      ...over,
    });
  }

  it("a null policy leaves the fingerprint byte-for-byte what it was at 1d84d38 (pinned fixture)", () => {
    expect(pinnedFixture().sourceFingerprint).toBe(PINNED_NULL_POLICY_FINGERPRINT);
    expect(pinnedFixture({ commercialPolicy: null }).sourceFingerprint).toBe(PINNED_NULL_POLICY_FINGERPRINT);
    // Channel inputs are ignored (and unhashed) without a followerGrowth target.
    expect(pinnedFixture({ channelRecords: [channel("c1")], channelScanTruncated: true }).sourceFingerprint).toBe(PINNED_NULL_POLICY_FINGERPRINT);
  });

  it("a policy changes the fingerprint; so does any change to its Agreement version, requirement, rule or target - and each is time-independent", () => {
    const base = policyOf({
      monthlyDeliverableRequirement: { requiredCount: 2, qualifyingUnit: "approved_content_thread", requirementSourceRef: "req-1" },
      lfcSfcRule: { ruleRef: "rule-1", byFormat: { reel: "SFC" }, affectsPayment: true },
      targets: [target()],
    });
    const fp = (policy: GoverningCommercialPolicy | null, over: Partial<BuildEvidenceInput> = {}) => pinnedFixture({ commercialPolicy: policy, ...over }).sourceFingerprint;

    const fingerprints = new Set([
      fp(null),
      fp(base),
      fp({ ...base, agreementVersion: 4 }),
      fp({ ...base, agreementRef: "agr-2" }),
      fp({ ...base, monthlyDeliverableRequirement: { ...base.monthlyDeliverableRequirement!, requiredCount: 3 } }),
      fp({ ...base, monthlyDeliverableRequirement: { ...base.monthlyDeliverableRequirement!, requirementSourceRef: "req-2" } }),
      fp({ ...base, monthlyDeliverableRequirement: { ...base.monthlyDeliverableRequirement!, qualifyingUnit: "approved_current_link" } }),
      fp({ ...base, lfcSfcRule: { ...base.lfcSfcRule!, ruleRef: "rule-2" } }),
      fp({ ...base, lfcSfcRule: { ...base.lfcSfcRule!, byFormat: { reel: "LFC" } } }),
      fp({ ...base, targets: [target({ targetValue: 101 })] }),
      fp({ ...base, targets: [target({ targetRef: "t9" })] }),
      fp({ ...base, targets: [] }),
    ]);
    expect(fingerprints.size).toBe(12);

    // Same policy, different clock / key order / target order => the same fingerprint.
    expect(fp(base, { evidenceCutoff: "2030-01-01T00:00:00.000Z" })).toBe(fp(base));
    const twoTargets = { ...base, targets: [target({ targetRef: "a" }), target({ targetRef: "b", metricId: "views" })] };
    const reversed = { ...base, targets: [...twoTargets.targets].reverse(), lfcSfcRule: { ruleRef: "rule-1", affectsPayment: true as const, byFormat: { reel: "SFC" as const } } };
    expect(fp(reversed)).toBe(fp(twoTargets));
    // format-key case / whitespace do not change the identity of the rule
    expect(fp({ ...base, lfcSfcRule: { ...base.lfcSfcRule!, byFormat: { "  REEL ": "SFC" } } })).toBe(fp(base));
  });

  it("the policy identity facts are canonical and key-sorted", () => {
    const facts = policyFingerprintFacts(policyOf({ targets: [target({ targetRef: "b" }), target({ targetRef: "a" })], lfcSfcRule: { ruleRef: "r", byFormat: { B: "LFC", a: "SFC" }, affectsPayment: true } }));
    expect(facts.targets.map((t) => t.targetRef)).toEqual(["a", "b"]);
    expect(facts.lfcSfcRule!.byFormat).toEqual([["a", "SFC"], ["b", "LFC"]]);
    expect(facts.requirement).toBeNull();
  });

  it("channel snapshot records feed the fingerprint ONLY through a followerGrowth target, and only the ones the evaluation reads", () => {
    const growth = policyOf({ targets: [target({ metricId: "followerGrowth", targetRef: "g" })] });
    const two = [channel("c1", { reportingPeriod: { start: "2026-03-02", end: "2026-03-02" }, profileFollowers: 1000 }), channel("c2", { reportingPeriod: { start: "2026-03-28", end: "2026-03-28" }, profileFollowers: 1100 })];
    const fp = (records: ChannelSnapshotRecordSource[], policy: GoverningCommercialPolicy = growth) => pinnedFixture({ commercialPolicy: policy, channelRecords: records }).sourceFingerprint;

    const base = fp(two);
    expect(fp([...two, channel("out", { reportingPeriod: { start: "2026-06-01", end: "2026-06-01" } })])).toBe(base); // out-of-window upload: nothing read
    expect(fp([...two, channel("other", { matchedPartnerRef: "partner-2", reportingPeriod: { start: "2026-03-10", end: "2026-03-10" } })])).toBe(base);
    expect(fp([two[0]!, { ...two[1]!, profileFollowers: 1101 }])).not.toBe(base); // a value changed
    expect(fp([...two, channel("c3", { reportingPeriod: { start: "2026-03-15", end: "2026-03-15" }, profileFollowers: 1050 })])).not.toBe(base); // a new in-window snapshot
    expect(fp([two[0]!, { ...two[1]!, correctionRevision: 2 }])).not.toBe(base); // a correction
    // Without a followerGrowth target the channel records are not hashed at all.
    const plain = policyOf({ targets: [target()] });
    expect(fp(two, plain)).toBe(fp([], plain));
  });

  it("the fingerprint does not depend on who is asking: building is a pure function of its inputs", () => {
    const a = pinnedFixture({ commercialPolicy: policyOf({ monthlyDeliverableRequirement: REQUIREMENT_THREADS }) });
    const b = pinnedFixture({ commercialPolicy: policyOf({ monthlyDeliverableRequirement: REQUIREMENT_THREADS }) });
    expect(a.sourceFingerprint).toBe(b.sourceFingerprint);
    expect(a.snapshot).toEqual(b.snapshot);
  });

  it("commercial results derive from already-fingerprinted upstream facts: a thread status change flips both the count and the fingerprint", () => {
    const policy = policyOf({ monthlyDeliverableRequirement: REQUIREMENT_THREADS });
    const before = build({ commercialPolicy: policy });
    const after = build({ commercialPolicy: policy, threads: THREADS.map((t) => (t.contentRef === "ct-2" ? { ...t, status: "UNDER_REVIEW" as const, version: 5, updatedAt: "2026-03-20T00:00:00.000Z" } : t)) });
    expect(before.snapshot.commercial!.monthlyDeliverable.actualQualifyingCount).toBe(2);
    expect(after.snapshot.commercial!.monthlyDeliverable.actualQualifyingCount).toBe(1);
    expect(after.sourceFingerprint).not.toBe(before.sourceFingerprint);
  });
});

// ---- Policy seam ---------------------------------------------------------------------------------------------------------------

describe("the CommercialPolicyProvider seam", () => {
  afterEach(() => {
    setCommercialPolicyProviderForTests(null);
    vi.unstubAllEnvs();
  });

  it("the default provider returns null (Agreement module not built)", async () => {
    expect(await getGoverningCommercialPolicy("partner-1", "2026-03")).toBeNull();
  });

  it("a test-injected provider is used, validated, and restorable", async () => {
    setCommercialPolicyProviderForTests(async (partnerRef, periodKey) => (partnerRef === "p" && periodKey === "2026-03" ? policyOf({ monthlyDeliverableRequirement: REQUIREMENT_THREADS }) : null));
    expect(await getGoverningCommercialPolicy("p", "2026-03")).toMatchObject({ agreementRef: "agr-1", monthlyDeliverableRequirement: { requiredCount: 2 } });
    expect(await getGoverningCommercialPolicy("other", "2026-03")).toBeNull();
    setCommercialPolicyProviderForTests(null);
    expect(await getGoverningCommercialPolicy("p", "2026-03")).toBeNull();
  });

  it("a malformed policy fails LOUD (never silently degraded to 'no policy')", async () => {
    setCommercialPolicyProviderForTests(async () => ({ agreementRef: "agr", agreementVersion: 0 }) as unknown as GoverningCommercialPolicy);
    await expect(getGoverningCommercialPolicy("p", "2026-03")).rejects.toBeInstanceOf(CommercialPolicyContractError);
    setCommercialPolicyProviderForTests(async () => ({ agreementRef: "agr", agreementVersion: 1, surprise: true }) as unknown as GoverningCommercialPolicy);
    await expect(getGoverningCommercialPolicy("p", "2026-03")).rejects.toBeInstanceOf(CommercialPolicyContractError);
  });

  it("the test seam refuses to run outside a test environment", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VITEST", "");
    expect(() => setCommercialPolicyProviderForTests(async () => null)).toThrow(/test run/);
    vi.unstubAllEnvs();
    expect(() => setCommercialPolicyProviderForTests(null)).not.toThrow();
  });

  it("the policy schema is data-only and strict, and only supports the 'at_least' comparison", () => {
    expect(governingCommercialPolicySchema.safeParse(policyOf({ targets: [target({ comparison: "at_most" as never })] })).success).toBe(false);
    expect(governingCommercialPolicySchema.safeParse({ ...policyOf(), unknownField: 1 }).success).toBe(false);
    expect(governingCommercialPolicySchema.safeParse(policyOf({ lfcSfcRule: { ruleRef: "r", byFormat: { reel: "MFC" as never }, affectsPayment: true } })).success).toBe(false);
    expect(governingCommercialPolicySchema.safeParse(policyOf({ lfcSfcRule: { ruleRef: "r", byFormat: { reel: "LFC" }, affectsPayment: false as never } })).success).toBe(false);
  });
});

// ---- Schema back-compat --------------------------------------------------------------------------------------------------------------

describe("old stored versions (no `commercial` key) stay readable", () => {
  function docs(): { head: PartnerReviewHeadDoc; version: PartnerReviewVersionDoc; oldRaw: Record<string, unknown> } {
    const built = build({ commercialPolicy: policyOf({ monthlyDeliverableRequirement: REQUIREMENT_THREADS }) });
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
      docVersion: 3,
      createdAt: "2026-05-01T00:00:00.000Z",
      createdByUserRef: "user-ref-1",
      updatedAt: "2026-05-01T00:00:00.000Z",
      updatedByUserRef: "user-ref-1",
    });
    const raw = {
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
      createdAt: "2026-05-01T00:00:00.000Z",
      createdByUserRef: "user-ref-1",
    };
    const oldRaw = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;
    delete (oldRaw.snapshot as Record<string, unknown>).commercial;
    return { head, version: partnerReviewVersionDocSchema.parse(raw), oldRaw };
  }

  it("a stored version WITHOUT a commercial key parses, and rewriting it never invents the key (immutable bytes preserved)", () => {
    const { oldRaw } = docs();
    const parsed = partnerReviewVersionDocSchema.parse(oldRaw);
    expect(parsed.snapshot.commercial).toBeUndefined();
    expect(Object.keys(parsed.snapshot)).not.toContain("commercial");
    expect(JSON.parse(JSON.stringify({ ...parsed, status: "SUPERSEDED" })).snapshot).toEqual(JSON.parse(JSON.stringify(oldRaw.snapshot)));
  });

  it("every reader presents it as the explicit all-unavailable shape (actor DTO and handoff)", () => {
    const { head, oldRaw } = docs();
    const parsed = partnerReviewVersionDocSchema.parse(oldRaw);
    expect(commercialOrNeutral(parsed.snapshot)).toEqual(neutralCommercialEvidence());

    const view = redactVersionForActor(parsed, fullSourceAccessFor(parsed.snapshot));
    expect(view.snapshot.commercial).toMatchObject({ governingAgreement: null, monthlyDeliverable: { evaluation: "unavailable", requiredCount: null, actualCountSources: null, affectsPayment: false }, lfcSfc: { status: "unavailable", units: [] }, targets: [] });

    const handoff = buildFinalizedReviewHandoff({ head, version: parsed, partnerDisplayName: "Creator One" });
    expect(handoff.governingAgreement).toBeNull();
    expect(handoff.paymentAffectingEvidence).toEqual({ monthlyDeliverable: null, lfcSfc: null });
    expect(handoff.warningOnlyTargets).toEqual([]);
  });
});

// ---- No score / money-shaped names ----------------------------------------------------------------------------------------------------------

const FORBIDDEN_SCORE_KEY = /(score|rating|overall|blended|composite|weighted|rank)/i;
// The ONLY identifiers that legitimately match the money-shaped pattern:
// affectsPayment / paymentAffectingEvidence flag whether a value is payment-
// affecting (a boolean, never an amount) and versionCurrency reports whether a
// version is still the current finalized one ("currency" in the freshness
// sense, never a currency of money).
const MONEY_SHAPED = /amount|price|currency|fee|rate|payable|invoice|payment/i;
const ALLOWED_MONEY_SHAPED_KEYS = new Set(["affectsPayment", "paymentAffectingEvidence", "versionCurrency"]);

function schemaKeys(schema: unknown): string[] {
  const def = (schema as { _zod?: { def?: Record<string, unknown> } })._zod?.def;
  if (!def) return [];
  switch (def.type) {
    case "object":
      return Object.entries(def.shape as Record<string, unknown>).flatMap(([key, value]) => [key, ...schemaKeys(value)]);
    case "array":
      return schemaKeys(def.element);
    case "record":
      return schemaKeys(def.valueType);
    case "union":
      return (def.options as unknown[]).flatMap(schemaKeys);
    case "nullable":
    case "optional":
    case "default":
    case "readonly":
    case "prefault":
      return schemaKeys(def.innerType);
    default:
      return [];
  }
}

function dataKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(dataKeys);
  if (value && typeof value === "object") return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => [key, ...dataKeys(child)]);
  return [];
}

function dataStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(dataStrings);
  if (value && typeof value === "object") return Object.values(value as Record<string, unknown>).flatMap(dataStrings);
  return [];
}

// A commercial section exercising every branch at once.
function fullPolicy(): GoverningCommercialPolicy {
  return policyOf({
    monthlyDeliverableRequirement: { requiredCount: 2, qualifyingUnit: "approved_content_thread", requirementSourceRef: "req-1" },
    lfcSfcRule: { ruleRef: "rule-1", byFormat: { reel: "SFC", video: "LFC" }, affectsPayment: true },
    targets: [target({ targetRef: "t-likes", metricId: "likes", targetValue: 50 }), target({ targetRef: "t-reach", metricId: "reach" }), target({ targetRef: "t-growth", metricId: "followerGrowth", targetValue: 10, unit: "followers" })],
  });
}
const FULL_CHANNEL = [channel("c1", { reportingPeriod: { start: "2026-03-02", end: "2026-03-02" }, profileFollowers: 1000 }), channel("c2", { reportingPeriod: { start: "2026-03-28", end: "2026-03-28" }, profileFollowers: 1100 })];
const fullBuild = () => build({ commercialPolicy: fullPolicy(), channelRecords: FULL_CHANNEL, analyticsRecords: [record("r1", { likes: 60 })] });

describe("commercial section: no score keys and no money-shaped fields", () => {
  it("the schema walker sees the commercial schema (sanity)", () => {
    expect(schemaKeys(commercialEvidenceSchema)).toEqual(expect.arrayContaining(["monthlyDeliverable", "lfcSfc", "targets", "requiredCount", "affectsPayment", "provenance", "basis"]));
  });

  it("no schema key, generated key or generated string value of the commercial section matches a score-like name", () => {
    const { snapshot } = fullBuild();
    expect(schemaKeys(commercialEvidenceSchema).filter((key) => FORBIDDEN_SCORE_KEY.test(key))).toEqual([]);
    expect(dataKeys(snapshot.commercial).filter((key) => FORBIDDEN_SCORE_KEY.test(key))).toEqual([]);
    expect(dataStrings(snapshot.commercial).filter((value) => FORBIDDEN_SCORE_KEY.test(value))).toEqual([]);
    expect(dataStrings(neutralCommercialEvidence()).filter((value) => FORBIDDEN_SCORE_KEY.test(value))).toEqual([]);
  });

  it("no field of the commercial snapshot / policy / handoff is money-shaped (only the documented flag and freshness names)", () => {
    const built = fullBuild();
    const { head, version } = finalizedDocs(built);
    const handoff = buildFinalizedReviewHandoff({ head, version, partnerDisplayName: "Creator One" });
    const keys = new Set<string>([
      ...schemaKeys(commercialEvidenceSchema as z.ZodType),
      ...schemaKeys(governingCommercialPolicySchema as z.ZodType),
      ...dataKeys(built.snapshot.commercial),
      ...dataKeys(handoff),
    ]);
    const moneyShaped = [...keys].filter((key) => MONEY_SHAPED.test(key) && !ALLOWED_MONEY_SHAPED_KEYS.has(key));
    expect(moneyShaped).toEqual([]);
    // ...and the documented exceptions really are booleans / freshness objects, never numbers or strings of money.
    expect(typeof handoff.versionCurrency).toBe("object");
    expect(handoff.warningOnlyTargets.every((t) => t.affectsPayment === false)).toBe(true);
  });
});

// ---- Handoff DTO + version currency ------------------------------------------------------------------------------------------------------------

function finalizedDocs(built: ReturnType<typeof fullBuild>, over: { version?: number; status?: PartnerReviewVersionDoc["status"]; currentFinalizedVersion?: number | null } = {}) {
  const version = over.version ?? 1;
  const status = over.status ?? "FINALIZED";
  const head = partnerReviewHeadDocSchema.parse({
    reviewRef: reviewRefFor("partner-1", "2026-03"),
    partnerRef: "partner-1",
    partnerUid: "partner-uid-1",
    periodKey: "2026-03",
    periodStart: period.periodStart,
    periodEnd: period.periodEnd,
    latestVersion: Math.max(version, 1),
    latestStatus: "FINALIZED",
    currentFinalizedVersion: over.currentFinalizedVersion === undefined ? version : over.currentFinalizedVersion,
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
  const doc = partnerReviewVersionDocSchema.parse({
    reviewRef: head.reviewRef,
    version,
    status,
    docVersion: 3,
    snapshot: built.snapshot,
    evidenceCutoff: built.snapshot.evidenceCutoff,
    sourceFingerprint: built.sourceFingerprint,
    sourceRefs: built.sourceRefs,
    generatedAt: "2026-05-01T00:00:00.000Z",
    generatedByUserRef: "user-ref-1",
    finalizedAt: "2026-05-02T00:00:00.000Z",
    finalizedByUserRef: "user-ref-2",
    supersededAt: status === "SUPERSEDED" ? "2026-05-09T00:00:00.000Z" : null,
    supersededByVersion: status === "SUPERSEDED" ? version + 1 : null,
    createdAt: "2026-05-01T00:00:00.000Z",
    createdByUserRef: "user-ref-1",
  });
  return { head, version: doc };
}

describe("evaluateReviewVersionCurrency (pure)", () => {
  const head = (currentFinalizedVersion: number | null) => ({ currentFinalizedVersion });
  it("FINALIZED and still the head's current finalized version -> current_finalized", () => {
    expect(evaluateReviewVersionCurrency(head(2), { version: 2, status: "FINALIZED" })).toEqual({ state: "current_finalized", currentFinalizedVersion: 2, referencedVersion: 2 });
  });

  it("SUPERSEDED, or a newer finalized version exists -> referenced_review_version_is_stale, naming the current one", () => {
    expect(evaluateReviewVersionCurrency(head(2), { version: 1, status: "SUPERSEDED" })).toEqual({ state: "referenced_review_version_is_stale", currentFinalizedVersion: 2, referencedVersion: 1 });
    expect(evaluateReviewVersionCurrency(head(3), { version: 2, status: "FINALIZED" })).toEqual({ state: "referenced_review_version_is_stale", currentFinalizedVersion: 3, referencedVersion: 2 });
  });

  it("is deterministic and total over every status / head combination", () => {
    for (const status of ["DRAFT", "IN_REVIEW", "FINALIZED", "SUPERSEDED"] as const) {
      for (const current of [null, 1, 2]) {
        const a = evaluateReviewVersionCurrency(head(current), { version: 1, status });
        expect(a).toEqual(evaluateReviewVersionCurrency(head(current), { version: 1, status }));
        expect(a.state === "current_finalized").toBe(status === "FINALIZED" && current === 1);
      }
    }
  });
});

describe("finalized-review handoff DTO (contract version 1)", () => {
  const dto = (): FinalizedReviewHandoffDto => {
    const { head, version } = finalizedDocs(fullBuild());
    return buildFinalizedReviewHandoff({ head, version, partnerDisplayName: "Creator One" });
  };

  it("has the exact, stable, versioned shape (a JSON contract snapshot)", () => {
    const value = dto();
    expect(value.contractVersion).toBe(FINALIZED_REVIEW_HANDOFF_CONTRACT_VERSION);
    expect(FINALIZED_REVIEW_HANDOFF_CONTRACT_VERSION).toBe(1);
    expect(Object.keys(value).sort()).toEqual(
      ["contractVersion", "evidenceCutoff", "finalizedAt", "governingAgreement", "paymentAffectingEvidence", "partner", "period", "reviewRef", "reviewVersion", "sourceFingerprint", "versionCurrency", "warningOnlyTargets"].sort(),
    );
    expect({ ...value, sourceFingerprint: "<fingerprint>", reviewRef: "<reviewRef>" }).toEqual({
      contractVersion: 1,
      reviewRef: "<reviewRef>",
      reviewVersion: 1,
      partner: { partnerRef: "partner-1", displayName: "Creator One" },
      period: { periodKey: "2026-03", periodStart: "2026-03-01", periodEnd: "2026-03-31" },
      finalizedAt: "2026-05-02T00:00:00.000Z",
      evidenceCutoff: CUTOFF,
      sourceFingerprint: "<fingerprint>",
      governingAgreement: { agreementRef: "agr-1", agreementVersion: 3 },
      paymentAffectingEvidence: {
        monthlyDeliverable: {
          requiredCount: 2,
          requirementSource: { agreementRef: "agr-1", agreementVersion: 3, requirementSourceRef: "req-1" },
          qualifyingUnit: "approved_content_thread",
          actualQualifyingCount: 2,
          variance: 0,
          evaluation: "met",
        },
        lfcSfc: { ruleRef: "rule-1", ruleSource: { agreementRef: "agr-1", agreementVersion: 3 }, qualifyingUnit: "approved_content_thread", lfcCount: 0, sfcCount: 1, unclassifiedCount: 1 },
      },
      warningOnlyTargets: [
        { targetRef: "t-growth", metricId: "followerGrowth", targetValue: 10, unit: "followers", actualValue: 100, evaluation: "met", unavailableReason: null, affectsPayment: false },
        { targetRef: "t-likes", metricId: "likes", targetValue: 50, unit: "count", actualValue: 60, evaluation: "met", unavailableReason: null, affectsPayment: false },
        { targetRef: "t-reach", metricId: "reach", targetValue: 100, unit: "count", actualValue: null, evaluation: "unavailable", unavailableReason: "unsupported_metric", affectsPayment: false },
      ],
      versionCurrency: { state: "current_finalized", currentFinalizedVersion: 1, referencedVersion: 1 },
    });
  });

  it("carries NO Campaign / Assignment / Content / source-record identifier anywhere", () => {
    const json = JSON.stringify(dto());
    for (const identifier of ["as-1", "as-2", "ct-1", "ct-2", "camp-1", "r1", "c1", "c2", "src-", "campaignRef", "assignmentRef", "contentRef", "sourceRecordRef", "sourceRefs", "batchRef", "sheetName", "partner-uid-1", "owner-uid-1", "regionIds", "teamIds"]) {
      expect(json).not.toContain(identifier);
    }
  });

  it("payment-affecting sections are present ONLY when Agreement-governed and evaluated; a target result never changes them", () => {
    const { head, version } = finalizedDocs(build({ commercialPolicy: policyOf({ targets: [target({ targetValue: 9_999_999 })] }), analyticsRecords: [record("r1", { likes: 1 })] }));
    const value = buildFinalizedReviewHandoff({ head, version, partnerDisplayName: null });
    expect(value.paymentAffectingEvidence).toEqual({ monthlyDeliverable: null, lfcSfc: null });
    expect(value.partner.displayName).toBeNull();
    expect(value.warningOnlyTargets).toHaveLength(1);
    expect(value.warningOnlyTargets[0]).toMatchObject({ evaluation: "not_met", affectsPayment: false });

    // An unsupported-unit requirement is unavailable, so it is NOT handed off as payment-affecting.
    const unsupported = finalizedDocs(build({ commercialPolicy: policyOf({ monthlyDeliverableRequirement: { requiredCount: 1, qualifyingUnit: "nope" } }) }));
    expect(buildFinalizedReviewHandoff({ ...unsupported, partnerDisplayName: null }).paymentAffectingEvidence.monthlyDeliverable).toBeNull();
  });

  it("a SUPERSEDED version's handoff is stale and names the current finalized version; its evidence is untouched", () => {
    const built = fullBuild();
    const current = finalizedDocs(built, { version: 2 });
    const old = finalizedDocs(built, { version: 1, status: "SUPERSEDED", currentFinalizedVersion: 2 });
    const oldDto = buildFinalizedReviewHandoff({ head: old.head, version: old.version, partnerDisplayName: "Creator One" });
    const currentDto = buildFinalizedReviewHandoff({ head: current.head, version: current.version, partnerDisplayName: "Creator One" });
    expect(oldDto.versionCurrency).toEqual({ state: "referenced_review_version_is_stale", currentFinalizedVersion: 2, referencedVersion: 1 });
    expect(currentDto.versionCurrency).toEqual({ state: "current_finalized", currentFinalizedVersion: 2, referencedVersion: 2 });
    expect(oldDto.sourceFingerprint).toBe(built.sourceFingerprint);
    expect(oldDto.paymentAffectingEvidence).toEqual(currentDto.paymentAffectingEvidence);
  });
});

// ---- Redaction of the commercial evidence ------------------------------------------------------------------------------------------------------------

describe("commercial evidence redaction (same per-source access sets as the rest of the snapshot)", () => {
  const S = { assignA: "SENTINEL-ASSIGN-A", assignB: "SENTINEL-ASSIGN-B", contentA: "SENTINEL-CONTENT-A", contentB: "SENTINEL-CONTENT-B", chanA: "SENTINEL-CHAN-A", chanB: "SENTINEL-CHAN-B", recA: "SENTINEL-REC-A" };

  function sentinelVersion() {
    const built = buildEvidence({
      partnerRef: "partner-1",
      period,
      evidenceCutoff: CUTOFF,
      assignments: [assignment(S.assignA, { formats: ["reel"] }), assignment(S.assignB, { formats: ["reel"] })],
      assignmentScanTruncated: false,
      assignmentsScanned: 2,
      threads: [thread(S.contentA, S.assignA, { links: 2 }), thread(S.contentB, S.assignB, { links: 1 })],
      analyticsRecords: [record(S.recA, { likes: 60 })],
      analyticsScanTruncated: false,
      analyticsRecordsScanned: 1,
      channelRecords: [
        channel(S.chanA, { reportingPeriod: { start: "2026-03-02", end: "2026-03-02" }, profileFollowers: 1000 }),
        channel(S.chanB, { reportingPeriod: { start: "2026-03-28", end: "2026-03-28" }, profileFollowers: 1100 }),
      ],
      commercialPolicy: policyOf({
        monthlyDeliverableRequirement: { requiredCount: 3, qualifyingUnit: "approved_current_link" },
        lfcSfcRule: { ruleRef: "rule-1", byFormat: { reel: "SFC" }, affectsPayment: true },
        targets: [target({ targetRef: "t-growth", metricId: "followerGrowth", targetValue: 10 }), target({ targetRef: "t-likes", metricId: "likes", targetValue: 10 })],
      }),
    });
    return partnerReviewVersionDocSchema.parse({
      reviewRef: reviewRefFor("partner-1", "2026-03"),
      version: 1,
      status: "DRAFT",
      docVersion: 1,
      snapshot: built.snapshot,
      evidenceCutoff: built.snapshot.evidenceCutoff,
      sourceFingerprint: built.sourceFingerprint,
      sourceRefs: built.sourceRefs,
      generatedAt: "2026-05-01T00:00:00.000Z",
      generatedByUserRef: "user-ref-1",
      createdAt: "2026-05-01T00:00:00.000Z",
      createdByUserRef: "user-ref-1",
    });
  }

  const noAccessButAssignmentA: SourceAccess = { ...NO_SOURCE_ACCESS, assignments: new Set([S.assignA]) };

  it("the raw section really does name every sentinel (sanity), and collectSnapshotSourceRefs sees the commercial refs", () => {
    const version = sentinelVersion();
    const json = JSON.stringify(version.snapshot.commercial);
    for (const sentinel of [S.assignA, S.assignB, S.contentA, S.contentB, S.chanA, S.chanB]) expect(json).toContain(sentinel);
    const refs = collectSnapshotSourceRefs(version.snapshot);
    expect(refs.analyticsRecords).toEqual(expect.arrayContaining([S.chanA, S.chanB, S.recA]));
    expect(version.sourceRefs).toEqual(expect.arrayContaining([{ type: "analyticsSourceRecord", ref: S.chanA }, { type: "analyticsSourceRecord", ref: S.chanB }]));
  });

  it("an actor with NO access sees none of the commercial sentinels, yet every count / variance / evaluation is identical to the global actor's", () => {
    const version = sentinelVersion();
    const none = redactVersionForActor(version, NO_SOURCE_ACCESS);
    const global = redactVersionForActor(version, fullSourceAccessFor(version.snapshot));

    const json = JSON.stringify(none);
    for (const sentinel of Object.values(S)) expect(json).not.toContain(sentinel);

    const stripRefs = (commercial: ActorCommercialEvidence) => ({
      ...commercial,
      monthlyDeliverable: { ...commercial.monthlyDeliverable, actualCountSources: commercial.monthlyDeliverable.actualCountSources ? { sourceType: commercial.monthlyDeliverable.actualCountSources.sourceType, unitCounts: commercial.monthlyDeliverable.actualCountSources.units.map((u) => u.unitCount) } : null },
      lfcSfc: { ...commercial.lfcSfc, units: commercial.lfcSfc.units.map((u) => ({ unitCount: u.unitCount, classification: u.classification, basis: u.basis })) },
      targets: commercial.targets.map((t) => ({ ...t, provenance: { ...t.provenance, refs: t.provenance.refs.length, redactedContext: undefined } })),
    });
    expect(stripRefs(none.snapshot.commercial)).toEqual(stripRefs(global.snapshot.commercial));

    // The results themselves are the canonical ones.
    expect(none.snapshot.commercial.monthlyDeliverable).toMatchObject({ requiredCount: 3, actualQualifyingCount: 3, variance: 0, evaluation: "met", affectsPayment: true });
    expect(none.snapshot.commercial.lfcSfc).toMatchObject({ status: "evaluated", sfcCount: 3, lfcCount: 0, unclassifiedCount: 0 });
    expect(none.snapshot.commercial.targets.map((t) => [t.targetRef, t.evaluation, t.actualValue])).toEqual([
      ["t-growth", "met", 100],
      ["t-likes", "met", 60],
    ]);
    expect(none.snapshot.commercial.governingAgreement).toEqual({ agreementRef: "agr-1", agreementVersion: 3 });
    expect(none.snapshot.commercial.lfcSfc.ruleRef).toBe("rule-1");
    // withheld markers, with the ref nulled
    expect(none.snapshot.commercial.monthlyDeliverable.actualCountSources!.units[0]).toMatchObject({ assignmentRef: null, contentRef: null, unitCount: 2, redactedContext: [{ sourceType: "assignment", redacted: true }, { sourceType: "content", redacted: true }] });
    expect(none.snapshot.commercial.targets[0]!.provenance).toMatchObject({ refs: [null, null], redactedContext: [{ sourceType: "analytics", redacted: true }] });
    // The global actor sees the refs.
    expect(global.snapshot.commercial.monthlyDeliverable.actualCountSources!.units.map((u) => u.assignmentRef)).toEqual([S.assignA, S.assignB]);
    expect(global.snapshot.commercial.targets[0]!.provenance.refs).toEqual([S.chanA, S.chanB]);
  });

  it("a partially-scoped actor sees exactly the accessible refs, decided per source type", () => {
    const view = redactVersionForActor(sentinelVersion(), { ...noAccessButAssignmentA, analyticsRecords: new Set([S.chanA]) });
    const units = view.snapshot.commercial.monthlyDeliverable.actualCountSources!.units;
    expect(units[0]).toMatchObject({ assignmentRef: S.assignA, contentRef: null, redactedContext: [{ sourceType: "content", redacted: true }] });
    expect(units[1]).toMatchObject({ assignmentRef: null, contentRef: null });
    expect(view.snapshot.commercial.targets[0]!.provenance.refs).toEqual([S.chanA, null]);
    const json = JSON.stringify(view);
    for (const hidden of [S.assignB, S.contentA, S.contentB, S.chanB, S.recA]) expect(json).not.toContain(hidden);
    expect(json).toContain(S.assignA);
    expect(json).toContain(S.chanA);
  });

  it("the itemKey on a unit pairs it with its Assignment's Production and Compliance rows", () => {
    const view = redactVersionForActor(sentinelVersion(), NO_SOURCE_ACCESS);
    const production = Object.fromEntries(view.snapshot.production.assignments.map((row) => [row.itemKey, row]));
    for (const unit of view.snapshot.commercial.monthlyDeliverable.actualCountSources!.units) expect(production[unit.itemKey]).toBeDefined();
    for (const unit of view.snapshot.commercial.lfcSfc.units) expect(production[unit.itemKey]).toBeDefined();
  });

  it("sourceRefs / withheldSourceCounts include the channel snapshot records (shown when accessible, counted when withheld)", () => {
    const version = sentinelVersion();
    const none = redactVersionForActor(version, NO_SOURCE_ACCESS);
    expect(none.sourceRefs).toEqual([]);
    expect(none.withheldSourceCounts).toEqual({ assignment: 2, content: 2, analyticsSourceRecord: 3, campaign: 1 });
    const full = redactVersionForActor(version, fullSourceAccessFor(version.snapshot));
    expect(full.withheldSourceCounts).toEqual({ assignment: 0, content: 0, analyticsSourceRecord: 0, campaign: 0 });
    expect(full.sourceRefs).toEqual(version.sourceRefs);
  });

  it("redaction never mutates the canonical stored section", () => {
    const version = sentinelVersion();
    const before = JSON.stringify(version);
    redactVersionForActor(version, NO_SOURCE_ACCESS);
    expect(JSON.stringify(version)).toBe(before);
  });
});

describe("type-level: the raw commercial section can never be returned as the actor-facing one", () => {
  it("CommercialEvidence is not assignable to ActorCommercialEvidence, and ActorEvidenceSnapshot['commercial'] is the actor type", () => {
    expectTypeOf<CommercialEvidence>().not.toMatchTypeOf<ActorCommercialEvidence>();
    expectTypeOf<ActorEvidenceSnapshot["commercial"]>().toEqualTypeOf<ActorCommercialEvidence>();
    expectTypeOf<PartnerReviewVersionDto["snapshot"]["commercial"]>().toEqualTypeOf<ActorCommercialEvidence>();

    const raw: CommercialEvidence = neutralCommercialEvidence();
    // @ts-expect-error - the canonical commercial section must not satisfy the actor-facing type.
    const notAllowed: ActorCommercialEvidence = raw;
    void notAllowed;

    const snapshot: EvidenceSnapshot = build().snapshot;
    // @ts-expect-error - a canonical snapshot (with its raw commercial section) is still not an actor-facing snapshot.
    const alsoNotAllowed: ActorEvidenceSnapshot = snapshot;
    void alsoNotAllowed;
    expect(true).toBe(true);
  });
});

// The builder is a pure function of its inputs: nothing hidden.
describe("buildCommercialEvidence is pure", () => {
  it("returns equal results for equal inputs and does not mutate them", () => {
    const built = build({ commercialPolicy: fullPolicy(), channelRecords: FULL_CHANNEL, analyticsRecords: [record("r1", { likes: 60 })] });
    const commercialInput = {
      partnerRef: "partner-1",
      period,
      policy: fullPolicy(),
      production: built.snapshot.production.assignments,
      records: built.snapshot.performance.records,
      assignmentsTruncated: false,
      analyticsTruncated: false,
      channelRecords: FULL_CHANNEL,
      channelScanTruncated: false,
    };
    const frozen = JSON.stringify(commercialInput);
    const a = buildCommercialEvidence(commercialInput);
    const b = buildCommercialEvidence(commercialInput);
    expect(a).toEqual(b);
    expect(a.commercial).toEqual(built.snapshot.commercial);
    expect(JSON.stringify(commercialInput)).toBe(frozen);
  });
});
