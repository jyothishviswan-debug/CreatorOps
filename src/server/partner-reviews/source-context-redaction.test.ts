import { describe, expect, expectTypeOf, it } from "vitest";

import type { ScopeGrant } from "@/server/authz/types";

import type { PartnerReviewVersionDto } from "./client-dto";
import { buildEvidence, type AnalyticsRecordSource, type AssignmentSource, type ContentThreadSource } from "./evidence-builder";
import { derivePeriod, reviewRefFor } from "./period";
import { evaluateSourceAccess, isAnalyticsSourceRecordInActorScope } from "./source-access";
import { collectSnapshotSourceRefs, fullSourceAccessFor, NO_SOURCE_ACCESS, redactVersionForActor, type ActorEvidenceSnapshot, type SourceAccess } from "./source-context-redaction";
import type { EvidenceSnapshot, PartnerReviewVersionDoc } from "./types";

// Step 13A.1: the pure source-context redaction + the pure access evaluator.

const period = derivePeriod("2026-03")!;
const AUDIT = { uid: "g", grantedAt: "2026-01-01T00:00:00.000Z", grantedBy: "seed" };

// Every identifying string carries a unique sentinel so a serialized-JSON
// search proves it is (or is not) present.
const S = {
  assignA: "SENTINEL-ASSIGN-A",
  assignB: "SENTINEL-ASSIGN-B",
  campA: "SENTINEL-CAMP-A",
  campB: "SENTINEL-CAMP-B",
  campNameA: "SENTINEL Campaign Name A",
  campNameB: "SENTINEL Campaign Name B",
  contentA: "SENTINEL-CONTENT-A",
  contentB: "SENTINEL-CONTENT-B",
  urlA: "https://instagram.com/p/sentinel-url-a",
  urlB: "https://instagram.com/p/sentinel-url-b",
  srcA: "SENTINEL-SRC-A",
  srcB: "SENTINEL-SRC-B",
  batchA: "SENTINEL-BATCH-A",
  batchB: "SENTINEL-BATCH-B",
  sheetA: "SENTINEL-SHEET-A",
  sheetB: "SENTINEL-SHEET-B",
  acctA: "SENTINEL-ACCT-A",
  acctB: "SENTINEL-ACCT-B",
};

function assignment(ref: string, campaignRef: string, campaignName: string, dueAt: string): AssignmentSource {
  return {
    assignmentRef: ref,
    campaignRef,
    status: "IN_PROGRESS",
    version: 2,
    createdAt: "2026-01-10T08:00:00.000Z",
    updatedAt: "2026-02-01T08:00:00.000Z",
    brief: { campaignName, dueAt, requiredCount: 2, formats: ["reel"], platforms: ["instagram"] },
  };
}

function thread(contentRef: string, assignmentRef: string, url: string): ContentThreadSource {
  return {
    contentRef,
    assignmentRef,
    version: 3,
    status: "APPROVED",
    currentRevisionNumber: 2,
    currentLinks: [{ platform: "instagram", originalUrl: `${url}?x=1`, normalizedUrl: url, recordedAt: "2026-03-08T10:00:00.000Z" }],
    openedAt: "2026-03-01T00:00:00.000Z",
    firstSubmittedAt: "2026-03-05T10:00:00.000Z",
    lastSubmittedAt: "2026-03-08T10:00:00.000Z",
    approvedAt: "2026-03-09T10:00:00.000Z",
    cancelledAt: null,
    updatedAt: "2026-03-09T10:00:00.000Z",
  };
}

function analytics(sourceRef: string, batchRef: string, sheetName: string, row: number, url: string, contentRef: string, assignmentRef: string, campaignRef: string, accountRef: string, likes: number): AnalyticsRecordSource {
  return {
    sourceRef,
    batchRef,
    sheetName,
    sourceRowNumber: row,
    platform: "instagram",
    normalizedUrl: url,
    postDateTimeIso: "2026-03-09T10:00:00.000Z",
    comments: null,
    likes,
    views: null,
    profileFollowers: null,
    engagement: null,
    reportingPeriod: { start: "2026-03-01", end: "2026-03-31" },
    matchState: "MATCHED",
    matchEvidence: { tier: "published_url", value: url, reasonCode: null, candidateCount: 1 },
    matchedContentRef: contentRef,
    matchedAssignmentRef: assignmentRef,
    matchedCampaignRef: campaignRef,
    matchedPartnerRef: "partner-1",
    matchedPartnerAccountRef: accountRef,
    correctionRevision: 1,
    createdAt: "2026-04-02T00:00:00.000Z",
  };
}

function versionDoc(): PartnerReviewVersionDoc {
  const built = buildEvidence({
    partnerRef: "partner-1",
    period,
    evidenceCutoff: "2026-05-01T00:00:00.000Z",
    assignments: [assignment(S.assignA, S.campA, S.campNameA, "2026-03-10"), assignment(S.assignB, S.campB, S.campNameB, "2026-03-12")],
    assignmentScanTruncated: false,
    assignmentsScanned: 2,
    threads: [thread(S.contentA, S.assignA, S.urlA), thread(S.contentB, S.assignB, S.urlB)],
    analyticsRecords: [
      analytics(S.srcA, S.batchA, S.sheetA, 7341, S.urlA, S.contentA, S.assignA, S.campA, S.acctA, 111),
      analytics(S.srcB, S.batchB, S.sheetB, 8842, S.urlB, S.contentB, S.assignB, S.campB, S.acctB, 222),
    ],
    analyticsScanTruncated: false,
    analyticsRecordsScanned: 2,
  });
  return {
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
    lastRefreshedAt: null,
    lastRefreshedByUserRef: null,
    submittedAt: null,
    submittedByUserRef: null,
    finalizedAt: null,
    finalizedByUserRef: null,
    supersededAt: null,
    supersededByVersion: null,
    statusReason: null,
    createdAt: "2026-05-01T00:00:00.000Z",
    createdByUserRef: "user-ref-1",
  };
}

const ALL_SENTINELS = Object.values(S);
const B_SENTINELS = [S.assignB, S.campB, S.campNameB, S.contentB, S.urlB, S.srcB, S.batchB, S.sheetB, S.acctB, '"sourceRowNumber":8842'];
const A_SENTINELS = [S.assignA, S.campA, S.campNameA, S.contentA, S.urlA, S.srcA, S.batchA, S.sheetA, S.acctA, '"sourceRowNumber":7341'];

// Access to everything A-shaped, nothing B-shaped.
function accessOnlyA(): SourceAccess {
  return { assignments: new Set([S.assignA]), campaigns: new Set([S.campA]), contents: new Set([S.contentA]), analyticsRecords: new Set([S.srcA]) };
}

describe("redactVersionForActor - sentinel contract (no out-of-scope identifier ever reaches the DTO JSON)", () => {
  it("an actor with NO access sees none of the sentinels; a full-access actor sees all of them", () => {
    const doc = versionDoc();
    const none = JSON.stringify(redactVersionForActor(doc, NO_SOURCE_ACCESS));
    for (const sentinel of [...ALL_SENTINELS, '"sourceRowNumber":7341', '"sourceRowNumber":8842']) expect(none).not.toContain(sentinel);

    const full = JSON.stringify(redactVersionForActor(doc, fullSourceAccessFor(doc.snapshot)));
    for (const sentinel of [...A_SENTINELS, ...B_SENTINELS]) expect(full).toContain(sentinel);
  });

  it("a partially-scoped actor sees exactly the accessible source's context and none of the other's", () => {
    const json = JSON.stringify(redactVersionForActor(versionDoc(), accessOnlyA()));
    for (const sentinel of A_SENTINELS) expect(json).toContain(sentinel);
    for (const sentinel of B_SENTINELS) expect(json).not.toContain(sentinel);
  });

  it("the raw stored snapshot's sentinels are never introduced by the builder for a redacted actor even inside markers or keys", () => {
    const view = redactVersionForActor(versionDoc(), NO_SOURCE_ACCESS);
    // Keys and marker values are neutral vocabulary only.
    const markerTypes = new Set<string>();
    for (const item of [...view.snapshot.production.assignments, ...view.snapshot.compliance.assignments, ...view.snapshot.performance.records]) for (const m of item.redactedContext) markerTypes.add(`${m.sourceType}:${m.redacted}`);
    expect([...markerTypes].sort()).toEqual(["analytics:true", "assignment:true", "campaign:true", "content:true"]);
  });
});

describe("redactVersionForActor - canonical aggregates stay identical for every actor", () => {
  it("totals, presence counts, completeness, reasons, period and cutoff are unchanged by redaction", () => {
    const doc = versionDoc();
    const canonical = doc.snapshot;
    for (const access of [NO_SOURCE_ACCESS, accessOnlyA(), fullSourceAccessFor(canonical)]) {
      const { snapshot } = redactVersionForActor(doc, access);
      expect(snapshot.completeness).toEqual(canonical.completeness);
      expect(snapshot.performance.metricPresence).toEqual(canonical.performance.metricPresence);
      expect(snapshot.performance.unavailableMetrics).toEqual(canonical.performance.unavailableMetrics);
      expect(snapshot.performance.latestImportedAt).toBe(canonical.performance.latestImportedAt);
      expect([snapshot.partnerRef, snapshot.periodKey, snapshot.periodStart, snapshot.periodEnd, snapshot.evidenceCutoff, snapshot.schemaVersion]).toEqual([
        canonical.partnerRef,
        canonical.periodKey,
        canonical.periodStart,
        canonical.periodEnd,
        canonical.evidenceCutoff,
        canonical.schemaVersion,
      ]);
      expect(snapshot.production.assignments).toHaveLength(canonical.production.assignments.length);
      expect(snapshot.compliance.assignments).toHaveLength(canonical.compliance.assignments.length);
      expect(snapshot.performance.records).toHaveLength(canonical.performance.records.length);
    }
  });

  it("the sanitized evidence of a redacted row (statuses, timestamps, counts, booleans, metric values, platform) is preserved", () => {
    const doc = versionDoc();
    const { snapshot } = redactVersionForActor(doc, NO_SOURCE_ACCESS);
    const canonical = doc.snapshot;

    snapshot.production.assignments.forEach((row, i) => {
      const source = canonical.production.assignments[i]!;
      expect(row).toMatchObject({ status: source.status, dueAt: source.dueAt, eventDate: source.eventDate, eventDateSource: source.eventDateSource, requiredCount: source.requiredCount, formats: source.formats, platforms: source.platforms, createdAt: source.createdAt, completed: source.completed, cancelled: source.cancelled });
      expect(row.thread).toMatchObject({ status: source.thread!.status, currentRevisionNumber: source.thread!.currentRevisionNumber, firstSubmittedAt: source.thread!.firstSubmittedAt, approvedAt: source.thread!.approvedAt, linkCount: source.thread!.linkCount, linkPlatforms: source.thread!.linkPlatforms, revisionRequestCount: source.thread!.revisionRequestCount });
      expect(row.thread!.links).toBeNull();
    });
    snapshot.compliance.assignments.forEach((row, i) => {
      const { assignmentRef: _ref, ...rest } = canonical.compliance.assignments[i]!;
      void _ref;
      expect(row).toMatchObject(rest);
    });
    snapshot.performance.records.forEach((row, i) => {
      const source = canonical.performance.records[i]!;
      expect(row.metrics).toEqual(source.metrics);
      expect(row).toMatchObject({ platform: source.platform, postDateTime: source.postDateTime, reportingPeriod: source.reportingPeriod });
      expect(row.provenance).toMatchObject({ correctionRevision: source.provenance.correctionRevision, matchState: source.provenance.matchState, importedAt: source.provenance.importedAt });
    });
  });

  it("redaction never mutates the stored (canonical) doc", () => {
    const doc = versionDoc();
    const before = JSON.stringify(doc);
    redactVersionForActor(doc, NO_SOURCE_ACCESS);
    redactVersionForActor(doc, accessOnlyA());
    expect(JSON.stringify(doc)).toBe(before);
  });
});

describe("redactVersionForActor - each source type is decided independently", () => {
  it("an accessible Assignment under an inaccessible Campaign shows the Assignment but removes campaignRef/campaignName", () => {
    const view = redactVersionForActor(versionDoc(), { ...NO_SOURCE_ACCESS, assignments: new Set([S.assignA]) });
    const row = view.snapshot.production.assignments.find((r) => r.assignmentRef === S.assignA)!;
    expect(row).toMatchObject({ assignmentRef: S.assignA, campaignRef: null, campaignName: null });
    expect(row.redactedContext).toEqual([
      { sourceType: "campaign", redacted: true },
      { sourceType: "content", redacted: true },
    ]);
    expect(JSON.stringify(view)).not.toContain(S.campNameA);
    expect(JSON.stringify(view)).not.toContain(S.campA);
  });

  it("an inaccessible Assignment never exposes its Campaign linkage, even when that Campaign is itself accessible", () => {
    const view = redactVersionForActor(versionDoc(), { ...NO_SOURCE_ACCESS, campaigns: new Set([S.campA, S.campB]) });
    for (const row of view.snapshot.production.assignments) expect(row).toMatchObject({ assignmentRef: null, campaignRef: null, campaignName: null });
    expect(view.sourceRefs).toEqual([]);
    expect(view.withheldSourceCounts).toEqual({ assignment: 2, campaign: 2, content: 2, analyticsSourceRecord: 2 });
  });

  it("inaccessible Content withholds contentRef and the link URLs but keeps link counts/platforms and thread status", () => {
    const view = redactVersionForActor(versionDoc(), { ...fullSourceAccessFor(versionDoc().snapshot), contents: new Set() });
    for (const row of view.snapshot.production.assignments) {
      expect(row.thread).toMatchObject({ contentRef: null, links: null, linkCount: 1, linkPlatforms: ["instagram"], status: "APPROVED" });
      expect(row.redactedContext).toEqual([{ sourceType: "content", redacted: true }]);
    }
    // (An Analytics record the actor may access keeps its own matched refs / post URL - exactly what the
    // Analytics explorer already shows that actor - so only the Production/Compliance rows are scanned here.)
    const json = JSON.stringify({ production: view.snapshot.production, compliance: view.snapshot.compliance });
    expect(json).not.toContain(S.contentA);
    expect(json).not.toContain(S.contentB);
    expect(json).not.toContain(S.urlA);
    expect(json).not.toContain(S.urlB);
    expect(view.sourceRefs.some((ref) => ref.type === "content")).toBe(false);
  });

  it("inaccessible Analytics withholds every identifying provenance field but keeps values and platform", () => {
    const view = redactVersionForActor(versionDoc(), { ...fullSourceAccessFor(versionDoc().snapshot), analyticsRecords: new Set() });
    for (const record of view.snapshot.performance.records) {
      expect(record).toMatchObject({ sourceRecordRef: null, matchedContentRef: null, matchedAssignmentRef: null, matchedCampaignRef: null, matchedPartnerAccountRef: null, postUrl: null, platform: "instagram" });
      expect(record.provenance).toMatchObject({ batchRef: null, sheetName: null, sourceRowNumber: null, matchState: "MATCHED" });
      expect(record.redactedContext).toEqual([{ sourceType: "analytics", redacted: true }]);
    }
    expect(view.snapshot.performance.records.map((r) => r.metrics.likes)).toEqual([111, 222]);
  });
});

describe("redactVersionForActor - sourceRefs, withheld counts and item keys", () => {
  it("sourceRefs lists only refs that survive redaction; withheldSourceCounts covers the rest per type", () => {
    const doc = versionDoc();
    const only = redactVersionForActor(doc, accessOnlyA());
    expect(only.sourceRefs).toEqual([
      { type: "analyticsSourceRecord", ref: S.srcA },
      { type: "assignment", ref: S.assignA },
      { type: "campaign", ref: S.campA },
      { type: "content", ref: S.contentA },
    ]);
    expect(only.withheldSourceCounts).toEqual({ assignment: 1, campaign: 1, content: 1, analyticsSourceRecord: 1 });
    expect(only.snapshot.sourceRefs).toEqual(only.sourceRefs);

    const full = redactVersionForActor(doc, fullSourceAccessFor(doc.snapshot));
    expect(full.sourceRefs).toEqual(doc.sourceRefs);
    expect(full.withheldSourceCounts).toEqual({ assignment: 0, campaign: 0, content: 0, analyticsSourceRecord: 0 });

    const none = redactVersionForActor(doc, NO_SOURCE_ACCESS);
    expect(none.sourceRefs).toEqual([]);
    expect(none.withheldSourceCounts).toEqual({ assignment: 2, campaign: 2, content: 2, analyticsSourceRecord: 2 });
  });

  it("itemKey pairs a Production row with its Compliance row and is a per-response random key never derived from the real ref", () => {
    const doc = versionDoc();
    const first = redactVersionForActor(doc, NO_SOURCE_ACCESS);
    const second = redactVersionForActor(doc, NO_SOURCE_ACCESS);

    first.snapshot.production.assignments.forEach((row, i) => expect(row.itemKey).toBe(first.snapshot.compliance.assignments[i]!.itemKey));
    const keys = [...first.snapshot.production.assignments.map((r) => r.itemKey), ...first.snapshot.performance.records.map((r) => r.itemKey)];
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) for (const sentinel of ALL_SENTINELS) expect(key).not.toContain(sentinel);

    // Not stable across responses.
    expect(second.snapshot.production.assignments[0]!.itemKey).not.toBe(first.snapshot.production.assignments[0]!.itemKey);

    // Deterministic when a generator is injected (test seam only).
    let n = 0;
    const seeded = redactVersionForActor(doc, NO_SOURCE_ACCESS, { newItemKey: () => `k${++n}` });
    expect(seeded.snapshot.production.assignments.map((r) => r.itemKey)).toEqual(["k1", "k2"]);
    expect(seeded.snapshot.compliance.assignments.map((r) => r.itemKey)).toEqual(["k1", "k2"]);
    expect(seeded.snapshot.performance.records.map((r) => r.itemKey)).toEqual(["k3", "k4"]);
  });
});

describe("type-level: the raw stored snapshot can never be returned as an actor-facing snapshot", () => {
  it("EvidenceSnapshot is not assignable to ActorEvidenceSnapshot / PartnerReviewVersionDto['snapshot']", () => {
    expectTypeOf<EvidenceSnapshot>().not.toMatchTypeOf<ActorEvidenceSnapshot>();
    expectTypeOf<EvidenceSnapshot>().not.toMatchTypeOf<PartnerReviewVersionDto["snapshot"]>();
    expectTypeOf<PartnerReviewVersionDto["snapshot"]>().toEqualTypeOf<ActorEvidenceSnapshot>();

    const raw = versionDoc().snapshot;
    // @ts-expect-error - the canonical snapshot must not satisfy the actor-facing snapshot type.
    const notAllowed: ActorEvidenceSnapshot = raw;
    void notAllowed;
    expect(true).toBe(true);
  });
});

// ---- The pure access evaluator ----------------------------------------------------------------------------

describe("evaluateSourceAccess (pure)", () => {
  const regionGrant = (region: string): ScopeGrant => ({ type: "REGION", region, ...AUDIT });
  const teamGrant = (teamId: string): ScopeGrant => ({ type: "TEAM", teamId, ...AUDIT });
  const global: ScopeGrant = { type: "GLOBAL", ...AUDIT };

  const refs = { assignments: ["as-1", "as-2"], campaigns: ["camp-1", "camp-2"], contents: ["ct-1"], analyticsRecords: ["src-1", "src-2"] };
  const scoped = (uid: string, regionIds: string[], teamIds: string[] = [], ownerUid: string | null = null) => ({ uid, ownerUid, regionIds, teamIds });
  const docs = {
    campaignDocs: new Map([
      ["camp-1", scoped("c1", ["Kerala"])],
      ["camp-2", scoped("c2", ["Karnataka"])],
    ]),
    assignmentDocs: new Map([
      ["as-1", scoped("a1", ["Kerala"])],
      ["as-2", scoped("a2", ["Karnataka"])],
    ]),
    contentDocs: new Map([["ct-1", scoped("t1", ["Kerala"])]]),
    analyticsDocs: new Map([
      ["src-1", { ownerUid: null, regionIds: ["Kerala"], teamIds: [] }],
      ["src-2", { ownerUid: null, regionIds: ["Karnataka"], teamIds: [] }],
    ]),
  };
  const allFeatures = { campaigns: true, assignments: true, content: true, analyticsExplore: true };
  const base = { actorUid: "me", refs, ...docs };

  it("grants access per record through the accepted scope dimensions, each source type on its own", () => {
    const access = evaluateSourceAccess({ ...base, grants: [regionGrant("Kerala")], features: allFeatures });
    expect([...access.campaigns]).toEqual(["camp-1"]);
    expect([...access.assignments]).toEqual(["as-1"]);
    expect([...access.contents]).toEqual(["ct-1"]);
    expect([...access.analyticsRecords]).toEqual(["src-1"]);
  });

  it("the feature/action gate is required first: a scope match without the feature yields nothing for that source type", () => {
    const access = evaluateSourceAccess({ ...base, grants: [regionGrant("Kerala")], features: { campaigns: true, assignments: false, content: false, analyticsExplore: false } });
    expect([...access.campaigns]).toEqual(["camp-1"]);
    expect(access.assignments.size + access.contents.size + access.analyticsRecords.size).toBe(0);
  });

  it("GLOBAL scope reaches every ref (even one with no loadable doc) but still requires the feature", () => {
    const access = evaluateSourceAccess({ ...base, grants: [global], features: { ...allFeatures, content: false }, campaignDocs: new Map(), assignmentDocs: new Map(), analyticsDocs: new Map() });
    expect([...access.campaigns].sort()).toEqual(["camp-1", "camp-2"]);
    expect([...access.assignments].sort()).toEqual(["as-1", "as-2"]);
    expect([...access.analyticsRecords].sort()).toEqual(["src-1", "src-2"]);
    expect(access.contents.size).toBe(0);
  });

  it("a non-global actor is denied a ref whose document could not be loaded (fail closed) and a grantless actor sees nothing", () => {
    const missing = evaluateSourceAccess({ ...base, grants: [regionGrant("Kerala")], features: allFeatures, campaignDocs: new Map(), assignmentDocs: new Map(), contentDocs: new Map(), analyticsDocs: new Map() });
    expect(missing.campaigns.size + missing.assignments.size + missing.contents.size + missing.analyticsRecords.size).toBe(0);
    const none = evaluateSourceAccess({ ...base, grants: [], features: allFeatures });
    expect(none.campaigns.size + none.assignments.size + none.contents.size + none.analyticsRecords.size).toBe(0);
  });

  it("Campaign/Assignment/Content honor SELF ownership and TEAM scope exactly as their accepted gates do", () => {
    const self: ScopeGrant = { type: "SELF", ...AUDIT };
    const access = evaluateSourceAccess({
      ...base,
      grants: [self, teamGrant("t-1")],
      features: allFeatures,
      campaignDocs: new Map([["camp-1", scoped("c1", ["Elsewhere"], [], "me")], ["camp-2", scoped("c2", ["Elsewhere"], ["t-1"])]]),
      assignmentDocs: new Map([["as-1", scoped("a1", [], [], "someone-else")], ["as-2", scoped("a2", [], ["t-1"])]]),
    });
    expect([...access.campaigns].sort()).toEqual(["camp-1", "camp-2"]);
    expect([...access.assignments]).toEqual(["as-2"]);
  });

  it("an EXPLICIT_RECORD grant reaches Campaign/Assignment/Content (as their gates allow) but NEVER an Analytics source record", () => {
    const explicit = (resourceType: string, resourceId: string): ScopeGrant => ({ type: "EXPLICIT_RECORD", resourceType, resourceId, ...AUDIT });
    const access = evaluateSourceAccess({
      ...base,
      grants: [explicit("campaign", "c2"), explicit("assignment", "a2"), explicit("content", "t1"), explicit("analytics_source_record", "src-2")],
      features: allFeatures,
      contentDocs: new Map([["ct-1", scoped("t1", ["Elsewhere"])]]),
    });
    expect([...access.campaigns]).toEqual(["camp-2"]);
    expect([...access.assignments]).toEqual(["as-2"]);
    expect([...access.contents]).toEqual(["ct-1"]);
    expect(access.analyticsRecords.size).toBe(0);
  });
});

describe("isAnalyticsSourceRecordInActorScope (in-memory twin of the explorer's scope plan)", () => {
  const self: ScopeGrant = { type: "SELF", ...AUDIT };
  const region = (r: string): ScopeGrant => ({ type: "REGION", region: r, ...AUDIT });
  const team = (t: string): ScopeGrant => ({ type: "TEAM", teamId: t, ...AUDIT });
  const rec = (over: Partial<{ ownerUid: string | null; regionIds: string[]; teamIds: string[] }> = {}) => ({ ownerUid: null, regionIds: [], teamIds: [], ...over });

  it("GLOBAL, SELF (owner match + SELF grant), REGION and TEAM only; unresolved rows (no scope evidence) are GLOBAL-only", () => {
    expect(isAnalyticsSourceRecordInActorScope([{ type: "GLOBAL", ...AUDIT }], "me", rec())).toBe(true);
    expect(isAnalyticsSourceRecordInActorScope([self], "me", rec({ ownerUid: "me" }))).toBe(true);
    expect(isAnalyticsSourceRecordInActorScope([], "me", rec({ ownerUid: "me" }))).toBe(false);
    expect(isAnalyticsSourceRecordInActorScope([self], "me", rec({ ownerUid: "other" }))).toBe(false);
    expect(isAnalyticsSourceRecordInActorScope([region("Kerala")], "me", rec({ regionIds: ["Goa", "Kerala"] }))).toBe(true);
    expect(isAnalyticsSourceRecordInActorScope([team("t-1")], "me", rec({ teamIds: ["t-1"] }))).toBe(true);
    expect(isAnalyticsSourceRecordInActorScope([region("Kerala"), team("t-1"), self], "me", rec())).toBe(false);
  });

  it("does not honor CAMPAIGN / PARTNER / EXPLICIT_RECORD / ANALYTICS_DATASET grants (the explorer has no such branch)", () => {
    const others: ScopeGrant[] = [
      { type: "CAMPAIGN", campaignId: "c1", ...AUDIT },
      { type: "PARTNER", partnerId: "p1", ...AUDIT },
      { type: "EXPLICIT_RECORD", resourceType: "analytics", resourceId: "r1", ...AUDIT },
      { type: "ANALYTICS_DATASET", datasetId: "d1", ...AUDIT },
    ];
    expect(isAnalyticsSourceRecordInActorScope(others, "me", rec({ regionIds: ["Kerala"], teamIds: ["t-1"] }))).toBe(false);
  });

  it("mirrors the planner's own cap of 30 distinct granted values per dimension", () => {
    const grants = Array.from({ length: 31 }, (_, i) => region(`R${String(i).padStart(2, "0")}`));
    expect(isAnalyticsSourceRecordInActorScope(grants, "me", rec({ regionIds: ["R29"] }))).toBe(true);
    expect(isAnalyticsSourceRecordInActorScope(grants, "me", rec({ regionIds: ["R30"] }))).toBe(false);
  });
});

describe("collectSnapshotSourceRefs", () => {
  it("returns the distinct refs per source type straight from the evidence items", () => {
    const refs = collectSnapshotSourceRefs(versionDoc().snapshot);
    expect(refs.assignments.sort()).toEqual([S.assignA, S.assignB]);
    expect(refs.campaigns.sort()).toEqual([S.campA, S.campB]);
    expect(refs.contents.sort()).toEqual([S.contentA, S.contentB]);
    expect(refs.analyticsRecords.sort()).toEqual([S.srcA, S.srcB]);
  });
});
