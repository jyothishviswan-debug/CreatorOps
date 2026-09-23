// Step 13A - real reads/writes against the running Firestore/Auth emulator
// (no mocks): the Partner Reviews evidence backend. Run with
// `pnpm test:emulator` against a running `pnpm firebase:emulators`.
//
// Hermetic by construction: every test builds its own Partner (unique uid/
// ref) and its own Assignment/Content/Analytics fixtures under unique past
// reporting months, all written schema-valid via the Admin SDK (never
// through a shared seed), and every fixture doc is deleted afterwards.
// Fixture Assignments/Content/Analytics carry a private region that no
// seeded actor except GLOBAL holds, so nothing here can leak into another
// file's scoped reads.
import { randomUUID } from "node:crypto";

import { FieldValue } from "firebase-admin/firestore";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { analyticsChannelSourceRecordsCollection, analyticsContentSourceRecordsCollection } from "@/server/analytics/firestore";
import { resolveAnalyticsSourceRecordMatch } from "@/server/analytics/correction-service";
import { listAnalyticsSourceRecords } from "@/server/analytics/explorer-service";
import { requireAnalyticsExploreAccess } from "@/server/analytics/analytics-gate";
import { analyticsChannelSourceRecordDocSchema, analyticsContentSourceRecordDocSchema } from "@/server/analytics/types";
import { requireAssignmentInScope, requireAssignmentsFeatureAccess } from "@/server/assignments/assignments-gate";
import { assignmentsCollection } from "@/server/assignments/firestore";
import { assignmentBriefSchema, assignmentDocSchema } from "@/server/assignments/types";
import { seedEmulatorTestUsers } from "@/server/auth/seed-users";
import { resolveActor } from "@/server/authz/actor";
import { canPerformAction } from "@/server/authz/capabilities";
import { COLLECTIONS } from "@/server/authz/firestore";
import { MODULE_ACTIONS } from "@/server/authz/module-actions";
import { seedAccessControlData, TEST_IDENTITIES } from "@/server/authz/seed-access-data";
import type { ActorContext } from "@/server/authz/types";
import { campaignsCollection } from "@/server/campaigns/firestore";
import { requireCampaignInScope, requireCampaignsFeatureAccess } from "@/server/campaigns/campaigns-gate";
import { campaignDocSchema } from "@/server/campaigns/types";
import { requireContentFeatureAccess, requireContentInScope } from "@/server/content/content-gate";
import { contentCollection } from "@/server/content/firestore";
import { contentDocSchema } from "@/server/content/types";
import { getAdminAuth, getAdminFirestore } from "@/server/firebase/admin";
import { partnersCollection } from "@/server/partners/firestore";
import { seedPartnersData } from "@/server/partners/seed-partners-data";
import { partnerDocSchema, type PartnerDoc } from "@/server/partners/types";

import { neutralCommercialEvidence } from "./commercial-neutral";
import { setCommercialPolicyProviderForTests, type GoverningCommercialPolicy } from "./commercial-policy";
import { PERFORMANCE_METRIC_IDS } from "./evidence-builder";
import * as evidenceCollector from "./evidence-collector";
import { getFinalizedReviewHandoff, getReviewVersionCurrency } from "./finalized-review-handoff-service";
import { toPartnerReviewsHttpResponse } from "./http";
import { PARTNER_REVIEWS_COLLECTIONS, partnerReviewEventsCollection, partnerReviewsCollection, partnerReviewVersionsCollection, type PartnerReviewListCursor } from "./firestore";
import { createPartnerReviewRevision, finalizePartnerReview, submitPartnerReviewForReview } from "./partner-review-lifecycle-service";
import {
  deriveNeedsReview,
  generatePartnerReviewDraft,
  getPartnerReview,
  getPartnerReviewVersion,
  inspectPartnerReviewFreshness,
  listPartnerReviewHeads,
  refreshPartnerReviewEvidence,
} from "./partner-review-service";
import { reviewRefFor } from "./period";
import { resolveActorSourceAccess } from "./source-access";
import { PARTNER_REVIEW_EVENT_KINDS, type EvidenceSnapshot } from "./types";

// The finalized-review handoff route is exercised at handler level: only the
// session lookup is replaced (so the test can name the acting user); the real
// route, service, authz chain and Firestore are all used. Same idiom as
// campaigns/assignment-integrity.emulator.test.ts.
let httpActor: ActorContext | null = null;
vi.mock("@/server/administration/http", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/administration/http")>();
  return { ...original, resolveRequestActor: async () => httpActor };
});
import { GET as getHandoffRoute } from "@/app/api/partner-reviews/[reviewRef]/handoff/route";

// Multi-step review flows plus transaction-contention retries in the
// emulator can exceed vitest's 5s default on a loaded machine - a longer
// per-test budget, never a weaker assertion.
vi.setConfig({ testTimeout: 30_000 });

const uidByRole = new Map<string, string>();
const runId = Date.now();
// A region no seeded actor holds except GLOBAL (Super Admin) - fixture
// Assignments/Content/Analytics use it so no other file's scoped read can see them.
const PRIVATE_REGION = `pr-private-${runId}`;

beforeAll(async () => {
  const password = process.env.EMULATOR_TEST_USER_PASSWORD;
  if (!password) throw new Error("EMULATOR_TEST_USER_PASSWORD is not set - check .env.local. Requires a running Firebase emulator.");
  await seedEmulatorTestUsers(password);
  await seedAccessControlData();
  await seedPartnersData();

  const auth = getAdminAuth();
  for (const identity of TEST_IDENTITIES) {
    const user = await auth.getUserByEmail(identity.email);
    uidByRole.set(identity.role, user.uid);
  }
}, 30_000);

async function actorFor(role: string): Promise<ActorContext> {
  const uid = uidByRole.get(role);
  if (!uid) throw new Error(`No seeded uid for role ${role}`);
  const actor = await resolveActor(uid);
  if (!actor) throw new Error(`resolveActor returned null for seeded role ${role}`);
  return actor;
}

// ---- Fixture bookkeeping ---------------------------------------------------------------

const cleanup: FirebaseFirestore.DocumentReference[] = [];
const analyticsCleanup: FirebaseFirestore.DocumentReference[] = [];
// Step 13A.1: fixtures that a seeded actor (via the shared Kerala region) can
// see are removed right after each test, like the Analytics fixtures, so
// their window of visibility to other files' scoped reads stays minimal.
const transientCleanup: FirebaseFirestore.DocumentReference[] = [];
const reviewRefsToClean = new Set<string>();

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(transientCleanup.splice(0).map((ref) => ref.delete()));
  // Analytics fixtures are removed right after each test so their window
  // of visibility to other files' global reads stays as short as possible.
  await Promise.all(
    analyticsCleanup.splice(0).map(async (ref) => {
      const corrections = await ref.collection("corrections").get();
      await Promise.all(corrections.docs.map((d) => d.ref.delete()));
      await ref.delete();
    }),
  );
});

afterAll(async () => {
  await Promise.all(cleanup.splice(0).map((ref) => ref.delete()));
  for (const reviewRef of reviewRefsToClean) {
    const head = partnerReviewsCollection().doc(reviewRef);
    for (const sub of [PARTNER_REVIEWS_COLLECTIONS.versions, PARTNER_REVIEWS_COLLECTIONS.events]) {
      const docs = await head.collection(sub).get();
      await Promise.all(docs.docs.map((d) => d.ref.delete()));
    }
    await head.delete();
  }
});

let partnerCounter = 0;

async function seedPartner(over: { regionIds?: string[]; teamIds?: string[]; ownerUid?: string | null } = {}): Promise<PartnerDoc> {
  partnerCounter += 1;
  const uid = `pr-test-partner-${runId}-${partnerCounter}-${randomUUID().slice(0, 6)}`;
  const now = new Date().toISOString();
  const partner = partnerDocSchema.parse({
    uid,
    partnerRef: uid,
    version: 1,
    displayName: `PR Test Partner ${partnerCounter}`,
    displayNameLower: `pr test partner ${partnerCounter}`,
    legalName: null,
    status: "ACTIVE",
    previousStatus: null,
    statusReason: null,
    regionIds: over.regionIds ?? ["Kerala"],
    languageIds: [],
    categoryIds: [],
    tier: null,
    priority: null,
    targetAudience: [],
    email: `${uid}@example-partner.test`,
    phone: "+91 90000 00099",
    ownerUid: over.ownerUid ?? null,
    teamIds: over.teamIds ?? [],
    originLeadRefs: [],
    sourceDiscovery: null,
    pendingPartnerAccountSetup: false,
    sequenceNumber: null,
    createdAt: now,
    createdByUserRef: "pr-test",
    updatedAt: now,
    updatedByUserRef: "pr-test",
  });
  const ref = partnersCollection().doc(uid);
  await ref.set(partner);
  cleanup.push(ref);
  return partner;
}

async function seedAssignment(
  partnerRef: string,
  over: { dueAt?: string | null; status?: string; createdAt?: string; campaignName?: string; requiredCount?: number; campaignRef?: string; regionIds?: string[]; transient?: boolean } = {},
) {
  const uid = assignmentsCollection().doc().id;
  const now = new Date().toISOString();
  const assignment = assignmentDocSchema.parse({
    uid,
    assignmentRef: `pr-test-as-${uid}`,
    version: 1,
    campaignRef: over.campaignRef ?? `pr-test-camp-${runId}`,
    partnerRef,
    partnerAccountRefs: [],
    status: over.status ?? "IN_PROGRESS",
    statusReason: over.status === "CANCELLED" ? "test" : null,
    brief: assignmentBriefSchema.parse({
      dueAt: over.dueAt === undefined ? "2019-03-10" : over.dueAt,
      requiredCount: over.requiredCount ?? 2,
      formats: ["reel"],
      platforms: ["instagram"],
      reviewPolicy: "REVIEW_REQUIRED",
      campaignName: over.campaignName ?? "PR Test Campaign",
    }),
    ownerUid: null,
    regionIds: over.regionIds ?? [PRIVATE_REGION],
    teamIds: [],
    createdAt: over.createdAt ?? "2019-01-05T08:00:00.000Z",
    createdByUserRef: "pr-test",
    updatedAt: now,
    updatedByUserRef: "pr-test",
  });
  const ref = assignmentsCollection().doc(uid);
  await ref.set(assignment);
  (over.transient ? transientCleanup : cleanup).push(ref);
  return assignment;
}

async function seedThread(
  assignment: { assignmentRef: string; campaignRef: string; partnerRef: string },
  over: { status?: string; links?: number; revision?: number; approvedAt?: string | null; regionIds?: string[]; transient?: boolean } = {},
) {
  const uid = contentCollection().doc().id;
  const links = over.links ?? 1;
  const revision = over.revision ?? 1;
  const thread = contentDocSchema.parse({
    uid,
    contentRef: `pr-test-ct-${uid}`,
    version: 3,
    assignmentRef: assignment.assignmentRef,
    campaignRef: assignment.campaignRef,
    partnerRef: assignment.partnerRef,
    status: over.status ?? "UNDER_REVIEW",
    statusReason: null,
    currentRevisionNumber: revision,
    reviewedRevisionNumber: revision > 0 ? revision : null,
    currentLinks: Array.from({ length: links }, (_, i) => ({ platform: "instagram", originalUrl: `https://instagram.com/p/PR${uid}${i}`, normalizedUrl: `https://instagram.com/p/pr${uid.toLowerCase()}${i}`, recordedAt: "2019-03-08T10:00:00.000Z" })),
    qualifyingFulfillment: null,
    dueAt: null,
    openedAt: "2019-03-01T00:00:00.000Z",
    firstSubmittedAt: revision > 0 ? "2019-03-08T10:00:00.000Z" : null,
    lastSubmittedAt: revision > 0 ? "2019-03-08T10:00:00.000Z" : null,
    approvedAt: over.approvedAt ?? null,
    cancelledAt: null,
    ownerUid: null,
    regionIds: over.regionIds ?? [PRIVATE_REGION],
    teamIds: [],
    createdAt: "2019-03-01T00:00:00.000Z",
    createdByUserRef: "pr-test",
    updatedAt: "2019-03-08T10:00:00.000Z",
    updatedByUserRef: "pr-test",
  });
  const ref = contentCollection().doc(uid);
  await ref.set(thread);
  (over.transient ? transientCleanup : cleanup).push(ref);
  return thread;
}

async function seedAnalyticsRecord(
  partnerRef: string,
  over: {
    contentRef?: string | null;
    likes?: number | null;
    period?: { start: string; end: string } | null;
    regionIds?: string[];
    ownerUid?: string | null;
    batchRef?: string;
    sheetName?: string;
    sourceRowNumber?: number;
    matchedAssignmentRef?: string | null;
    matchedCampaignRef?: string | null;
  } = {},
) {
  const uid = `pr-test-an-${randomUUID()}`;
  const record = analyticsContentSourceRecordDocSchema.parse({
    uid,
    sourceRef: uid,
    batchRef: over.batchRef ?? `pr-test-batch-${runId}`,
    sheetName: over.sheetName ?? "Posts",
    sourceRowNumber: over.sourceRowNumber ?? 2,
    platform: "instagram",
    rowIdentityKey: `pr-test:${uid}`,
    rawPostId: null,
    rawPostUrl: "https://instagram.com/p/raw-secret-caption-source",
    rawPostType: null,
    rawPostDateTime: null,
    rawMediaUrl: null,
    rawCaption: "RAW CAPTION MUST NEVER LEAK",
    rawComments: null,
    rawLikes: "120",
    rawViews: null,
    rawFollowers: null,
    rawUsername: "rawusername",
    rawEngagement: null,
    rawAccountOrChannelName: null,
    normalizedUrl: "https://instagram.com/p/pr-analytics",
    postDateTimeIso: "2019-03-09T10:00:00.000Z",
    comments: null,
    likes: over.likes === undefined ? 120 : over.likes,
    views: null,
    profileFollowers: null,
    engagement: null,
    reportingPeriod: over.period === undefined ? { start: "2019-03-01", end: "2019-03-31" } : over.period,
    matchState: "MATCHED",
    matchEvidence: { tier: "published_url", value: "https://instagram.com/p/pr-analytics", reasonCode: null, candidateCount: 1 },
    matchedContentRef: over.contentRef ?? null,
    matchedAssignmentRef: over.matchedAssignmentRef ?? null,
    matchedCampaignRef: over.matchedCampaignRef ?? null,
    matchedPartnerRef: partnerRef,
    matchedPartnerAccountRef: null,
    ownerUid: over.ownerUid ?? null,
    regionIds: over.regionIds ?? [PRIVATE_REGION],
    teamIds: [],
    createdAt: "2019-04-02T00:00:00.000Z",
  });
  const ref = analyticsContentSourceRecordsCollection().doc(uid);
  await ref.set(record);
  analyticsCleanup.push(ref);
  return record;
}

// A real, schema-valid Campaign doc (Step 13A.1: Campaign scope is decided from the LIVE Campaign
// record, so the scope tests need genuine Campaigns). Transient: deleted right after the test.
async function seedCampaign(over: { name: string; regionIds: string[]; teamIds?: string[]; ownerUid?: string | null }) {
  const uid = campaignsCollection().doc().id;
  const now = new Date().toISOString();
  const campaign = campaignDocSchema.parse({
    uid,
    campaignRef: `pr-test-camp-doc-${uid}`,
    version: 1,
    name: over.name,
    nameLower: over.name.toLowerCase(),
    objective: "Step 13A.1 scope fixture",
    status: "ACTIVE",
    statusReason: null,
    platforms: [],
    startDate: "2019-01-01",
    endDate: "2019-12-31",
    regionIds: over.regionIds,
    ownerUid: over.ownerUid ?? null,
    teamIds: over.teamIds ?? [],
    criteria: { targetAudience: [], regionIds: [], languageIds: [], categoryIds: [], platforms: [] },
    resources: [],
    defaultReviewPolicy: "REVIEW_REQUIRED",
    createdAt: now,
    createdByUserRef: "pr-test",
    updatedAt: now,
    updatedByUserRef: "pr-test",
  });
  const ref = campaignsCollection().doc(uid);
  await ref.set(campaign);
  transientCleanup.push(ref);
  return campaign;
}

// A Partner with one in-period (2019-03) Assignment, its Content thread and
// one matched Analytics record (likes reported, everything else missing).
async function seedRichPartner(over: { regionIds?: string[] } = {}) {
  const partner = await seedPartner(over);
  const assignment = await seedAssignment(partner.partnerRef);
  const thread = await seedThread(assignment);
  const record = await seedAnalyticsRecord(partner.partnerRef, { contentRef: thread.contentRef });
  return { partner, assignment, thread, record };
}

async function generateFor(actor: ActorContext, partnerRef: string, periodKey = "2019-03") {
  const result = await generatePartnerReviewDraft(actor, { partnerRef, periodKey }, "req-generate");
  if (!result.ok) throw new Error(`generate failed: ${result.code} ${result.message}`);
  reviewRefsToClean.add(result.data.review.head.reviewRef);
  return result.data;
}

async function rawDoc(ref: FirebaseFirestore.DocumentReference): Promise<string> {
  const snap = await ref.get();
  return JSON.stringify(snap.data() ?? null);
}

// Step 13B: the head's best-effort `freshnessHint` (a single-field list projection, written when the trusted
// backend has ALREADY computed freshness - see freshness-hint.ts) is the one field a READ may add or change on
// the head. Everything else on the head - docVersion, updatedAt, pointers, display, scope snapshot - must stay
// byte-identical across reads, which is what the head comparisons below still assert.
async function rawHeadDoc(ref: FirebaseFirestore.DocumentReference): Promise<string> {
  const snap = await ref.get();
  const { freshnessHint, ...rest } = (snap.data() ?? {}) as Record<string, unknown>;
  void freshnessHint;
  return JSON.stringify(snap.exists ? rest : null);
}

function versionRef(reviewRef: string, version: number) {
  return partnerReviewVersionsCollection(reviewRef).doc(String(version));
}

async function events(reviewRef: string) {
  const snap = await partnerReviewEventsCollection(reviewRef).get();
  // Events written by one transaction share a timestamp - break ties by the
  // canonical kind order so the sequence is deterministic.
  const rank = (kind: string) => PARTNER_REVIEW_EVENT_KINDS.indexOf(kind as (typeof PARTNER_REVIEW_EVENT_KINDS)[number]);
  return snap.docs.map((d) => d.data()).sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : rank(a.kind) - rank(b.kind)));
}

async function subcollectionCount(reviewRef: string, sub: string): Promise<number> {
  return (await partnerReviewsCollection().doc(reviewRef).collection(sub).get()).size;
}

// Drives a fresh review through DRAFT -> IN_REVIEW -> FINALIZED (Manager
// prepares, Head finalizes) and returns the finalized detail.
async function generateAndFinalize(partnerRef: string, periodKey = "2019-03") {
  const manager = await actorFor("partnership_manager");
  const head = await actorFor("partnership_head");
  const generated = await generateFor(manager, partnerRef, periodKey);
  const reviewRef = generated.review.head.reviewRef;
  const submitted = await submitPartnerReviewForReview(manager, reviewRef, { expectedDocVersion: generated.review.selectedVersion!.docVersion }, "req-submit");
  if (!submitted.ok) throw new Error(`submit failed: ${submitted.message}`);
  const finalized = await finalizePartnerReview(head, reviewRef, { expectedDocVersion: submitted.data.selectedVersion!.docVersion }, "req-finalize");
  if (!finalized.ok) throw new Error(`finalize failed: ${finalized.message}`);
  return { reviewRef, finalized: finalized.data };
}

// ---- Identity, generation, idempotency -----------------------------------------------

const FINANCE_AGREEMENT_ROOTS = /^finance(Agreements|AgreementClaims|ContractArtifacts|AgreementRestrictedExtractions|Payables)$/; // Step 14A: the Agreement foundation legitimately owns these roots (Partner Reviews writing them is proven by the write-instrumentation tests); anything else Finance-shaped is still a violation. // Step 15A: financePayables joins the list - it is a legitimate Finance root that OTHER emulator test files (which run in parallel against the one emulator) may first-write during this test. // What this file actually proves is unchanged and still exact: the write-instrumentation assertions below show Partner Reviews itself writes NO Finance document of any kind, and financeInvoices / financePayments still have no legitimate root at all.

describe("logical identity and generation", () => {
  it("the logical identity is deterministic: one Partner + one month always resolves to the same reviewRef, and different months/Partners differ", async () => {
    const head = await actorFor("partnership_head");
    const partner = await seedPartner();

    const first = await generateFor(head, partner.partnerRef, "2019-03");
    expect(first.outcome).toBe("created");
    expect(first.review.head.reviewRef).toBe(reviewRefFor(partner.partnerRef, "2019-03"));
    expect(first.review.head).toMatchObject({ periodKey: "2019-03", periodStart: "2019-03-01", periodEnd: "2019-03-31", latestVersion: 1, latestStatus: "DRAFT", currentFinalizedVersion: null, openVersion: 1, docVersion: 1 });

    const retry = await generateFor(head, partner.partnerRef, "2019-03");
    expect(retry.outcome).toBe("existing");
    expect(retry.review.head.reviewRef).toBe(first.review.head.reviewRef);

    const otherMonth = await generateFor(head, partner.partnerRef, "2019-02");
    expect(otherMonth.review.head.reviewRef).not.toBe(first.review.head.reviewRef);
    expect(otherMonth.review.head).toMatchObject({ periodStart: "2019-02-01", periodEnd: "2019-02-28" });
  });

  it("generate creates version 1 as DRAFT whose snapshot carries Assignment, Content and Analytics source refs, provenance and freshness", async () => {
    const manager = await actorFor("partnership_manager");
    const { partner, assignment, thread, record } = await seedRichPartner();

    const { outcome, review: managerReview } = await generateFor(manager, partner.partnerRef);
    expect(outcome).toBe("created");

    // Step 13A.1: these fixtures live in a private region only a GLOBAL actor holds, so the Manager's own
    // response is (correctly) scope-redacted; the full evidence is asserted through a GLOBAL actor's view.
    const globalDetail = await getPartnerReview(await actorFor("super_admin"), managerReview.head.reviewRef);
    if (!globalDetail.ok) throw new Error(`global detail failed: ${globalDetail.message}`);
    const review = globalDetail.data;
    expect(JSON.stringify(managerReview)).not.toContain(assignment.assignmentRef);
    expect(managerReview.selectedVersion!.sourceRefs).toEqual([]);

    const version = review.selectedVersion!;
    expect(version).toMatchObject({ version: 1, status: "DRAFT", docVersion: 1, generatedByUserRef: manager.userRef, submittedAt: null, finalizedAt: null, supersededAt: null });
    expect(version.sourceFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(version.evidenceCutoff).toBe(version.snapshot.evidenceCutoff);

    expect(version.sourceRefs).toEqual(
      expect.arrayContaining([
        { type: "assignment", ref: assignment.assignmentRef },
        { type: "campaign", ref: assignment.campaignRef },
        { type: "content", ref: thread.contentRef },
        { type: "analyticsSourceRecord", ref: record.sourceRef },
      ]),
    );
    expect(version.snapshot.sourceRefs).toEqual(version.sourceRefs);

    // Production + canonical Content join.
    const production = version.snapshot.production.assignments;
    expect(production).toHaveLength(1);
    expect(production[0]).toMatchObject({ assignmentRef: assignment.assignmentRef, campaignName: "PR Test Campaign", status: "IN_PROGRESS", eventDate: "2019-03-10", eventDateSource: "dueAt", requiredCount: 2, completed: false });
    expect(production[0]!.thread).toMatchObject({ contentRef: thread.contentRef, status: "UNDER_REVIEW", linkCount: 1, currentRevisionNumber: 1 });

    // Compliance: raw facts only.
    expect(version.snapshot.compliance.assignments[0]).toMatchObject({ assignmentRef: assignment.assignmentRef, submittedBeforeDue: true, revisionRequestCount: 0, hasNoThread: false, notCompletedPastDue: true });

    // Performance: the one reported metric has its value; every other supported
    // metric is null (missing, never zero); unsupported metrics are not synthesized.
    const perf = version.snapshot.performance;
    expect(perf.records).toHaveLength(1);
    expect(perf.records[0]).toMatchObject({ sourceRecordRef: record.sourceRef, matchedContentRef: thread.contentRef, reportingPeriod: { start: "2019-03-01", end: "2019-03-31" } });
    expect(perf.records[0]!.provenance).toMatchObject({ batchRef: record.batchRef, sheetName: "Posts", sourceRowNumber: 2, correctionRevision: 1, importedAt: "2019-04-02T00:00:00.000Z" });
    expect(perf.records[0]!.metrics.likes).toBe(120);
    for (const metric of PERFORMANCE_METRIC_IDS.filter((m) => m !== "likes")) expect(perf.records[0]!.metrics[metric]).toBeNull();
    expect(Object.keys(perf.records[0]!.metrics)).not.toContain("reach");
    expect(perf.unavailableMetrics).toEqual(expect.arrayContaining(["reach", "impressions", "shares", "saves", "watchTimeMinutes", "demographics", "authenticityScore", "blendedPerformanceScore"]));
    expect(perf.latestImportedAt).toBe("2019-04-02T00:00:00.000Z");

    // The raw Analytics payload never reaches the snapshot.
    const json = JSON.stringify(review);
    expect(json).not.toContain("RAW CAPTION MUST NEVER LEAK");
    expect(json).not.toContain("rawusername");

    // Freshness right after generation, with complete evidence: current.
    expect(review.selectedVersion!.snapshot.completeness.incompleteReasons).toEqual([]);
    expect(review.freshness).toMatchObject({ state: "current", version: 1, incompleteReasons: [] });
  });

  it("a generate retry and concurrent generates collapse to exactly one head and exactly one version 1", async () => {
    const manager = await actorFor("partnership_manager");
    const partner = await seedPartner();
    await seedAssignment(partner.partnerRef);

    const results = await Promise.all([1, 2].map(() => generatePartnerReviewDraft(manager, { partnerRef: partner.partnerRef, periodKey: "2019-03" }, "req-concurrent-generate")));
    expect(results.every((r) => r.ok)).toBe(true);
    const outcomes = results.map((r) => (r.ok ? r.data.outcome : "error")).sort();
    expect(outcomes.filter((o) => o === "created")).toHaveLength(1);
    expect(outcomes.filter((o) => o === "existing")).toHaveLength(1);

    const reviewRef = reviewRefFor(partner.partnerRef, "2019-03");
    reviewRefsToClean.add(reviewRef);
    expect((await partnerReviewsCollection().where("partnerRef", "==", partner.partnerRef).get()).size).toBe(1);
    expect(await subcollectionCount(reviewRef, PARTNER_REVIEWS_COLLECTIONS.versions)).toBe(1);
    expect((await events(reviewRef)).filter((e) => e.kind === "generated")).toHaveLength(1);
  });

  it("rejects an invalid month, a future month, an unknown Partner and unknown fields - writing nothing", async () => {
    const manager = await actorFor("partnership_manager");
    const partner = await seedPartner();

    for (const body of [
      { partnerRef: partner.partnerRef, periodKey: "2019-13" },
      { partnerRef: partner.partnerRef, periodKey: "2019-3" },
      { partnerRef: partner.partnerRef, periodKey: "2999-01" },
      { partnerRef: "no-such-partner", periodKey: "2019-03" },
      { partnerRef: partner.partnerRef, periodKey: "2019-03", extra: 1 },
    ]) {
      const result = await generatePartnerReviewDraft(manager, body, "req-invalid");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("invalid_input");
    }
    expect((await partnerReviewsCollection().where("partnerRef", "==", partner.partnerRef).get()).size).toBe(0);
  });
});

// ---- Refresh -------------------------------------------------------------------------------

describe("refresh", () => {
  it("refreshes Draft evidence in place (same version, same status, bumped docVersion) and picks up new upstream evidence", async () => {
    const manager = await actorFor("partnership_manager");
    const partner = await seedPartner();
    await seedAssignment(partner.partnerRef);
    const generated = await generateFor(manager, partner.partnerRef);
    const reviewRef = generated.review.head.reviewRef;
    expect(generated.review.selectedVersion!.snapshot.production.assignments).toHaveLength(1);

    // Upstream moves on.
    await seedAssignment(partner.partnerRef, { dueAt: "2019-03-20", campaignName: "Second Campaign" });
    const before = generated.review.selectedVersion!;

    const stale = await refreshPartnerReviewEvidence(manager, reviewRef, { expectedDocVersion: before.docVersion + 5 }, "req-stale-refresh");
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.code).toBe("stale_write");
    expect(JSON.parse(await rawDoc(versionRef(reviewRef, 1))).docVersion).toBe(before.docVersion);
    expect(JSON.parse(await rawDoc(versionRef(reviewRef, 1))).snapshot.production.assignments).toHaveLength(1);

    const refreshed = await refreshPartnerReviewEvidence(manager, reviewRef, { expectedDocVersion: before.docVersion }, "req-refresh");
    expect(refreshed.ok).toBe(true);
    if (!refreshed.ok) return;
    const after = refreshed.data.selectedVersion!;
    expect(after).toMatchObject({ version: 1, status: "DRAFT", docVersion: before.docVersion + 1, lastRefreshedByUserRef: manager.userRef });
    expect(after.lastRefreshedAt).not.toBeNull();
    expect(after.snapshot.production.assignments).toHaveLength(2);
    expect(after.sourceFingerprint).not.toBe(before.sourceFingerprint);
    expect(refreshed.data.head.docVersion).toBe(generated.review.head.docVersion + 1);
    expect(refreshed.data.freshness?.state).toBe("current");

    // The same docVersion cannot be reused (a replayed request is stale).
    const replay = await refreshPartnerReviewEvidence(manager, reviewRef, { expectedDocVersion: before.docVersion }, "req-refresh-replay");
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.code).toBe("stale_write");

    expect((await events(reviewRef)).map((e) => e.kind)).toEqual(["generated", "refreshed"]);
  });

  it("an In Review version can be refreshed too; status stays In Review", async () => {
    const manager = await actorFor("partnership_manager");
    const partner = await seedPartner();
    await seedAssignment(partner.partnerRef);
    const generated = await generateFor(manager, partner.partnerRef);
    const reviewRef = generated.review.head.reviewRef;
    const submitted = await submitPartnerReviewForReview(manager, reviewRef, { expectedDocVersion: 1 }, "req-submit");
    if (!submitted.ok) throw new Error("unreachable");

    const refreshed = await refreshPartnerReviewEvidence(manager, reviewRef, { expectedDocVersion: submitted.data.selectedVersion!.docVersion }, "req-refresh-in-review");
    expect(refreshed.ok).toBe(true);
    if (refreshed.ok) expect(refreshed.data.selectedVersion).toMatchObject({ status: "IN_REVIEW", submittedByUserRef: manager.userRef });
  });
});

// ---- Authorization -----------------------------------------------------------------------------

describe("authorization: explicit grants, no role-rank shortcut", () => {
  it("the stored grants are exactly: Viewer/Analyst read only, Manager create+submit, Head create+submit+finalize, Super Admin every action explicitly", async () => {
    const db = getAdminFirestore();
    const grant = async (role: string) => (await db.collection(COLLECTIONS.accessGrants).doc(role).get()).data()?.features?.partner_reviews;

    expect(await grant("viewer")).toEqual({ view: true, actions: {} });
    expect(await grant("analyst")).toEqual({ view: true, actions: {} });
    expect(await grant("partnership_manager")).toEqual({ view: true, actions: { create: true, submit_partner_review: true } });
    expect(await grant("partnership_head")).toEqual({ view: true, actions: { create: true, submit_partner_review: true, finalize_approve: true } });
    const admin = await grant("super_admin");
    expect(admin.view).toBe(true);
    for (const action of MODULE_ACTIONS.partner_reviews) expect(admin.actions[action.id]).toBe(true);
  });

  it("Manager can generate/refresh/submit but NOT finalize (action_denied); Head finalizes; Super Admin finalizes via explicit grants", async () => {
    const manager = await actorFor("partnership_manager");
    const head = await actorFor("partnership_head");
    const admin = await actorFor("super_admin");

    expect(await canPerformAction(manager, "partner_reviews", "finalize_approve")).toBe(false);
    expect(await canPerformAction(head, "partner_reviews", "finalize_approve")).toBe(true);
    expect(await canPerformAction(admin, "partner_reviews", "finalize_approve")).toBe(true);

    const partner = await seedPartner();
    await seedAssignment(partner.partnerRef);
    const generated = await generateFor(manager, partner.partnerRef);
    const reviewRef = generated.review.head.reviewRef;
    const submitted = await submitPartnerReviewForReview(manager, reviewRef, { expectedDocVersion: 1 }, "req-submit");
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;
    const docVersion = submitted.data.selectedVersion!.docVersion;

    const denied = await finalizePartnerReview(manager, reviewRef, { expectedDocVersion: docVersion }, "req-manager-finalize");
    expect(denied).toMatchObject({ ok: false, code: "unauthorized", reason: "action_denied" });
    expect(JSON.parse(await rawDoc(versionRef(reviewRef, 1))).status).toBe("IN_REVIEW");

    const finalized = await finalizePartnerReview(head, reviewRef, { expectedDocVersion: docVersion }, "req-head-finalize");
    expect(finalized.ok).toBe(true);
    if (finalized.ok) expect(finalized.data.selectedVersion).toMatchObject({ status: "FINALIZED", finalizedByUserRef: head.userRef });

    // Super Admin: generate, submit and finalize a second review end to end.
    const partner2 = await seedPartner();
    const g2 = await generateFor(admin, partner2.partnerRef);
    const s2 = await submitPartnerReviewForReview(admin, g2.review.head.reviewRef, { expectedDocVersion: 1 }, "req-admin-submit");
    if (!s2.ok) throw new Error(s2.message);
    const f2 = await finalizePartnerReview(admin, g2.review.head.reviewRef, { expectedDocVersion: s2.data.selectedVersion!.docVersion }, "req-admin-finalize");
    expect(f2.ok).toBe(true);
    if (f2.ok) expect(f2.data.selectedVersion?.finalizedByUserRef).toBe(admin.userRef);
  });

  it("Viewer and Analyst are denied every mutation (action_denied) but can read in-scope reviews", async () => {
    const manager = await actorFor("partnership_manager");
    const partner = await seedPartner({ regionIds: ["Kerala"] });
    await seedAssignment(partner.partnerRef);
    const generated = await generateFor(manager, partner.partnerRef);
    const reviewRef = generated.review.head.reviewRef;

    for (const role of ["viewer", "analyst"]) {
      const actor = await actorFor(role);
      const denials = await Promise.all([
        generatePartnerReviewDraft(actor, { partnerRef: partner.partnerRef, periodKey: "2019-02" }, "req"),
        refreshPartnerReviewEvidence(actor, reviewRef, { expectedDocVersion: 1 }, "req"),
        submitPartnerReviewForReview(actor, reviewRef, { expectedDocVersion: 1 }, "req"),
        finalizePartnerReview(actor, reviewRef, { expectedDocVersion: 1 }, "req"),
        createPartnerReviewRevision(actor, reviewRef, { expectedDocVersion: 1 }, "req"),
      ]);
      for (const denial of denials) expect(denial).toMatchObject({ ok: false, code: "unauthorized", reason: "action_denied" });

      // Scoped, sanitized read is allowed.
      const detail = await getPartnerReview(actor, reviewRef);
      expect(detail.ok).toBe(true);
      const list = await listPartnerReviewHeads(actor, { partnerRef: partner.partnerRef });
      expect(list.ok && list.data.heads.map((h) => h.reviewRef)).toEqual([reviewRef]);
      const needs = await deriveNeedsReview(actor, { partnerRef: partner.partnerRef, periodKey: "2019-03" });
      expect(needs).toMatchObject({ ok: true, data: { needsReview: true, reason: "draft_open" } });
      const fresh = await inspectPartnerReviewFreshness(actor, reviewRef);
      expect(fresh.ok).toBe(true);
    }
    expect((await partnerReviewsCollection().where("partnerRef", "==", partner.partnerRef).get()).size).toBe(1);
    expect(await subcollectionCount(reviewRef, PARTNER_REVIEWS_COLLECTIONS.versions)).toBe(1);
  });

  it("an unauthenticated caller is denied everything (not_authenticated)", async () => {
    const results = await Promise.all([
      generatePartnerReviewDraft(null, { partnerRef: "x", periodKey: "2019-03" }, "req"),
      getPartnerReview(null, "pr_aaaaaaaaaaaaaaaaaaaa"),
      listPartnerReviewHeads(null, {}),
      deriveNeedsReview(null, { partnerRef: "x", periodKey: "2019-03" }),
      finalizePartnerReview(null, "pr_aaaaaaaaaaaaaaaaaaaa", { expectedDocVersion: 1 }, "req"),
    ]);
    for (const r of results) expect(r).toMatchObject({ ok: false, code: "unauthorized", reason: "not_authenticated" });
  });

  it("knowing a reviewRef never grants access: a cross-scope actor is denied get/list/derive/every mutation, and the review is untouched", async () => {
    const admin = await actorFor("super_admin");
    const manager = await actorFor("partnership_manager");
    const head = await actorFor("partnership_head");

    // Karnataka: Head holds it, Manager does not. Private region: only GLOBAL.
    const karnataka = await seedPartner({ regionIds: ["Karnataka"] });
    const hidden = await seedPartner({ regionIds: [PRIVATE_REGION] });
    const kReview = await generateFor(admin, karnataka.partnerRef);
    const hReview = await generateFor(admin, hidden.partnerRef);

    // Manager vs the Karnataka review.
    const kRef = kReview.review.head.reviewRef;
    expect(await getPartnerReview(manager, kRef)).toMatchObject({ ok: false, code: "unauthorized", reason: "scope_denied" });
    expect(await getPartnerReviewVersion(manager, kRef, "1")).toMatchObject({ ok: false, code: "unauthorized", reason: "scope_denied" });
    expect(await inspectPartnerReviewFreshness(manager, kRef)).toMatchObject({ ok: false, code: "unauthorized", reason: "scope_denied" });
    expect(await refreshPartnerReviewEvidence(manager, kRef, { expectedDocVersion: 1 }, "req")).toMatchObject({ ok: false, code: "unauthorized", reason: "scope_denied" });
    expect(await submitPartnerReviewForReview(manager, kRef, { expectedDocVersion: 1 }, "req")).toMatchObject({ ok: false, code: "unauthorized", reason: "scope_denied" });
    expect(await createPartnerReviewRevision(manager, kRef, { expectedDocVersion: 1 }, "req")).toMatchObject({ ok: false, code: "unauthorized", reason: "scope_denied" });
    expect(await generatePartnerReviewDraft(manager, { partnerRef: karnataka.partnerRef, periodKey: "2019-02" }, "req")).toMatchObject({ ok: false, code: "unauthorized", reason: "scope_denied" });
    expect(await deriveNeedsReview(manager, { partnerRef: karnataka.partnerRef, periodKey: "2019-03" })).toMatchObject({ ok: false, code: "unauthorized", reason: "scope_denied" });

    // A partnerRef-filtered list reveals nothing (same as an empty result); an unfiltered list never contains it.
    expect(await listPartnerReviewHeads(manager, { partnerRef: karnataka.partnerRef })).toMatchObject({ ok: true, data: { heads: [] } });
    const managerList = await listPartnerReviewHeads(manager, { limit: 100, periodKey: "2019-03" });
    expect(managerList.ok && managerList.data.heads.map((h) => h.reviewRef)).not.toContain(kRef);

    // Head holds Karnataka: allowed. Head vs the private-region review: denied.
    expect((await getPartnerReview(head, kRef)).ok).toBe(true);
    const headList = await listPartnerReviewHeads(head, { limit: 100, periodKey: "2019-03" });
    expect(headList.ok && headList.data.heads.map((h) => h.reviewRef)).toContain(kRef);
    const hRef = hReview.review.head.reviewRef;
    expect(await getPartnerReview(head, hRef)).toMatchObject({ ok: false, code: "unauthorized", reason: "scope_denied" });
    expect(await submitPartnerReviewForReview(head, hRef, { expectedDocVersion: 1 }, "req")).toMatchObject({ ok: false, code: "unauthorized", reason: "scope_denied" });
    expect(await finalizePartnerReview(head, hRef, { expectedDocVersion: 1 }, "req")).toMatchObject({ ok: false, code: "unauthorized", reason: "scope_denied" });
    const headListAll = await listPartnerReviewHeads(head, { limit: 100, periodKey: "2019-03" });
    expect(headListAll.ok && headListAll.data.heads.map((h) => h.reviewRef)).not.toContain(hRef);
    // ...and Super Admin (GLOBAL) sees both.
    const adminList = await listPartnerReviewHeads(admin, { limit: 100, periodKey: "2019-03" });
    expect(adminList.ok && adminList.data.heads.map((h) => h.reviewRef)).toEqual(expect.arrayContaining([kRef, hRef]));

    // Neither review was touched by any denied attempt.
    expect(JSON.parse(await rawDoc(versionRef(kRef, 1))).docVersion).toBe(1);
    expect(JSON.parse(await rawDoc(versionRef(hRef, 1))).docVersion).toBe(1);
    expect(await subcollectionCount(kRef, PARTNER_REVIEWS_COLLECTIONS.events)).toBe(1);
    expect(await subcollectionCount(hRef, PARTNER_REVIEWS_COLLECTIONS.events)).toBe(1);
  });

  it("a PARTNER-grant scope reaches its Partner's review through the bounded list (creator-house is outside every Manager region/team)", async () => {
    const admin = await actorFor("super_admin");
    const manager = await actorFor("partnership_manager");
    const viewer = await actorFor("viewer");

    const generated = await generateFor(admin, "creator-house", "2018-06");
    const reviewRef = generated.review.head.reviewRef;

    const managerList = await listPartnerReviewHeads(manager, { limit: 100, periodKey: "2018-06" });
    expect(managerList.ok && managerList.data.heads.map((h) => h.reviewRef)).toContain(reviewRef);
    expect((await getPartnerReview(manager, reviewRef)).ok).toBe(true);

    // Viewer has no route to creator-house (Karnataka, no PARTNER grant).
    expect(await getPartnerReview(viewer, reviewRef)).toMatchObject({ ok: false, code: "unauthorized", reason: "scope_denied" });
    const viewerList = await listPartnerReviewHeads(viewer, { limit: 100, periodKey: "2018-06" });
    expect(viewerList.ok && viewerList.data.heads.map((h) => h.reviewRef)).not.toContain(reviewRef);
  });

  it("malformed and unknown reviewRefs are not_found (never a Firestore path error) and an empty ref is invalid_input", async () => {
    const manager = await actorFor("partnership_manager");
    expect(await getPartnerReview(manager, "pr_aaaaaaaaaaaaaaaaaaaa")).toMatchObject({ ok: false, code: "not_found" });
    expect(await getPartnerReview(manager, "../partners/creator-house")).toMatchObject({ ok: false, code: "not_found" });
    expect(await getPartnerReview(manager, "")).toMatchObject({ ok: false, code: "invalid_input" });
    expect(await getPartnerReviewVersion(manager, "pr_aaaaaaaaaaaaaaaaaaaa", "1")).toMatchObject({ ok: false, code: "not_found" });
  });
});

// ---- Workflow, immutability, concurrency ---------------------------------------------------------

describe("submit / finalize / immutability", () => {
  it("submits Draft -> In Review, then finalizes: head pointers move, events are appended, stale requests fail safely", async () => {
    const manager = await actorFor("partnership_manager");
    const head = await actorFor("partnership_head");
    const partner = await seedPartner();
    await seedAssignment(partner.partnerRef);
    const generated = await generateFor(manager, partner.partnerRef);
    const reviewRef = generated.review.head.reviewRef;

    // A wrong expectedDocVersion never submits.
    const staleSubmit = await submitPartnerReviewForReview(manager, reviewRef, { expectedDocVersion: 9 }, "req-stale-submit");
    expect(staleSubmit).toMatchObject({ ok: false, code: "stale_write" });
    expect(JSON.parse(await rawDoc(versionRef(reviewRef, 1))).status).toBe("DRAFT");

    // Finalizing a Draft (not In Review) is rejected.
    const early = await finalizePartnerReview(head, reviewRef, { expectedDocVersion: 1 }, "req-early");
    expect(early).toMatchObject({ ok: false, code: "invalid_input" });

    const submitted = await submitPartnerReviewForReview(manager, reviewRef, { expectedDocVersion: 1 }, "req-submit");
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;
    expect(submitted.data.selectedVersion).toMatchObject({ status: "IN_REVIEW", docVersion: 2, submittedByUserRef: manager.userRef });
    expect(submitted.data.head).toMatchObject({ latestStatus: "IN_REVIEW", openVersion: 1, currentFinalizedVersion: null });

    // Resubmitting is rejected (already In Review).
    expect(await submitPartnerReviewForReview(manager, reviewRef, { expectedDocVersion: 2 }, "req-resubmit")).toMatchObject({ ok: false, code: "invalid_input" });

    // A stale finalize (the client still holds the Draft docVersion) fails safely.
    expect(await finalizePartnerReview(head, reviewRef, { expectedDocVersion: 1 }, "req-stale-finalize")).toMatchObject({ ok: false, code: "stale_write" });
    expect(JSON.parse(await rawDoc(versionRef(reviewRef, 1))).status).toBe("IN_REVIEW");

    const finalized = await finalizePartnerReview(head, reviewRef, { expectedDocVersion: 2 }, "req-finalize");
    expect(finalized.ok).toBe(true);
    if (!finalized.ok) return;
    expect(finalized.data.selectedVersion).toMatchObject({ status: "FINALIZED", docVersion: 3, finalizedByUserRef: head.userRef });
    expect(finalized.data.head).toMatchObject({ latestStatus: "FINALIZED", latestVersion: 1, currentFinalizedVersion: 1, openVersion: null });

    const log = await events(reviewRef);
    expect(log.map((e) => e.kind)).toEqual(["generated", "submitted", "finalized"]);
    expect(log.map((e) => e.actorUserRef)).toEqual([manager.userRef, manager.userRef, head.userRef]);
    expect(log.map((e) => e.requestId)).toEqual(["req-generate", "req-submit", "req-finalize"]);
    expect(log.every((e) => typeof e.createdAt === "string" && e.version === 1)).toBe(true);
  });

  it("only one of two concurrent finalize requests succeeds", async () => {
    const manager = await actorFor("partnership_manager");
    const head = await actorFor("partnership_head");
    const admin = await actorFor("super_admin");
    const partner = await seedPartner();
    await seedAssignment(partner.partnerRef);
    const generated = await generateFor(manager, partner.partnerRef);
    const reviewRef = generated.review.head.reviewRef;
    await submitPartnerReviewForReview(manager, reviewRef, { expectedDocVersion: 1 }, "req-submit");

    const results = await Promise.all([finalizePartnerReview(head, reviewRef, { expectedDocVersion: 2 }, "req-f-head"), finalizePartnerReview(admin, reviewRef, { expectedDocVersion: 2 }, "req-f-admin")]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const loser = results.find((r) => !r.ok);
    if (!loser || loser.ok) throw new Error("expected exactly one failed finalize");
    expect(["stale_write", "invalid_input", "conflict"]).toContain(loser.code);

    const stored = JSON.parse(await rawDoc(versionRef(reviewRef, 1)));
    expect(stored).toMatchObject({ status: "FINALIZED", docVersion: 3 });
    expect((await events(reviewRef)).filter((e) => e.kind === "finalized")).toHaveLength(1);
  });

  it("a finalized version is immutable: refresh, submit, re-finalize and a raw refresh naming the finalized version are all rejected and the document is byte-identical", async () => {
    const manager = await actorFor("partnership_manager");
    const head = await actorFor("partnership_head");
    const partner = await seedPartner();
    await seedAssignment(partner.partnerRef);
    const { reviewRef, finalized } = await generateAndFinalize(partner.partnerRef);
    const docVersion = finalized.selectedVersion!.docVersion;

    const beforeVersion = await rawDoc(versionRef(reviewRef, 1));
    const beforeHead = await rawDoc(partnerReviewsCollection().doc(reviewRef));
    const eventCount = (await events(reviewRef)).length;

    // Even new upstream evidence cannot reach a finalized version through refresh.
    await seedAssignment(partner.partnerRef, { dueAt: "2019-03-25", campaignName: "Late Arrival" });

    const attempts = await Promise.all([
      refreshPartnerReviewEvidence(manager, reviewRef, { expectedDocVersion: docVersion }, "req-a"),
      refreshPartnerReviewEvidence(manager, reviewRef, { version: 1, expectedDocVersion: docVersion }, "req-b"),
      submitPartnerReviewForReview(manager, reviewRef, { expectedDocVersion: docVersion }, "req-c"),
      submitPartnerReviewForReview(manager, reviewRef, { version: 1, expectedDocVersion: docVersion }, "req-d"),
      finalizePartnerReview(head, reviewRef, { expectedDocVersion: docVersion }, "req-e"),
      finalizePartnerReview(head, reviewRef, { version: 1, expectedDocVersion: docVersion }, "req-f"),
    ]);
    for (const attempt of attempts) {
      expect(attempt.ok).toBe(false);
      if (!attempt.ok) expect(["invalid_input", "stale_write", "conflict"]).toContain(attempt.code);
    }
    // The raw, explicit-version refresh is specifically invalid_input.
    expect(attempts[1]).toMatchObject({ ok: false, code: "invalid_input" });

    expect(await rawDoc(versionRef(reviewRef, 1))).toBe(beforeVersion);
    expect(await rawDoc(partnerReviewsCollection().doc(reviewRef))).toBe(beforeHead);
    expect((await events(reviewRef)).length).toBe(eventCount);
    expect(await subcollectionCount(reviewRef, PARTNER_REVIEWS_COLLECTIONS.versions)).toBe(1);
  });
});

// ---- Freshness, revision, supersession ---------------------------------------------------------------

describe("freshness, revision and supersession", () => {
  it("an Analytics source correction after finalize raises revision_available without mutating the finalized version", async () => {
    const head = await actorFor("partnership_head");
    const { partner, record } = await seedRichPartner();
    const { reviewRef, finalized } = await generateAndFinalize(partner.partnerRef);
    expect(finalized.freshness?.state).toBe("current");

    const before = await rawDoc(versionRef(reviewRef, 1));
    const beforeHead = await rawHeadDoc(partnerReviewsCollection().doc(reviewRef));

    // The accepted correction path: clear the record's match (it leaves this Partner's evidence).
    const corrected = await resolveAnalyticsSourceRecordMatch(head, { recordKind: "content", sourceRef: record.sourceRef, targetRef: null, expectedRevision: 1, reason: "test correction" }, "req-correction");
    expect(corrected.ok).toBe(true);

    const inspected = await inspectPartnerReviewFreshness(head, reviewRef);
    expect(inspected.ok).toBe(true);
    if (!inspected.ok) return;
    expect(inspected.data.freshness).toMatchObject({ state: "revision_available", version: 1 });
    expect(inspected.data.freshness.snapshotFingerprint).not.toBe(inspected.data.freshness.currentFingerprint);

    const detail = await getPartnerReview(head, reviewRef);
    expect(detail.ok && detail.data.freshness?.state).toBe("revision_available");
    expect(await deriveNeedsReview(head, { partnerRef: partner.partnerRef, periodKey: "2019-03" })).toMatchObject({ ok: true, data: { needsReview: true, reason: "revision_available" } });

    // The finalized version and head are byte-identical: staleness is a derived signal only.
    expect(await rawDoc(versionRef(reviewRef, 1))).toBe(before);
    expect(await rawHeadDoc(partnerReviewsCollection().doc(reviewRef))).toBe(beforeHead);
    expect(JSON.parse(before).status).toBe("FINALIZED");
  });

  it("a direct edit of a source metric also raises revision_available (fingerprint covers metric values)", async () => {
    const head = await actorFor("partnership_head");
    const { partner, record } = await seedRichPartner();
    const { reviewRef } = await generateAndFinalize(partner.partnerRef);

    await analyticsContentSourceRecordsCollection().doc(record.uid).update({ likes: 999 });
    const inspected = await inspectPartnerReviewFreshness(head, reviewRef);
    expect(inspected.ok && inspected.data.freshness.state).toBe("revision_available");
  });

  it("a revision is refused while the finalized evidence is still current (not_ready) and nothing is written", async () => {
    const manager = await actorFor("partnership_manager");
    const partner = await seedPartner();
    await seedAssignment(partner.partnerRef);
    const { reviewRef, finalized } = await generateAndFinalize(partner.partnerRef);

    const result = await createPartnerReviewRevision(manager, reviewRef, { expectedDocVersion: finalized.head.docVersion }, "req-revision-not-needed");
    expect(result).toMatchObject({ ok: false, code: "not_ready" });
    if (!result.ok) expect(result.blockers?.[0]?.code).toBe("REVISION_NOT_NEEDED");
    expect(await subcollectionCount(reviewRef, PARTNER_REVIEWS_COLLECTIONS.versions)).toBe(1);
  });

  it("a revision needs a finalized version to exist first", async () => {
    const manager = await actorFor("partnership_manager");
    const partner = await seedPartner();
    await seedAssignment(partner.partnerRef);
    const generated = await generateFor(manager, partner.partnerRef);
    // Draft only: nothing has been finalized yet, so there is nothing to revise.
    expect(await createPartnerReviewRevision(manager, generated.review.head.reviewRef, { expectedDocVersion: 1 }, "req")).toMatchObject({ ok: false, code: "invalid_input" });
    expect(await subcollectionCount(generated.review.head.reviewRef, PARTNER_REVIEWS_COLLECTIONS.versions)).toBe(1);
  });

  it("only one of two concurrent revision requests creates the next version; a stale request fails safely; an open revision blocks another", async () => {
    const manager = await actorFor("partnership_manager");
    const partner = await seedPartner();
    await seedAssignment(partner.partnerRef);
    const { reviewRef, finalized } = await generateAndFinalize(partner.partnerRef);
    const headDocVersion = finalized.head.docVersion;

    // Upstream changes after finalize.
    await seedAssignment(partner.partnerRef, { dueAt: "2019-03-22", campaignName: "After Finalize" });

    // Stale HEAD docVersion fails safely and writes nothing.
    expect(await createPartnerReviewRevision(manager, reviewRef, { expectedDocVersion: headDocVersion + 4 }, "req-stale-revision")).toMatchObject({ ok: false, code: "stale_write" });
    expect(await subcollectionCount(reviewRef, PARTNER_REVIEWS_COLLECTIONS.versions)).toBe(1);

    const results = await Promise.all([createPartnerReviewRevision(manager, reviewRef, { expectedDocVersion: headDocVersion }, "req-rev-1"), createPartnerReviewRevision(manager, reviewRef, { expectedDocVersion: headDocVersion }, "req-rev-2")]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const loser = results.find((r) => !r.ok);
    if (!loser || loser.ok) throw new Error("expected exactly one failed revision");
    expect(["stale_write", "conflict"]).toContain(loser.code);

    // Exactly one new version number exists, and it is version 2.
    expect(await subcollectionCount(reviewRef, PARTNER_REVIEWS_COLLECTIONS.versions)).toBe(2);
    expect((await versionRef(reviewRef, 3).get()).exists).toBe(false);
    expect((await events(reviewRef)).filter((e) => e.kind === "revision_created")).toHaveLength(1);

    // With a revision open, another is refused deterministically.
    const detail = await getPartnerReview(manager, reviewRef);
    if (!detail.ok) throw new Error("unreachable");
    expect(await createPartnerReviewRevision(manager, reviewRef, { expectedDocVersion: detail.data.head.docVersion }, "req-rev-3")).toMatchObject({ ok: false, code: "conflict" });
  });

  it("a revision keeps the old FINALIZED version untouched until the replacement finalizes; then the old one becomes SUPERSEDED, head pointers move and history is preserved", async () => {
    const manager = await actorFor("partnership_manager");
    const head = await actorFor("partnership_head");
    const partner = await seedPartner();
    await seedAssignment(partner.partnerRef);
    const { reviewRef, finalized } = await generateAndFinalize(partner.partnerRef);
    const v1Before = await rawDoc(versionRef(reviewRef, 1));
    const v1Snapshot = JSON.parse(v1Before).snapshot;

    await seedAssignment(partner.partnerRef, { dueAt: "2019-03-22", campaignName: "After Finalize" });

    const revision = await createPartnerReviewRevision(manager, reviewRef, { expectedDocVersion: finalized.head.docVersion }, "req-revision");
    expect(revision.ok).toBe(true);
    if (!revision.ok) return;
    expect(revision.data.head).toMatchObject({ latestVersion: 2, latestStatus: "DRAFT", currentFinalizedVersion: 1, openVersion: 2 });
    expect(revision.data.selectedVersion).toMatchObject({ version: 2, status: "DRAFT", docVersion: 1 });
    expect(revision.data.selectedVersion!.snapshot.production.assignments).toHaveLength(2);
    expect(revision.data.selectedVersion!.sourceFingerprint).not.toBe(finalized.selectedVersion!.sourceFingerprint);

    // v1 stays FINALIZED and byte-identical while v2 is Draft/In Review.
    expect(await rawDoc(versionRef(reviewRef, 1))).toBe(v1Before);
    const midway = await getPartnerReview(head, reviewRef, { version: 1 });
    expect(midway.ok && midway.data.freshness?.state).toBe("revision_in_progress");
    expect(midway.ok && midway.data.versions.map((v) => [v.version, v.status])).toEqual([
      [2, "DRAFT"],
      [1, "FINALIZED"],
    ]);

    // Submitting the revision still leaves v1 FINALIZED.
    const submitted = await submitPartnerReviewForReview(manager, reviewRef, { expectedDocVersion: 1 }, "req-submit-2");
    if (!submitted.ok) throw new Error(submitted.message);
    expect(await rawDoc(versionRef(reviewRef, 1))).toBe(v1Before);
    expect(await deriveNeedsReview(head, { partnerRef: partner.partnerRef, periodKey: "2019-03" })).toMatchObject({ ok: true, data: { needsReview: true, reason: "in_review_open" } });

    const done = await finalizePartnerReview(head, reviewRef, { expectedDocVersion: submitted.data.selectedVersion!.docVersion }, "req-finalize-2");
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    expect(done.data.head).toMatchObject({ latestVersion: 2, latestStatus: "FINALIZED", currentFinalizedVersion: 2, openVersion: null });
    expect(done.data.versions.map((v) => [v.version, v.status])).toEqual([
      [2, "FINALIZED"],
      [1, "SUPERSEDED"],
    ]);

    // Historical evidence is preserved exactly - only status/supersession metadata changed on v1.
    const v1After = JSON.parse(await rawDoc(versionRef(reviewRef, 1)));
    expect(v1After).toMatchObject({ status: "SUPERSEDED", supersededByVersion: 2 });
    expect(v1After.supersededAt).toEqual(expect.any(String));
    expect(v1After.snapshot).toEqual(v1Snapshot);
    expect(v1After.sourceFingerprint).toBe(finalized.selectedVersion!.sourceFingerprint);
    expect(v1After.finalizedAt).toBe(finalized.selectedVersion!.finalizedAt);

    // A superseded version reports 'superseded' and is never compared; the new current is current.
    const old = await inspectPartnerReviewFreshness(head, reviewRef, { version: 1 });
    expect(old.ok && old.data.freshness).toMatchObject({ state: "superseded", currentFingerprint: null });
    const current = await inspectPartnerReviewFreshness(head, reviewRef);
    expect(current.ok && current.data.freshness.state).toBe("current");
    expect(await deriveNeedsReview(head, { partnerRef: partner.partnerRef, periodKey: "2019-03" })).toMatchObject({ ok: true, data: { needsReview: false, reason: "up_to_date" } });

    // The version endpoint serves either version; a version that does not exist is not_found.
    const v1 = await getPartnerReviewVersion(head, reviewRef, "1");
    expect(v1.ok && v1.data.version.status).toBe("SUPERSEDED");
    expect(await getPartnerReviewVersion(head, reviewRef, "3")).toMatchObject({ ok: false, code: "not_found" });
    expect(await getPartnerReviewVersion(head, reviewRef, "0")).toMatchObject({ ok: false, code: "invalid_input" });

    // Events cover the whole chain, in order.
    const log = await events(reviewRef);
    expect(log.map((e) => e.kind)).toEqual(["generated", "submitted", "finalized", "revision_created", "submitted", "finalized", "superseded"]);
    expect(log.find((e) => e.kind === "superseded")).toMatchObject({ version: 1, metadata: { supersededByVersion: 2 } });
  });
});

// ---- Needs Review derivation -----------------------------------------------------------------------

describe("deriveNeedsReview", () => {
  it("no_evidence for an empty period, no_review with evidence, draft_open, in_review_open, up_to_date - never persisted", async () => {
    const manager = await actorFor("partnership_manager");
    const partner = await seedPartner();

    expect(await deriveNeedsReview(manager, { partnerRef: partner.partnerRef, periodKey: "2019-03" })).toMatchObject({ ok: true, data: { needsReview: false, reason: "no_evidence" } });

    await seedAssignment(partner.partnerRef);
    expect(await deriveNeedsReview(manager, { partnerRef: partner.partnerRef, periodKey: "2019-03" })).toMatchObject({ ok: true, data: { needsReview: true, reason: "no_review" } });
    // Nothing was persisted by deriving.
    expect((await partnerReviewsCollection().where("partnerRef", "==", partner.partnerRef).get()).size).toBe(0);

    const generated = await generateFor(manager, partner.partnerRef);
    expect(await deriveNeedsReview(manager, { partnerRef: partner.partnerRef, periodKey: "2019-03" })).toMatchObject({ ok: true, data: { needsReview: true, reason: "draft_open" } });

    await submitPartnerReviewForReview(manager, generated.review.head.reviewRef, { expectedDocVersion: 1 }, "req-submit");
    expect(await deriveNeedsReview(manager, { partnerRef: partner.partnerRef, periodKey: "2019-03" })).toMatchObject({ ok: true, data: { needsReview: true, reason: "in_review_open" } });

    const head = await actorFor("partnership_head");
    await finalizePartnerReview(head, generated.review.head.reviewRef, { expectedDocVersion: 2 }, "req-finalize");
    expect(await deriveNeedsReview(manager, { partnerRef: partner.partnerRef, periodKey: "2019-03" })).toMatchObject({ ok: true, data: { needsReview: false, reason: "up_to_date" } });

    // A different, evidence-free month is still no_evidence.
    expect(await deriveNeedsReview(manager, { partnerRef: partner.partnerRef, periodKey: "2019-09" })).toMatchObject({ ok: true, data: { needsReview: false, reason: "no_evidence" } });
    expect(await deriveNeedsReview(manager, { partnerRef: partner.partnerRef, periodKey: "2019-99" })).toMatchObject({ ok: false, code: "invalid_input" });
  });
});

// ---- List, history and pagination ----------------------------------------------------------------------

describe("list and detail", () => {
  it("lists a Partner's review heads newest month first with deterministic cursor pagination, a periodKey filter and a status filter", async () => {
    const head = await actorFor("partnership_head");
    const partner = await seedPartner();
    for (const month of ["2019-01", "2019-02", "2019-03"]) await generateFor(head, partner.partnerRef, month);

    const page1 = await listPartnerReviewHeads(head, { partnerRef: partner.partnerRef, limit: 2 });
    expect(page1.ok).toBe(true);
    if (!page1.ok || !page1.data.nextCursor) throw new Error("expected a first page with a cursor");
    expect(page1.data.heads.map((h) => h.periodKey)).toEqual(["2019-03", "2019-02"]);
    expect(page1.data.heads[0]!.partnerDisplayName).toBe(partner.displayName);

    const page2 = await listPartnerReviewHeads(head, { partnerRef: partner.partnerRef, limit: 2, cursor: page1.data.nextCursor });
    expect(page2.ok && page2.data.heads.map((h) => h.periodKey)).toEqual(["2019-01"]);
    expect(page2.ok && page2.data.nextCursor).toBeNull();

    const filtered = await listPartnerReviewHeads(head, { partnerRef: partner.partnerRef, periodKey: "2019-02" });
    expect(filtered.ok && filtered.data.heads.map((h) => h.periodKey)).toEqual(["2019-02"]);

    const byStatus = await listPartnerReviewHeads(head, { partnerRef: partner.partnerRef, status: "FINALIZED" });
    expect(byStatus.ok && byStatus.data.heads).toEqual([]);
    const byDraft = await listPartnerReviewHeads(head, { partnerRef: partner.partnerRef, status: "DRAFT" });
    expect(byDraft.ok && byDraft.data.heads).toHaveLength(3);

    expect(await listPartnerReviewHeads(head, { periodKey: "2019-13" })).toMatchObject({ ok: false, code: "invalid_input" });
    expect(await listPartnerReviewHeads(head, { status: "NEEDS_REVIEW" })).toMatchObject({ ok: false, code: "invalid_input" });
  });

  it("an unfiltered scoped list (SELF/REGION/TEAM branches merged) never repeats or skips a review across pages", async () => {
    const admin = await actorFor("super_admin");
    const viewer = await actorFor("viewer");
    // Viewer holds SELF + Kerala: one Partner reached by region, one by ownership (owner = viewer, private region).
    const byRegion = await seedPartner({ regionIds: ["Kerala"] });
    const byOwner = await seedPartner({ regionIds: [PRIVATE_REGION], ownerUid: viewer.uid });
    const a = await generateFor(admin, byRegion.partnerRef, "2017-05");
    const b = await generateFor(admin, byOwner.partnerRef, "2017-05");

    const seen: string[] = [];
    let cursor: PartnerReviewListCursor | null | undefined;
    for (let i = 0; i < 100; i++) {
      const page = await listPartnerReviewHeads(viewer, { limit: 5, periodKey: "2017-05", cursor: cursor ?? undefined });
      if (!page.ok) throw new Error(page.message);
      seen.push(...page.data.heads.map((h) => h.reviewRef));
      cursor = page.data.nextCursor;
      if (!cursor) break;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual(expect.arrayContaining([a.review.head.reviewRef, b.review.head.reviewRef]));
  });

  it("detail returns head + bounded version history + selected version, and DTOs expose no raw uid or scope snapshot", async () => {
    const manager = await actorFor("partnership_manager");
    const partner = await seedPartner({ regionIds: ["Kerala"], ownerUid: "some-owner-uid" });
    const generated = await generateFor(manager, partner.partnerRef);
    const json = JSON.stringify(generated.review);

    expect(generated.review.versions).toHaveLength(1);
    expect(generated.review.hasMoreVersions).toBe(false);
    for (const forbidden of ["some-owner-uid", "ownerUid", "regionIds", "teamIds", "partnerUid", "email", "phone", "legalName", "example-partner.test", "+91 90000 00099"]) expect(json).not.toContain(forbidden);
    expect(json).toContain(manager.userRef);
    expect(json).not.toContain(manager.uid);
  });
});

// ---- Boundaries: upstream immutability and Finance ---------------------------------------------------

describe("upstream and Finance boundaries", () => {
  it("generate/refresh/submit/finalize/revision never write to any upstream Assignment, Content, Analytics or Partner record, and never introduce a Finance-shaped collection", async () => {
    const manager = await actorFor("partnership_manager");
    const head = await actorFor("partnership_head");
    const { partner, assignment, thread, record } = await seedRichPartner();

    const upstreamRefs = [assignmentsCollection().doc(assignment.uid), contentCollection().doc(thread.uid), analyticsContentSourceRecordsCollection().doc(record.uid), partnersCollection().doc(partner.uid)];
    const before = await Promise.all(upstreamRefs.map(rawDoc));
    const rootBefore = (await getAdminFirestore().listCollections()).map((c) => c.id).sort();

    const generated = await generateFor(manager, partner.partnerRef);
    const reviewRef = generated.review.head.reviewRef;
    const refreshed = await refreshPartnerReviewEvidence(manager, reviewRef, { expectedDocVersion: 1 }, "req-r");
    if (!refreshed.ok) throw new Error(refreshed.message);
    const submitted = await submitPartnerReviewForReview(manager, reviewRef, { expectedDocVersion: refreshed.data.selectedVersion!.docVersion }, "req-s");
    if (!submitted.ok) throw new Error(submitted.message);
    const finalized = await finalizePartnerReview(head, reviewRef, { expectedDocVersion: submitted.data.selectedVersion!.docVersion }, "req-f");
    if (!finalized.ok) throw new Error(finalized.message);

    await analyticsContentSourceRecordsCollection().doc(record.uid).update({ likes: 5 });
    const afterChange = await rawDoc(upstreamRefs[2]!);
    const revision = await createPartnerReviewRevision(manager, reviewRef, { expectedDocVersion: finalized.data.head.docVersion }, "req-v");
    expect(revision.ok).toBe(true);

    // Upstream docs are exactly as the fixture (or the test's own edit) left them.
    const after = await Promise.all(upstreamRefs.map(rawDoc));
    expect(after[0]).toBe(before[0]);
    expect(after[1]).toBe(before[1]);
    expect(after[2]).toBe(afterChange);
    expect(after[3]).toBe(before[3]);

    const rootAfter = (await getAdminFirestore().listCollections()).map((c) => c.id).sort();
    expect(rootAfter.filter((name) => /finance|agreement|payable|invoice|payment|payee/i.test(name) && !FINANCE_AGREEMENT_ROOTS.test(name))).toEqual([]);
    // Other emulator test files run concurrently (default parallel mode) and
    // may legitimately FIRST-WRITE a root collection of their own during this
    // window (e.g. analyticsReadModelSnapshots, auditEvents), so "no new root
    // collection at all" was intermittently blamed on Partner Reviews. The
    // Finance boundary above stays strict over EVERY collection; here we assert
    // what is attributable to this module: it created no root collection other
    // than its own (nothing partnerReview*/commercial/handoff-shaped; generic
    // upstream names such as `partners` are other domains' and can be
    // first-written concurrently by their own test files).
    const newRoot = rootAfter.filter((name) => !rootBefore.includes(name) && name !== PARTNER_REVIEWS_COLLECTIONS.partnerReviews);
    expect(newRoot.filter((name) => /^partnerReview|commercial|handoff/i.test(name))).toEqual([]);
  });
});

// ==== Step 13A.1: canonical evidence, scope-safe source context, finalize freshness =====================

// Drives a fresh review to IN_REVIEW (Manager prepares) and returns what a later step needs.
async function generateAndSubmit(partnerRef: string, periodKey = "2019-03") {
  const manager = await actorFor("partnership_manager");
  const generated = await generateFor(manager, partnerRef, periodKey);
  const reviewRef = generated.review.head.reviewRef;
  const submitted = await submitPartnerReviewForReview(manager, reviewRef, { expectedDocVersion: generated.review.selectedVersion!.docVersion }, "req-submit");
  if (!submitted.ok) throw new Error(`submit failed: ${submitted.message}`);
  return { reviewRef, inReviewDocVersion: submitted.data.selectedVersion!.docVersion };
}

async function reviewState(reviewRef: string) {
  return { versions: await Promise.all([1, 2, 3].map((n) => rawDoc(versionRef(reviewRef, n)))), head: await rawHeadDoc(partnerReviewsCollection().doc(reviewRef)), eventCount: (await events(reviewRef)).length };
}

// Everything identifying the "out of scope" half of the scope fixture.
async function seedScopeFixture(over: { extraUnresolvedRecord?: boolean } = {}) {
  const tag = randomUUID().slice(0, 8);
  const partner = await seedPartner({ regionIds: ["Kerala"] });
  const campIn = await seedCampaign({ name: `SCOPE-IN Campaign ${tag}`, regionIds: ["Kerala"] });
  const campOut = await seedCampaign({ name: `SCOPE-OUT Campaign ${tag}`, regionIds: [PRIVATE_REGION] });

  // In scope for a Manager: Campaign IN (Kerala), its Assignment/Content/Analytics all Kerala.
  const a1 = await seedAssignment(partner.partnerRef, { campaignRef: campIn.campaignRef, campaignName: campIn.name, regionIds: ["Kerala"], dueAt: "2019-03-10", transient: true });
  const t1 = await seedThread(a1, { regionIds: ["Kerala"], transient: true });
  const r1 = await seedAnalyticsRecord(partner.partnerRef, { contentRef: t1.contentRef, likes: 111, regionIds: ["Kerala"], batchRef: `in-batch-${tag}`, sheetName: `InSheet-${tag}`, sourceRowNumber: 3111, matchedAssignmentRef: a1.assignmentRef, matchedCampaignRef: campIn.campaignRef });

  // Out of scope for a Manager: Campaign OUT and everything under it (private region).
  const a2 = await seedAssignment(partner.partnerRef, { campaignRef: campOut.campaignRef, campaignName: campOut.name, regionIds: [PRIVATE_REGION], dueAt: "2019-03-12" });
  const t2 = await seedThread(a2, { regionIds: [PRIVATE_REGION] });
  const r2 = await seedAnalyticsRecord(partner.partnerRef, { contentRef: t2.contentRef, likes: 222, regionIds: [PRIVATE_REGION], batchRef: `out-batch-${tag}`, sheetName: `OutSheet-${tag}`, sourceRowNumber: 4417, matchedAssignmentRef: a2.assignmentRef, matchedCampaignRef: campOut.campaignRef });

  // Assignment the Manager CAN see, under a Campaign the Manager CANNOT see.
  const a3 = await seedAssignment(partner.partnerRef, { campaignRef: campOut.campaignRef, campaignName: campOut.name, regionIds: ["Kerala"], dueAt: "2019-03-18", transient: true });

  // An unresolved-looking record (no scope evidence at all): reachable only by a GLOBAL actor.
  const r3 = over.extraUnresolvedRecord ? await seedAnalyticsRecord(partner.partnerRef, { likes: 333, regionIds: [], batchRef: `none-batch-${tag}`, sheetName: `NoneSheet-${tag}`, sourceRowNumber: 5551 }) : null;

  const hidden = [campOut.campaignRef, campOut.name, a2.assignmentRef, t2.contentRef, t2.currentLinks[0]!.normalizedUrl, r2.sourceRef, r2.batchRef, r2.sheetName, '"sourceRowNumber":4417'];
  const visibleToManager = [campIn.campaignRef, campIn.name, a1.assignmentRef, a3.assignmentRef, t1.contentRef, t1.currentLinks[0]!.normalizedUrl, r1.sourceRef, r1.batchRef, r1.sheetName, '"sourceRowNumber":3111'];
  return { tag, partner, campIn, campOut, a1, t1, r1, a2, t2, r2, a3, r3, hidden, visibleToManager };
}

function expectNone(json: string, needles: string[]) {
  for (const needle of needles) expect({ needle, present: json.includes(needle) }).toEqual({ needle, present: false });
}
function expectAll(json: string, needles: string[]) {
  for (const needle of needles) expect({ needle, present: json.includes(needle) }).toEqual({ needle, present: true });
}

// Everything in a production/compliance/performance row that is NOT identity (must be canonical for every actor).
function sanitizedRows(snapshot: { production: { assignments: object[] }; compliance: { assignments: object[] }; performance: { records: object[] } }) {
  const drop = (row: object, keys: string[]) => Object.fromEntries(Object.entries(row).filter(([key]) => !keys.includes(key)));
  const thread = (row: object) => {
    const t = (row as { thread: object | null }).thread;
    return t ? drop(t, ["contentRef", "links", "redactedContext"]) : null;
  };
  return {
    production: snapshot.production.assignments.map((row) => ({ ...drop(row, ["itemKey", "assignmentRef", "campaignRef", "campaignName", "thread", "redactedContext"]), thread: thread(row) })),
    compliance: snapshot.compliance.assignments.map((row) => drop(row, ["itemKey", "assignmentRef", "redactedContext"])),
    performance: snapshot.performance.records.map((row) => {
      const provenance = drop((row as { provenance: object }).provenance, ["batchRef", "sheetName", "sourceRowNumber"]);
      return { ...drop(row, ["itemKey", "sourceRecordRef", "matchedContentRef", "matchedAssignmentRef", "matchedCampaignRef", "matchedPartnerAccountRef", "postUrl", "provenance", "redactedContext"]), provenance };
    }),
  };
}

describe("canonical evidence is actor-independent (Step 13A.1)", () => {
  it("the stored snapshot, sourceRefs and sourceFingerprint are identical whichever actor generated or refreshed the review; only the DTO differs by actor", async () => {
    const manager = await actorFor("partnership_manager");
    const head = await actorFor("partnership_head");
    const admin = await actorFor("super_admin");
    // Every source lives in the private region: the Manager and the Head cannot access ANY of it.
    const { partner, assignment, thread, record } = await seedRichPartner();

    const generated = await generateFor(manager, partner.partnerRef);
    const reviewRef = generated.review.head.reviewRef;
    const stored = [JSON.parse(await rawDoc(versionRef(reviewRef, 1)))];

    // The Manager's own response carries none of the identifying context ...
    expectNone(JSON.stringify(generated.review), [assignment.assignmentRef, assignment.campaignRef, "PR Test Campaign", thread.contentRef, record.sourceRef, record.batchRef]);
    // ... yet the STORED canonical doc carries all of it (redaction is DTO-only).
    expectAll(JSON.stringify(stored[0].snapshot), [assignment.assignmentRef, assignment.campaignRef, "PR Test Campaign", thread.contentRef, record.sourceRef, record.batchRef]);
    expect(stored[0].sourceRefs).toEqual(expect.arrayContaining([{ type: "assignment", ref: assignment.assignmentRef }, { type: "content", ref: thread.contentRef }, { type: "analyticsSourceRecord", ref: record.sourceRef }]));

    // Refresh by the Head (no access to the private region), then by the global actor.
    const byHead = await refreshPartnerReviewEvidence(head, reviewRef, { expectedDocVersion: 1 }, "req-head-refresh");
    expect(byHead.ok).toBe(true);
    stored.push(JSON.parse(await rawDoc(versionRef(reviewRef, 1))));
    const byAdmin = await refreshPartnerReviewEvidence(admin, reviewRef, { expectedDocVersion: 2 }, "req-admin-refresh");
    expect(byAdmin.ok).toBe(true);
    stored.push(JSON.parse(await rawDoc(versionRef(reviewRef, 1))));

    const comparable = (doc: { snapshot: EvidenceSnapshot; sourceRefs: unknown; sourceFingerprint: string }) => ({ ...doc.snapshot, evidenceCutoff: "<time>", sourceRefs: doc.sourceRefs, fingerprint: doc.sourceFingerprint });
    expect(comparable(stored[1])).toEqual(comparable(stored[0]));
    expect(comparable(stored[2])).toEqual(comparable(stored[0]));
    expect(new Set(stored.map((doc) => doc.sourceFingerprint)).size).toBe(1);
    expect(stored[1].lastRefreshedByUserRef).toBe(head.userRef);
    expect(stored[2].lastRefreshedByUserRef).toBe(admin.userRef);
  });

  it("the freshness fingerprints returned to different actors for the same version are identical (detail, version and freshness endpoints)", async () => {
    const { partner } = await seedRichPartner({ regionIds: ["Kerala"] });
    const admin = await actorFor("super_admin");
    const generated = await generateFor(admin, partner.partnerRef);
    const reviewRef = generated.review.head.reviewRef;

    const seen = new Set<string>();
    for (const role of ["super_admin", "partnership_head", "partnership_manager", "viewer", "analyst"]) {
      const actor = await actorFor(role);
      const inspected = await inspectPartnerReviewFreshness(actor, reviewRef);
      const detail = await getPartnerReview(actor, reviewRef);
      const versionRead = await getPartnerReviewVersion(actor, reviewRef, "1");
      if (!inspected.ok || !detail.ok || !versionRead.ok) throw new Error(`read failed for ${role}`);
      for (const freshness of [inspected.data.freshness, detail.data.freshness!, versionRead.data.freshness]) {
        seen.add(`${freshness.snapshotFingerprint}|${freshness.currentFingerprint}|${freshness.state}`);
      }
      expect(detail.data.selectedVersion!.sourceFingerprint).toBe(inspected.data.freshness.snapshotFingerprint);
    }
    expect(seen.size).toBe(1);
  });

  it("reads by different actors never change the stored version/head docs or append an event (byte-identical before/after)", async () => {
    const { partner } = await seedRichPartner({ regionIds: ["Kerala"] });
    const admin = await actorFor("super_admin");
    const { reviewRef } = await generateAndSubmit(partner.partnerRef);
    const before = await reviewState(reviewRef);

    for (const role of ["super_admin", "partnership_head", "partnership_manager", "viewer", "analyst"]) {
      const actor = await actorFor(role);
      expect((await getPartnerReview(actor, reviewRef)).ok).toBe(true);
      expect((await getPartnerReviewVersion(actor, reviewRef, "1")).ok).toBe(true);
      expect((await inspectPartnerReviewFreshness(actor, reviewRef)).ok).toBe(true);
      expect((await listPartnerReviewHeads(actor, { partnerRef: partner.partnerRef })).ok).toBe(true);
      expect((await deriveNeedsReview(actor, { partnerRef: partner.partnerRef, periodKey: "2019-03" })).ok).toBe(true);
    }
    void admin;
    expect(await reviewState(reviewRef)).toEqual(before);
  });
});

describe("actor-scoped source context (Step 13A.1)", () => {
  it("a Manager with Partner Review + Partner access but NOT one source Campaign's scope: canonical totals for both Assignments, in-scope context present, the out-of-scope Campaign's identity absent", async () => {
    const manager = await actorFor("partnership_manager");
    const admin = await actorFor("super_admin");
    const head = await actorFor("partnership_head");
    const fx = await seedScopeFixture();

    const generated = await generateFor(manager, fx.partner.partnerRef);
    const reviewRef = generated.review.head.reviewRef;
    const managerDetail = await getPartnerReview(manager, reviewRef);
    const adminDetail = await getPartnerReview(admin, reviewRef);
    const headDetail = await getPartnerReview(head, reviewRef);
    if (!managerDetail.ok || !adminDetail.ok || !headDetail.ok) throw new Error("read failed");
    const m = managerDetail.data.selectedVersion!;
    const a = adminDetail.data.selectedVersion!;

    // Canonical: same fingerprint, same totals/evidence for BOTH Assignments, for every actor.
    expect(m.sourceFingerprint).toBe(a.sourceFingerprint);
    expect(m.snapshot.production.assignments).toHaveLength(3);
    expect(m.snapshot.compliance.assignments).toHaveLength(3);
    expect(m.snapshot.performance.records).toHaveLength(2);
    expect(m.snapshot.completeness).toEqual(a.snapshot.completeness);
    expect(m.snapshot.completeness.counts).toMatchObject({ assignmentsInPeriod: 3, analyticsRecordsInPeriod: 2, threadsFound: 2 });
    expect(m.snapshot.performance.metricPresence).toEqual(a.snapshot.performance.metricPresence);
    expect(sanitizedRows(m.snapshot)).toEqual(sanitizedRows(a.snapshot));
    expect(m.snapshot.performance.records.map((r) => r.metrics.likes).sort()).toEqual([111, 222]);

    // In-scope context is present ... and NONE of the out-of-scope Campaign's identity, anywhere in the serialized response.
    const managerJson = JSON.stringify(managerDetail.data);
    expectAll(managerJson, fx.visibleToManager);
    expectNone(managerJson, fx.hidden);
    // The generate response itself (a mutation result) is redacted identically.
    const generatedJson = JSON.stringify(generated.review);
    expectAll(generatedJson, fx.visibleToManager);
    expectNone(generatedJson, fx.hidden);

    // Assignment visible but its Campaign not: Assignment context shown, Campaign context removed (independent decisions).
    const a3Row = m.snapshot.production.assignments.find((row) => row.assignmentRef === fx.a3.assignmentRef)!;
    expect(a3Row).toMatchObject({ assignmentRef: fx.a3.assignmentRef, campaignRef: null, campaignName: null });
    expect(a3Row.redactedContext).toContainEqual({ sourceType: "campaign", redacted: true });
    const a1Row = m.snapshot.production.assignments.find((row) => row.assignmentRef === fx.a1.assignmentRef)!;
    expect(a1Row).toMatchObject({ campaignRef: fx.campIn.campaignRef, campaignName: fx.campIn.name, redactedContext: [] });
    // The out-of-scope Assignment row keeps only sanitized facts + a neutral marker + a synthetic key.
    const hiddenRows = m.snapshot.production.assignments.filter((row) => row.assignmentRef === null);
    expect(hiddenRows).toHaveLength(1);
    expect(hiddenRows[0]).toMatchObject({ campaignRef: null, campaignName: null, status: "IN_PROGRESS", dueAt: "2019-03-12", eventDate: "2019-03-12", requiredCount: 2 });
    expect(hiddenRows[0]!.redactedContext).toEqual(expect.arrayContaining([{ sourceType: "assignment", redacted: true }, { sourceType: "campaign", redacted: true }, { sourceType: "content", redacted: true }]));
    expect(hiddenRows[0]!.thread).toMatchObject({ contentRef: null, links: null, linkCount: 1, status: "UNDER_REVIEW" });
    expect(typeof hiddenRows[0]!.itemKey).toBe("string");
    const hiddenRecord = m.snapshot.performance.records.find((r) => r.sourceRecordRef === null)!;
    expect(hiddenRecord).toMatchObject({ postUrl: null, matchedContentRef: null, provenance: { batchRef: null, sheetName: null, sourceRowNumber: null }, metrics: { likes: 222 } });

    // sourceRefs = only the accessible refs; the rest are counted, not named.
    expect(m.sourceRefs).toEqual(
      expect.arrayContaining([
        { type: "assignment", ref: fx.a1.assignmentRef },
        { type: "assignment", ref: fx.a3.assignmentRef },
        { type: "campaign", ref: fx.campIn.campaignRef },
        { type: "content", ref: fx.t1.contentRef },
        { type: "analyticsSourceRecord", ref: fx.r1.sourceRef },
      ]),
    );
    expect(m.sourceRefs).toHaveLength(5);
    expect(m.withheldSourceCounts).toEqual({ assignment: 1, campaign: 1, content: 1, analyticsSourceRecord: 1 });
    expect(m.snapshot.sourceRefs).toEqual(m.sourceRefs);

    // A GLOBAL actor sees everything and nothing is withheld.
    const adminJson = JSON.stringify(adminDetail.data);
    expectAll(adminJson, [...fx.visibleToManager, ...fx.hidden]);
    expect(a.withheldSourceCounts).toEqual({ assignment: 0, campaign: 0, content: 0, analyticsSourceRecord: 0 });
    expect(a.sourceRefs).toHaveLength(9);

    // The Head does not hold the private region either: same redaction, same canonical totals.
    const headJson = JSON.stringify(headDetail.data);
    expectNone(headJson, fx.hidden);
    expect(headDetail.data.selectedVersion!.withheldSourceCounts).toEqual(m.withheldSourceCounts);
    expect(headDetail.data.selectedVersion!.sourceFingerprint).toBe(a.sourceFingerprint);

    // The stored canonical doc is untouched by any of this and still complete.
    const stored = await rawDoc(versionRef(reviewRef, 1));
    expectAll(stored, [...fx.visibleToManager, ...fx.hidden]);
  });

  it("a direct request by reviewRef still requires live Partner scope, and the freshness endpoint leaks no source identity", async () => {
    const manager = await actorFor("partnership_manager");
    const admin = await actorFor("super_admin");
    const fx = await seedScopeFixture();
    const generated = await generateFor(admin, fx.partner.partnerRef);
    const reviewRef = generated.review.head.reviewRef;

    const freshness = await inspectPartnerReviewFreshness(manager, reviewRef);
    if (!freshness.ok) throw new Error(freshness.message);
    expectNone(JSON.stringify(freshness.data), [...fx.hidden, ...fx.visibleToManager]);
    expect(Object.keys(freshness.data).sort()).toEqual(["freshness", "periodKey", "reviewRef"]);

    // Move the Partner out of the Manager's scope: the same reviewRef is now denied everywhere.
    await partnersCollection().doc(fx.partner.uid).update({ regionIds: [PRIVATE_REGION] });
    expect(await getPartnerReview(manager, reviewRef)).toMatchObject({ ok: false, code: "unauthorized", reason: "scope_denied" });
    expect(await getPartnerReviewVersion(manager, reviewRef, "1")).toMatchObject({ ok: false, code: "unauthorized", reason: "scope_denied" });
    expect(await inspectPartnerReviewFreshness(manager, reviewRef)).toMatchObject({ ok: false, code: "unauthorized", reason: "scope_denied" });
  });

  it("Viewer (no Assignment/Content/Analytics-explorer access) sees canonical totals and metric values with every source identifier withheld; Analyst (Analytics explorer) sees only its in-scope Analytics record's identifiers", async () => {
    const admin = await actorFor("super_admin");
    const viewer = await actorFor("viewer");
    const analyst = await actorFor("analyst");
    const fx = await seedScopeFixture();
    const generated = await generateFor(admin, fx.partner.partnerRef);
    const reviewRef = generated.review.head.reviewRef;
    const adminView = generated.review.selectedVersion!;

    const viewerDetail = await getPartnerReview(viewer, reviewRef);
    if (!viewerDetail.ok) throw new Error(viewerDetail.message);
    const v = viewerDetail.data.selectedVersion!;
    expect(v.sourceFingerprint).toBe(adminView.sourceFingerprint);
    expect(v.snapshot.completeness).toEqual(adminView.snapshot.completeness);
    expect(sanitizedRows(v.snapshot)).toEqual(sanitizedRows(adminView.snapshot));
    expect(v.snapshot.performance.records.map((r) => r.metrics.likes).sort()).toEqual([111, 222]);
    expectNone(JSON.stringify(viewerDetail.data), [...fx.hidden, ...fx.visibleToManager]);
    expect(v.sourceRefs).toEqual([]);
    expect(v.withheldSourceCounts).toEqual({ assignment: 3, campaign: 2, content: 2, analyticsSourceRecord: 2 });

    const analystDetail = await getPartnerReview(analyst, reviewRef);
    if (!analystDetail.ok) throw new Error(analystDetail.message);
    const analystJson = JSON.stringify(analystDetail.data);
    const an = analystDetail.data.selectedVersion!;
    // Analytics explorer access + Kerala scope: record 1 identifiers shown, record 2 (private region) withheld.
    expectAll(analystJson, [fx.r1.sourceRef, fx.r1.batchRef, fx.r1.sheetName, '"sourceRowNumber":3111']);
    expectNone(analystJson, [fx.r2.sourceRef, fx.r2.batchRef, fx.r2.sheetName, '"sourceRowNumber":4417', fx.campOut.name, fx.campOut.campaignRef, fx.t2.contentRef]);
    // No Assignment/Content access: those rows carry no Assignment or Content identity.
    for (const row of an.snapshot.production.assignments) expect(row).toMatchObject({ assignmentRef: null, campaignRef: null, campaignName: null });
    for (const row of an.snapshot.production.assignments) expect(row.thread?.contentRef ?? null).toBeNull();
    expect(an.withheldSourceCounts).toEqual({ assignment: 3, campaign: 2, content: 2, analyticsSourceRecord: 1 });
    expect(an.sourceRefs).toEqual([{ type: "analyticsSourceRecord", ref: fx.r1.sourceRef }]);
  });

  it("every mutation response (generate existing/created, refresh, submit, finalize, revision, version read) is redacted for the acting user", async () => {
    const manager = await actorFor("partnership_manager");
    const head = await actorFor("partnership_head");
    const fx = await seedScopeFixture();

    const generated = await generateFor(manager, fx.partner.partnerRef);
    const reviewRef = generated.review.head.reviewRef;
    const responses: Array<[string, unknown]> = [["generate", generated.review]];

    const existing = await generatePartnerReviewDraft(manager, { partnerRef: fx.partner.partnerRef, periodKey: "2019-03" }, "req-generate-again");
    if (!existing.ok) throw new Error(existing.message);
    expect(existing.data.outcome).toBe("existing");
    responses.push(["generate-existing", existing.data.review]);

    const refreshed = await refreshPartnerReviewEvidence(manager, reviewRef, { expectedDocVersion: 1 }, "req-refresh");
    if (!refreshed.ok) throw new Error(refreshed.message);
    responses.push(["refresh", refreshed.data]);
    const submitted = await submitPartnerReviewForReview(manager, reviewRef, { expectedDocVersion: refreshed.data.selectedVersion!.docVersion }, "req-submit");
    if (!submitted.ok) throw new Error(submitted.message);
    responses.push(["submit", submitted.data]);
    const finalized = await finalizePartnerReview(head, reviewRef, { expectedDocVersion: submitted.data.selectedVersion!.docVersion }, "req-finalize");
    if (!finalized.ok) throw new Error(finalized.message);
    responses.push(["finalize", finalized.data]);

    // New in-scope upstream evidence -> revision (Draft v2).
    await seedAssignment(fx.partner.partnerRef, { campaignRef: fx.campOut.campaignRef, campaignName: fx.campOut.name, regionIds: ["Kerala"], dueAt: "2019-03-25", transient: true });
    const revision = await createPartnerReviewRevision(manager, reviewRef, { expectedDocVersion: finalized.data.head.docVersion }, "req-revision");
    if (!revision.ok) throw new Error(revision.message);
    responses.push(["revision", revision.data]);
    const versionRead = await getPartnerReviewVersion(manager, reviewRef, "2");
    if (!versionRead.ok) throw new Error(versionRead.message);
    responses.push(["version", versionRead.data]);
    const v1 = await getPartnerReviewVersion(head, reviewRef, "1");
    if (!v1.ok) throw new Error(v1.message);
    responses.push(["version-1-head", v1.data]);

    for (const [label, body] of responses) {
      const json = JSON.stringify(body);
      expect({ label, leaked: fx.hidden.filter((needle) => json.includes(needle)) }).toEqual({ label, leaked: [] });
      // The in-scope context is still there (redaction is targeted, not blanket).
      expect({ label, hasInScope: json.includes(fx.campIn.name) && json.includes(fx.a1.assignmentRef) }).toEqual({ label, hasInScope: true });
    }
  });

  it("the actor source-access resolver reproduces the accepted per-domain gates and the Analytics explorer's own scope, record by record", async () => {
    const admin = await actorFor("super_admin");
    const fx = await seedScopeFixture({ extraUnresolvedRecord: true });
    const generated = await generateFor(admin, fx.partner.partnerRef);
    const reviewRef = generated.review.head.reviewRef;
    const stored = JSON.parse(await rawDoc(versionRef(reviewRef, 1))) as { snapshot: EvidenceSnapshot };

    for (const role of ["super_admin", "partnership_head", "partnership_manager", "viewer", "analyst"]) {
      const actor = await actorFor(role);
      const access = await resolveActorSourceAccess(actor, stored.snapshot);

      const campaignsFeature = (await requireCampaignsFeatureAccess(actor)).ok;
      for (const campaign of [fx.campIn, fx.campOut]) expect({ role, campaign: campaign.campaignRef, allowed: access.campaigns.has(campaign.campaignRef) }).toEqual({ role, campaign: campaign.campaignRef, allowed: campaignsFeature && (await requireCampaignInScope(actor, campaign)).ok });

      const assignmentsFeature = (await requireAssignmentsFeatureAccess(actor)).ok;
      for (const assignment of [fx.a1, fx.a2, fx.a3]) expect({ role, assignment: assignment.assignmentRef, allowed: access.assignments.has(assignment.assignmentRef) }).toEqual({ role, assignment: assignment.assignmentRef, allowed: assignmentsFeature && (await requireAssignmentInScope(actor, assignment)).ok });

      const contentFeature = (await requireContentFeatureAccess(actor)).ok;
      for (const thread of [fx.t1, fx.t2]) expect({ role, content: thread.contentRef, allowed: access.contents.has(thread.contentRef) }).toEqual({ role, content: thread.contentRef, allowed: contentFeature && (await requireContentInScope(actor, thread)).ok });

      // Analytics: exactly the set the real explorer would list for this actor.
      const explorer = (await requireAnalyticsExploreAccess(actor)).ok ? await listAnalyticsSourceRecords(actor, { recordKind: "content", matchedPartnerRef: fx.partner.partnerRef, limit: 100 }) : null;
      const listed = new Set(explorer && explorer.ok ? explorer.data.records.map((record) => record.sourceRef) : []);
      for (const record of [fx.r1, fx.r2, fx.r3!]) expect({ role, record: record.sourceRef, allowed: access.analyticsRecords.has(record.sourceRef) }).toEqual({ role, record: record.sourceRef, allowed: listed.has(record.sourceRef) });
    }
  });
});

describe("list vs detail freshness boundary (Step 13A.1)", () => {
  it("a list call never invokes the evidence collector; each single-review read invokes it exactly once", async () => {
    const head = await actorFor("partnership_head");
    const { partner } = await seedRichPartner({ regionIds: ["Kerala"] });
    const generated = await generateFor(head, partner.partnerRef);
    const reviewRef = generated.review.head.reviewRef;

    const spy = vi.spyOn(evidenceCollector, "collectPartnerEvidence");

    const list = await listPartnerReviewHeads(head, { partnerRef: partner.partnerRef });
    expect(list.ok && list.data.heads).toHaveLength(1);
    const unfiltered = await listPartnerReviewHeads(head, { limit: 50, periodKey: "2019-03" });
    expect(unfiltered.ok).toBe(true);
    expect(spy).toHaveBeenCalledTimes(0);
    // The list DTO carries no snapshot and no freshness.
    expect(Object.keys(list.ok ? list.data.heads[0]! : {})).not.toEqual(expect.arrayContaining(["freshness"]));

    await getPartnerReview(head, reviewRef);
    expect(spy).toHaveBeenCalledTimes(1);
    await getPartnerReviewVersion(head, reviewRef, "1");
    expect(spy).toHaveBeenCalledTimes(2);
    await inspectPartnerReviewFreshness(head, reviewRef);
    expect(spy).toHaveBeenCalledTimes(3);
  });
});

describe("finalize never knowingly freezes stale evidence (Step 13A.1)", () => {
  it("cheap preconditions (Draft, wrong docVersion, no open version, unknown version) are rejected BEFORE any upstream read", async () => {
    const manager = await actorFor("partnership_manager");
    const head = await actorFor("partnership_head");
    const { partner } = await seedRichPartner();
    const generated = await generateFor(manager, partner.partnerRef);
    const reviewRef = generated.review.head.reviewRef;
    const spy = vi.spyOn(evidenceCollector, "collectPartnerEvidence");

    expect(await finalizePartnerReview(head, reviewRef, { expectedDocVersion: 1 }, "req-draft")).toMatchObject({ ok: false, code: "invalid_input" });
    expect(await finalizePartnerReview(head, reviewRef, { version: 9, expectedDocVersion: 1 }, "req-unknown")).toMatchObject({ ok: false, code: "not_found" });
    const submitted = await submitPartnerReviewForReview(manager, reviewRef, { expectedDocVersion: 1 }, "req-submit");
    if (!submitted.ok) throw new Error(submitted.message);
    const submitCalls = spy.mock.calls.length; // submit's own response computes freshness once
    expect(await finalizePartnerReview(head, reviewRef, { expectedDocVersion: 1 }, "req-stale")).toMatchObject({ ok: false, code: "stale_write" });
    expect(await finalizePartnerReview(head, reviewRef, { expectedDocVersion: 99 }, "req-stale-2")).toMatchObject({ ok: false, code: "stale_write" });
    expect(spy.mock.calls.length).toBe(submitCalls);

    // A current In Review version passes the guard and finalizes (the guard DOES read upstream once).
    const done = await finalizePartnerReview(head, reviewRef, { expectedDocVersion: submitted.data.selectedVersion!.docVersion }, "req-finalize");
    expect(done.ok).toBe(true);
    const afterFinalize = spy.mock.calls.length;
    expect(afterFinalize).toBeGreaterThan(submitCalls);

    // Now nothing is open: rejected without another upstream read.
    expect(await finalizePartnerReview(head, reviewRef, { expectedDocVersion: 3 }, "req-none-open")).toMatchObject({ ok: false, code: "invalid_input" });
    expect(await finalizePartnerReview(head, reviewRef, { version: 1, expectedDocVersion: 3 }, "req-already")).toMatchObject({ ok: false, code: "invalid_input" });
    expect(spy.mock.calls.length).toBe(afterFinalize);
  });

  it("incomplete-but-current evidence still finalizes, and the frozen snapshot keeps recording the incompleteness", async () => {
    const head = await actorFor("partnership_head");
    const partner = await seedPartner();
    const assignment = await seedAssignment(partner.partnerRef);
    await seedThread(assignment, { status: "APPROVED", approvedAt: "2019-03-09T00:00:00.000Z" });
    // Approved Content with NO matched Analytics, plus a row with no reporting period.
    await seedAnalyticsRecord(partner.partnerRef, { contentRef: null, period: null });

    const { reviewRef, inReviewDocVersion } = await generateAndSubmit(partner.partnerRef);
    const finalized = await finalizePartnerReview(head, reviewRef, { expectedDocVersion: inReviewDocVersion }, "req-finalize");
    expect(finalized.ok).toBe(true);
    if (!finalized.ok) return;

    const reasons = finalized.data.selectedVersion!.snapshot.completeness.incompleteReasons;
    expect(reasons).toEqual(expect.arrayContaining(["approved_content_without_analytics", "analytics_records_without_reporting_period"]));
    expect(finalized.data.selectedVersion!.snapshot.completeness.counts).toMatchObject({ approvedContentWithoutAnalytics: 1, analyticsRecordsExcludedNoReportingPeriod: 1, analyticsRecordsInPeriod: 0 });
    expect(finalized.data.freshness).toMatchObject({ state: "evidence_incomplete" });
    // The stored, frozen doc carries the same reasons.
    const stored = JSON.parse(await rawDoc(versionRef(reviewRef, 1)));
    expect(stored).toMatchObject({ status: "FINALIZED" });
    expect(stored.snapshot.completeness.incompleteReasons).toEqual(expect.arrayContaining(["approved_content_without_analytics", "analytics_records_without_reporting_period"]));
  });

  const upstreamChanges: Array<[string, (ctx: Awaited<ReturnType<typeof seedRichPartner>>) => Promise<void>]> = [
    ["a new in-period Assignment", async (ctx) => void (await seedAssignment(ctx.partner.partnerRef, { dueAt: "2019-03-21", campaignName: "Arrived Later" }))],
    ["a Content status change", async (ctx) => void (await contentCollection().doc(ctx.thread.uid).update({ status: "APPROVED", approvedAt: "2019-03-15T00:00:00.000Z", version: 4, updatedAt: new Date().toISOString() }))],
    ["a new in-period Analytics record", async (ctx) => void (await seedAnalyticsRecord(ctx.partner.partnerRef, { contentRef: null, likes: 5 }))],
  ];

  for (const [label, change] of upstreamChanges) {
    it(`an unincorporated upstream change (${label}) blocks finalize with REFRESH_REQUIRED (409), writes nothing, never auto-refreshes; after an explicit refresh, finalize succeeds`, async () => {
      const manager = await actorFor("partnership_manager");
      const head = await actorFor("partnership_head");
      const ctx = await seedRichPartner();
      const { reviewRef, inReviewDocVersion } = await generateAndSubmit(ctx.partner.partnerRef);
      const before = await reviewState(reviewRef);

      await change(ctx);
      const blocked = await finalizePartnerReview(head, reviewRef, { expectedDocVersion: inReviewDocVersion }, "req-blocked");
      expect(blocked).toMatchObject({ ok: false, code: "not_ready" });
      if (blocked.ok) return;
      expect(blocked.blockers).toEqual([expect.objectContaining({ code: "REFRESH_REQUIRED" })]);
      expect(blocked.message).toMatch(/refresh/i);

      // The module's typed not-ready convention: HTTP 409 with `blockers`.
      const http = toPartnerReviewsHttpResponse(blocked);
      expect(http.status).toBe(409);
      expect(await http.json()).toMatchObject({ error: expect.stringMatching(/refresh/i), blockers: [{ code: "REFRESH_REQUIRED" }] });

      // No write of any kind: version, head and event log are byte/count identical, and it was not silently refreshed.
      expect(await reviewState(reviewRef)).toEqual(before);
      expect(JSON.parse(before.versions[0]!).status).toBe("IN_REVIEW");
      expect(JSON.parse(before.versions[0]!).lastRefreshedAt).toBeNull();

      // The reviewer explicitly refreshes the In Review version, then finalizes.
      const refreshed = await refreshPartnerReviewEvidence(manager, reviewRef, { expectedDocVersion: inReviewDocVersion }, "req-refresh");
      if (!refreshed.ok) throw new Error(refreshed.message);
      expect(refreshed.data.selectedVersion).toMatchObject({ status: "IN_REVIEW", docVersion: inReviewDocVersion + 1 });
      expect(refreshed.data.freshness?.state).toMatch(/current|evidence_incomplete/);
      const finalized = await finalizePartnerReview(head, reviewRef, { expectedDocVersion: refreshed.data.selectedVersion!.docVersion }, "req-finalize");
      expect(finalized.ok).toBe(true);
      if (finalized.ok) expect(finalized.data.selectedVersion).toMatchObject({ status: "FINALIZED", finalizedByUserRef: head.userRef });
    });
  }

  it("a stale finalize of a REVISION leaves the prior FINALIZED version, the head and the events untouched; after refresh the replacement finalizes and supersedes it", async () => {
    const manager = await actorFor("partnership_manager");
    const head = await actorFor("partnership_head");
    const ctx = await seedRichPartner();
    const { reviewRef, finalized } = await generateAndFinalize(ctx.partner.partnerRef);

    await seedAssignment(ctx.partner.partnerRef, { dueAt: "2019-03-22", campaignName: "Before Revision" });
    const revision = await createPartnerReviewRevision(manager, reviewRef, { expectedDocVersion: finalized.head.docVersion }, "req-revision");
    if (!revision.ok) throw new Error(revision.message);
    const submitted = await submitPartnerReviewForReview(manager, reviewRef, { expectedDocVersion: 1 }, "req-submit-2");
    if (!submitted.ok) throw new Error(submitted.message);

    // Upstream moves again after the revision was captured.
    await seedAssignment(ctx.partner.partnerRef, { dueAt: "2019-03-28", campaignName: "After Revision" });
    const before = await reviewState(reviewRef);
    const blocked = await finalizePartnerReview(head, reviewRef, { expectedDocVersion: submitted.data.selectedVersion!.docVersion }, "req-blocked");
    expect(blocked).toMatchObject({ ok: false, code: "not_ready" });
    expect(await reviewState(reviewRef)).toEqual(before);
    expect(JSON.parse(before.versions[0]!)).toMatchObject({ status: "FINALIZED", supersededAt: null, supersededByVersion: null });
    expect(JSON.parse(before.versions[1]!).status).toBe("IN_REVIEW");
    expect(JSON.parse(before.head)).toMatchObject({ currentFinalizedVersion: 1, openVersion: 2 });
    expect((await events(reviewRef)).filter((e) => e.kind === "superseded")).toHaveLength(0);

    const refreshed = await refreshPartnerReviewEvidence(manager, reviewRef, { expectedDocVersion: submitted.data.selectedVersion!.docVersion }, "req-refresh");
    if (!refreshed.ok) throw new Error(refreshed.message);
    const done = await finalizePartnerReview(head, reviewRef, { expectedDocVersion: refreshed.data.selectedVersion!.docVersion }, "req-finalize-2");
    expect(done.ok).toBe(true);
    expect(JSON.parse(await rawDoc(versionRef(reviewRef, 1)))).toMatchObject({ status: "SUPERSEDED", supersededByVersion: 2 });
  });

  it("concurrent finalize requests on STALE evidence are all rejected with zero writes; on CURRENT evidence exactly one wins", async () => {
    const head = await actorFor("partnership_head");
    const admin = await actorFor("super_admin");
    const ctx = await seedRichPartner();
    const { reviewRef, inReviewDocVersion } = await generateAndSubmit(ctx.partner.partnerRef);

    await seedAssignment(ctx.partner.partnerRef, { dueAt: "2019-03-27", campaignName: "Concurrent Arrival" });
    const before = await reviewState(reviewRef);
    const stale = await Promise.all([finalizePartnerReview(head, reviewRef, { expectedDocVersion: inReviewDocVersion }, "req-s1"), finalizePartnerReview(admin, reviewRef, { expectedDocVersion: inReviewDocVersion }, "req-s2"), finalizePartnerReview(head, reviewRef, { expectedDocVersion: inReviewDocVersion }, "req-s3")]);
    for (const result of stale) expect(result).toMatchObject({ ok: false, code: "not_ready" });
    expect(await reviewState(reviewRef)).toEqual(before);

    const manager = await actorFor("partnership_manager");
    const refreshed = await refreshPartnerReviewEvidence(manager, reviewRef, { expectedDocVersion: inReviewDocVersion }, "req-refresh");
    if (!refreshed.ok) throw new Error(refreshed.message);
    const docVersion = refreshed.data.selectedVersion!.docVersion;
    const current = await Promise.all([finalizePartnerReview(head, reviewRef, { expectedDocVersion: docVersion }, "req-c1"), finalizePartnerReview(admin, reviewRef, { expectedDocVersion: docVersion }, "req-c2"), finalizePartnerReview(head, reviewRef, { expectedDocVersion: docVersion }, "req-c3")]);
    expect(current.filter((r) => r.ok)).toHaveLength(1);
    for (const loser of current.filter((r) => !r.ok)) expect(["stale_write", "invalid_input", "conflict"]).toContain(loser.ok ? "ok" : loser.code);
    expect((await events(reviewRef)).filter((e) => e.kind === "finalized")).toHaveLength(1);
  });

  it("after a successful finalize, a later upstream change yields revision_available without mutating the finalized version; the revision flow then keeps it FINALIZED until the replacement finalizes", async () => {
    const manager = await actorFor("partnership_manager");
    const head = await actorFor("partnership_head");
    const ctx = await seedRichPartner();
    const { reviewRef, finalized } = await generateAndFinalize(ctx.partner.partnerRef);
    expect(finalized.freshness?.state).toBe("current");
    const before = await reviewState(reviewRef);

    await seedAssignment(ctx.partner.partnerRef, { dueAt: "2019-03-24", campaignName: "Post Finalize" });
    const inspected = await inspectPartnerReviewFreshness(head, reviewRef);
    expect(inspected.ok && inspected.data.freshness.state).toBe("revision_available");
    expect((await getPartnerReview(head, reviewRef)).ok).toBe(true);
    expect(await deriveNeedsReview(head, { partnerRef: ctx.partner.partnerRef, periodKey: "2019-03" })).toMatchObject({ ok: true, data: { needsReview: true, reason: "revision_available" } });
    expect(await reviewState(reviewRef)).toEqual(before);

    const revision = await createPartnerReviewRevision(manager, reviewRef, { expectedDocVersion: finalized.head.docVersion }, "req-revision");
    expect(revision.ok).toBe(true);
    expect(JSON.parse(await rawDoc(versionRef(reviewRef, 1))).status).toBe("FINALIZED");
    expect(JSON.parse(await rawDoc(versionRef(reviewRef, 1)))).toEqual(JSON.parse(before.versions[0]!));
  });
});

// ==== Step 13A.1 (revised): commercial evidence + finalized-review handoff =========================
//
// There is no Agreement module, so every Agreement-governed value reaches the
// snapshot through the ONE test-injectable CommercialPolicyProvider seam
// (commercial-policy.ts). Each test names the policy for its OWN unique
// Partner only (a Map keyed by partnerRef), so nothing here can change another
// test's - or another file's - evidence. Default provider = none.

const stubPolicies = new Map<string, () => GoverningCommercialPolicy | null>();
beforeEach(() => {
  setCommercialPolicyProviderForTests(async (partnerRef) => stubPolicies.get(partnerRef)?.() ?? null);
});
afterEach(() => {
  setCommercialPolicyProviderForTests(null);
  stubPolicies.clear();
  httpActor = null;
});

async function seedChannelRecord(partnerRef: string, over: { accountRef: string; followers: number | null; day: string; regionIds?: string[] }) {
  const uid = `pr-test-ch-${randomUUID()}`;
  const record = analyticsChannelSourceRecordDocSchema.parse({
    uid,
    sourceRef: uid,
    batchRef: `pr-test-ch-batch-${runId}`,
    sheetName: "Channels",
    sourceRowNumber: 2,
    platform: "instagram",
    rowIdentityKey: `pr-test-ch:${uid}`,
    rawUsername: null,
    rawProfileUrl: null,
    rawPlatformAccountId: null,
    rawFollowers: null,
    rawAccountOrChannelName: null,
    normalizedProfileUrl: null,
    profileFollowers: over.followers,
    reportingPeriod: { start: over.day, end: over.day },
    matchState: "MATCHED",
    matchEvidence: { tier: "identity_claim", value: null, reasonCode: null, candidateCount: 1 },
    matchedPartnerRef: partnerRef,
    matchedPartnerAccountRef: over.accountRef,
    ownerUid: null,
    regionIds: over.regionIds ?? [PRIVATE_REGION],
    teamIds: [],
    createdAt: "2019-04-02T00:00:00.000Z",
  });
  const ref = analyticsChannelSourceRecordsCollection().doc(uid);
  await ref.set(record);
  analyticsCleanup.push(ref);
  return record;
}

// Two in-period Assignments (2019-03): a1 has an APPROVED thread with 2 links,
// a2 an UNDER_REVIEW thread with 3 raw links (which must never count), a
// matched Analytics record (likes 120) and two channel snapshots of one
// account (1000 -> 1100).
async function seedCommercialPartner(over: { policy?: Partial<GoverningCommercialPolicy> | null } = {}) {
  const tag = randomUUID().slice(0, 8);
  const partner = await seedPartner();
  const a1 = await seedAssignment(partner.partnerRef, { dueAt: "2019-03-10" });
  const t1 = await seedThread(a1, { status: "APPROVED", approvedAt: "2019-03-09T00:00:00.000Z", links: 2 });
  const a2 = await seedAssignment(partner.partnerRef, { dueAt: "2019-03-12" });
  const t2 = await seedThread(a2, { status: "UNDER_REVIEW", links: 3 });
  const record = await seedAnalyticsRecord(partner.partnerRef, { contentRef: t1.contentRef, likes: 120 });
  const accountRef = `pr-test-acct-${tag}`;
  const c1 = await seedChannelRecord(partner.partnerRef, { accountRef, followers: 1000, day: "2019-03-02" });
  const c2 = await seedChannelRecord(partner.partnerRef, { accountRef, followers: 1100, day: "2019-03-28" });

  const state = {
    policy: over.policy === null ? null : ({
      agreementRef: `agr-${tag}`,
      agreementVersion: 3,
      monthlyDeliverableRequirement: { requiredCount: 2, qualifyingUnit: "approved_content_thread", requirementSourceRef: `req-${tag}` },
      lfcSfcRule: { ruleRef: `rule-${tag}`, byFormat: { reel: "SFC" }, affectsPayment: true },
      targets: [
        { targetRef: "t-likes", metricId: "likes", targetValue: 100, unit: "count", comparison: "at_least" },
        { targetRef: "t-reach", metricId: "reach", targetValue: 1000, unit: "count", comparison: "at_least" },
        { targetRef: "t-growth", metricId: "followerGrowth", targetValue: 50, unit: "followers", comparison: "at_least" },
      ],
      ...over.policy,
    } as GoverningCommercialPolicy),
  };
  stubPolicies.set(partner.partnerRef, () => state.policy);
  return { tag, partner, a1, t1, a2, t2, record, c1, c2, state };
}

type CommercialFx = Awaited<ReturnType<typeof seedCommercialPartner>>;
const identifiersOf = (fx: CommercialFx) => [fx.a1.assignmentRef, fx.a2.assignmentRef, fx.a1.campaignRef, fx.t1.contentRef, fx.t2.contentRef, fx.record.sourceRef, fx.c1.sourceRef, fx.c2.sourceRef, fx.t1.currentLinks[0]!.normalizedUrl];

async function generateSubmitFinalize(fx: CommercialFx) {
  const manager = await actorFor("partnership_manager");
  const head = await actorFor("partnership_head");
  const generated = await generateFor(manager, fx.partner.partnerRef);
  const reviewRef = generated.review.head.reviewRef;
  const submitted = await submitPartnerReviewForReview(manager, reviewRef, { expectedDocVersion: generated.review.selectedVersion!.docVersion }, "req-submit");
  if (!submitted.ok) throw new Error(submitted.message);
  const finalized = await finalizePartnerReview(head, reviewRef, { expectedDocVersion: submitted.data.selectedVersion!.docVersion }, "req-finalize");
  if (!finalized.ok) throw new Error(finalized.message);
  return { manager, head, reviewRef, finalized: finalized.data, generated };
}

async function handoffOf(actor: ActorContext | null, reviewRef: string, version?: number | string) {
  const result = await getFinalizedReviewHandoff(actor, reviewRef, version);
  if (!result.ok) throw new Error(`handoff failed: ${result.code} ${result.message}`);
  return result.data;
}

describe("commercial evidence in the stored snapshot (Step 13A.1 revised)", () => {
  it("with NO governing policy the commercial section is the all-unavailable shape: nothing invented, affectsPayment false, requiredCount null even though the Assignment brief has a required count", async () => {
    const head = await actorFor("partnership_head");
    const fx = await seedCommercialPartner({ policy: null });
    const generated = await generateFor(head, fx.partner.partnerRef);

    const stored = JSON.parse(await rawDoc(versionRef(generated.review.head.reviewRef, 1)));
    expect(stored.snapshot.commercial).toEqual(neutralCommercialEvidence());
    expect(fx.a1.brief.requiredCount).toBe(2);
    expect(stored.snapshot.commercial.monthlyDeliverable).toMatchObject({ requiredCount: null, evaluation: "unavailable", unavailableReason: "no_agreement_requirement", affectsPayment: false });
    expect(stored.snapshot.commercial.lfcSfc).toMatchObject({ status: "unavailable", lfcCount: null, sfcCount: null, affectsPayment: false });
    expect(stored.snapshot.commercial.targets).toEqual([]);
    // The channel snapshots are not even read without a followerGrowth target: not among the sources.
    expect(stored.sourceRefs).not.toContainEqual({ type: "analyticsSourceRecord", ref: fx.c1.sourceRef });
    expect(generated.review.selectedVersion!.snapshot.commercial).toMatchObject({ governingAgreement: null, monthlyDeliverable: { requiredCount: null, evaluation: "unavailable" } });
  });

  it("with a stub policy generate stores the correct evaluation: deliverable, LFC/SFC, warning-only targets (incl. followerGrowth from channel snapshots) and the channel records as sources", async () => {
    const admin = await actorFor("super_admin");
    const fx = await seedCommercialPartner();
    const generated = await generateFor(admin, fx.partner.partnerRef);
    const reviewRef = generated.review.head.reviewRef;
    const stored = JSON.parse(await rawDoc(versionRef(reviewRef, 1)));
    const commercial = stored.snapshot.commercial;

    expect(commercial.governingAgreement).toEqual({ agreementRef: `agr-${fx.tag}`, agreementVersion: 3 });
    // Only a1's thread is APPROVED (a2's 3 raw links never count): 1 of 2 required.
    expect(commercial.monthlyDeliverable).toEqual({
      requiredCount: 2,
      requirementSource: { agreementRef: `agr-${fx.tag}`, agreementVersion: 3, requirementSourceRef: `req-${fx.tag}` },
      qualifyingUnit: "approved_content_thread",
      actualQualifyingCount: 1,
      actualCountSources: { sourceType: "content_thread", units: [{ assignmentRef: fx.a1.assignmentRef, contentRef: fx.t1.contentRef, unitCount: 1 }] },
      variance: -1,
      evaluation: "below_requirement",
      unavailableReason: null,
      affectsPayment: true,
    });
    expect(commercial.lfcSfc).toMatchObject({
      status: "evaluated",
      ruleRef: `rule-${fx.tag}`,
      lfcCount: 0,
      sfcCount: 1,
      unclassifiedCount: 0,
      affectsPayment: true,
      units: [{ assignmentRef: fx.a1.assignmentRef, contentRef: fx.t1.contentRef, unitCount: 1, classification: "SFC", basis: { ruleRef: `rule-${fx.tag}`, matchedFormat: "reel" } }],
    });
    const byRef = Object.fromEntries((commercial.targets as Array<{ targetRef: string }>).map((t) => [t.targetRef, t]));
    expect(byRef["t-likes"]).toMatchObject({ evaluation: "met", actualValue: 120, affectsPayment: false, provenance: { refs: [fx.record.sourceRef], recordsWithMetric: 1, recordsMissingMetric: 0 } });
    expect(byRef["t-reach"]).toMatchObject({ evaluation: "unavailable", unavailableReason: "unsupported_metric", actualValue: null, affectsPayment: false });
    expect(byRef["t-growth"]).toMatchObject({ evaluation: "met", actualValue: 100, affectsPayment: false, provenance: { refs: [fx.c1.sourceRef, fx.c2.sourceRef].sort(), recordsWithMetric: 2, recordsMissingMetric: 0 } });

    // The channel snapshots that fed followerGrowth are recorded as sources.
    expect(stored.sourceRefs).toEqual(expect.arrayContaining([{ type: "analyticsSourceRecord", ref: fx.c1.sourceRef }, { type: "analyticsSourceRecord", ref: fx.c2.sourceRef }]));
    // The global actor sees the refs, and freshness is current.
    const dto = generated.review.selectedVersion!.snapshot.commercial;
    expect(dto.monthlyDeliverable.actualCountSources!.units[0]).toMatchObject({ assignmentRef: fx.a1.assignmentRef, contentRef: fx.t1.contentRef, redactedContext: [] });
    expect(generated.review.freshness).toMatchObject({ state: expect.stringMatching(/current|evidence_incomplete/) });
    expect(generated.review.selectedVersion!.withheldSourceCounts).toEqual({ assignment: 0, campaign: 0, content: 0, analyticsSourceRecord: 0 });
  });

  it("a single channel snapshot never produces follower growth (unavailable), and a metric absent from every record is unavailable, not zero", async () => {
    const head = await actorFor("partnership_head");
    const fx = await seedCommercialPartner({
      policy: {
        targets: [
          { targetRef: "t-growth", metricId: "followerGrowth", targetValue: 1, unit: "followers", comparison: "at_least" },
          { targetRef: "t-views", metricId: "views", targetValue: 1, unit: "count", comparison: "at_least" },
        ],
      },
    });
    await analyticsChannelSourceRecordsCollection().doc(fx.c2.uid).delete(); // leaves ONE snapshot
    const generated = await generateFor(head, fx.partner.partnerRef);
    const stored = JSON.parse(await rawDoc(versionRef(generated.review.head.reviewRef, 1)));
    const byRef = Object.fromEntries((stored.snapshot.commercial.targets as Array<{ targetRef: string }>).map((t) => [t.targetRef, t]));
    expect(byRef["t-growth"]).toMatchObject({ evaluation: "unavailable", unavailableReason: "insufficient_follower_snapshots", actualValue: null });
    expect(byRef["t-views"]).toMatchObject({ evaluation: "unavailable", unavailableReason: "no_verified_values", actualValue: null });
    expect(stored.sourceRefs).not.toContainEqual({ type: "analyticsSourceRecord", ref: fx.c1.sourceRef });
  });

  it("a malformed / client-supplied policy is impossible: generate and refresh reject a policy in the input, writing nothing", async () => {
    const head = await actorFor("partnership_head");
    const fx = await seedCommercialPartner();
    // Hermetic: the rejected input must not create THIS Partner-month's review head (never a whole-collection size, which parallel files change).
    const headRef = getAdminFirestore().collection(PARTNER_REVIEWS_COLLECTIONS.partnerReviews).doc(reviewRefFor(fx.partner.partnerRef, "2019-03"));
    expect((await headRef.get()).exists).toBe(false);
    const rejected = await generatePartnerReviewDraft(head, { partnerRef: fx.partner.partnerRef, periodKey: "2019-03", commercialPolicy: { agreementRef: "x", agreementVersion: 1 } }, "req-policy");
    expect(rejected).toMatchObject({ ok: false, code: "invalid_input" });
    expect((await headRef.get()).exists).toBe(false);

    const generated = await generateFor(head, fx.partner.partnerRef);
    const refresh = await refreshPartnerReviewEvidence(head, generated.review.head.reviewRef, { expectedDocVersion: 1, commercialPolicy: { agreementRef: "x", agreementVersion: 1 } }, "req-policy-2");
    expect(refresh).toMatchObject({ ok: false, code: "invalid_input" });
  });

  it("an old stored version WITHOUT a commercial key stays readable, is presented as all-unavailable and stays current", async () => {
    const head = await actorFor("partnership_head");
    const partner = await seedPartner();
    const assignment = await seedAssignment(partner.partnerRef);
    await seedThread(assignment, { status: "APPROVED", approvedAt: "2019-03-09T00:00:00.000Z" });
    await seedAnalyticsRecord(partner.partnerRef, { likes: 5 });
    const { reviewRef, finalized } = await generateAndFinalize(partner.partnerRef);
    expect(finalized.selectedVersion!.status).toBe("FINALIZED");

    // Simulate a version stored before commercial evidence existed.
    await versionRef(reviewRef, 1).update({ "snapshot.commercial": FieldValue.delete() });
    expect(JSON.parse(await rawDoc(versionRef(reviewRef, 1))).snapshot).not.toHaveProperty("commercial");

    const read = await getPartnerReviewVersion(head, reviewRef, "1");
    if (!read.ok) throw new Error(read.message);
    expect(read.data.version.snapshot.commercial).toMatchObject({ governingAgreement: null, monthlyDeliverable: { evaluation: "unavailable", requiredCount: null, affectsPayment: false }, lfcSfc: { status: "unavailable" }, targets: [] });
    expect(read.data.freshness.state).toMatch(/current|evidence_incomplete/);

    const handoff = await handoffOf(head, reviewRef);
    expect(handoff).toMatchObject({ governingAgreement: null, paymentAffectingEvidence: { monthlyDeliverable: null, lfcSfc: null }, warningOnlyTargets: [], versionCurrency: { state: "current_finalized" } });
  });
});

describe("finalized-review handoff (Step 13A.1 revised)", () => {
  it("only FINALIZED or SUPERSEDED versions are handoff-able: a Draft / In Review version and a review with no finalized version are invalid_input ('not finalized')", async () => {
    const manager = await actorFor("partnership_manager");
    const fx = await seedCommercialPartner();
    const generated = await generateFor(manager, fx.partner.partnerRef);
    const reviewRef = generated.review.head.reviewRef;

    expect(await getFinalizedReviewHandoff(manager, reviewRef)).toMatchObject({ ok: false, code: "invalid_input", message: expect.stringMatching(/not finalized/) });
    expect(await getFinalizedReviewHandoff(manager, reviewRef, 1)).toMatchObject({ ok: false, code: "invalid_input", message: expect.stringMatching(/not finalized/) });
    expect(await getReviewVersionCurrency(manager, reviewRef, 1)).toMatchObject({ ok: false, code: "invalid_input" });

    const submitted = await submitPartnerReviewForReview(manager, reviewRef, { expectedDocVersion: 1 }, "req-s");
    if (!submitted.ok) throw new Error(submitted.message);
    expect(await getFinalizedReviewHandoff(manager, reviewRef, "1")).toMatchObject({ ok: false, code: "invalid_input" });
  });

  it("finalize -> the handoff returns the finalized version with payment-affecting and warning-only sections and NO source identifier; Viewer and Analyst can read it", async () => {
    const viewer = await actorFor("viewer");
    const analyst = await actorFor("analyst");
    const fx = await seedCommercialPartner();
    const { head, reviewRef, finalized } = await generateSubmitFinalize(fx);
    const stored = JSON.parse(await rawDoc(versionRef(reviewRef, 1)));

    const dto = await handoffOf(head, reviewRef);
    expect(dto).toMatchObject({
      contractVersion: 1,
      reviewRef,
      reviewVersion: 1,
      partner: { partnerRef: fx.partner.partnerRef, displayName: fx.partner.displayName },
      period: { periodKey: "2019-03", periodStart: "2019-03-01", periodEnd: "2019-03-31" },
      finalizedAt: stored.finalizedAt,
      evidenceCutoff: stored.evidenceCutoff,
      sourceFingerprint: stored.sourceFingerprint,
      governingAgreement: { agreementRef: `agr-${fx.tag}`, agreementVersion: 3 },
      versionCurrency: { state: "current_finalized", currentFinalizedVersion: 1, referencedVersion: 1 },
    });
    expect(dto.paymentAffectingEvidence.monthlyDeliverable).toEqual({
      requiredCount: 2,
      requirementSource: { agreementRef: `agr-${fx.tag}`, agreementVersion: 3, requirementSourceRef: `req-${fx.tag}` },
      qualifyingUnit: "approved_content_thread",
      actualQualifyingCount: 1,
      variance: -1,
      evaluation: "below_requirement",
    });
    expect(dto.paymentAffectingEvidence.lfcSfc).toMatchObject({ ruleRef: `rule-${fx.tag}`, lfcCount: 0, sfcCount: 1, unclassifiedCount: 0 });
    expect(dto.warningOnlyTargets.map((t) => [t.targetRef, t.evaluation, t.actualValue, t.affectsPayment])).toEqual([
      ["t-growth", "met", 100, false],
      ["t-likes", "met", 120, false],
      ["t-reach", "unavailable", null, false],
    ]);
    expectNone(JSON.stringify(dto), [...identifiersOf(fx), "campaignRef", "assignmentRef", "contentRef", "sourceRefs"]);
    expect(finalized.selectedVersion!.sourceFingerprint).toBe(dto.sourceFingerprint);

    // Read-only roles read it; every actor gets the identical DTO.
    expect(await handoffOf(viewer, reviewRef)).toEqual(dto);
    expect(await handoffOf(analyst, reviewRef, 1)).toEqual(dto);
    expect(await getReviewVersionCurrency(analyst, reviewRef, "1")).toEqual({ ok: true, data: { state: "current_finalized", currentFinalizedVersion: 1, referencedVersion: 1 } });
  });

  it("route authz: unauthenticated 401, cross-scope 403, malformed/unknown reviewRef 404, bad version 400, missing version 404, and a read-only role reads it (200)", async () => {
    const viewer = await actorFor("viewer");
    const manager = await actorFor("partnership_manager");
    const fx = await seedCommercialPartner();
    const { reviewRef } = await generateSubmitFinalize(fx);
    const call = async (actor: ActorContext | null, ref: string, query = "") => {
      httpActor = actor;
      const response = await getHandoffRoute(new Request(`http://localhost/api/partner-reviews/${ref}/handoff${query}`), { params: Promise.resolve({ reviewRef: ref }) });
      return { status: response.status, body: await response.json() };
    };

    expect(await call(null, reviewRef)).toEqual({ status: 401, body: { error: "Forbidden." } });
    const ok = await call(viewer, reviewRef, "?version=1");
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ contractVersion: 1, reviewRef, reviewVersion: 1 });
    expect((await call(manager, reviewRef)).status).toBe(200);
    expect((await call(viewer, "not-a-ref")).status).toBe(404);
    expect((await call(viewer, `pr_${"0".repeat(20)}`)).status).toBe(404);
    expect((await call(viewer, reviewRef, "?version=abc")).status).toBe(400);
    expect((await call(viewer, reviewRef, "?version=0")).status).toBe(400);
    expect((await call(viewer, reviewRef, "?version=99")).status).toBe(404);

    // Move the Partner out of every seeded actor's scope: cross-scope is denied like every other read.
    await partnersCollection().doc(fx.partner.uid).update({ regionIds: [PRIVATE_REGION] });
    expect(await call(manager, reviewRef)).toEqual({ status: 403, body: { error: "Forbidden." } });
    expect(await call(viewer, reviewRef)).toEqual({ status: 403, body: { error: "Forbidden." } });
    expect(await getFinalizedReviewHandoff(manager, reviewRef)).toMatchObject({ ok: false, code: "unauthorized", reason: "scope_denied" });
    expect(await getReviewVersionCurrency(manager, reviewRef, 1)).toMatchObject({ ok: false, code: "unauthorized", reason: "scope_denied" });
    expect(await getFinalizedReviewHandoff(null, reviewRef)).toMatchObject({ ok: false, code: "unauthorized", reason: "not_authenticated" });
  });

  it("the handoff and currency reads are strictly read-only: no version/head/event write, no upstream write, no Finance-shaped collection", async () => {
    const viewer = await actorFor("viewer");
    const fx = await seedCommercialPartner();
    const { reviewRef } = await generateSubmitFinalize(fx);
    const upstream = [assignmentsCollection().doc(fx.a1.uid), contentCollection().doc(fx.t1.uid), analyticsContentSourceRecordsCollection().doc(fx.record.uid), analyticsChannelSourceRecordsCollection().doc(fx.c1.uid), partnersCollection().doc(fx.partner.uid)];
    const before = { review: await reviewState(reviewRef), upstream: await Promise.all(upstream.map(rawDoc)) };
    const rootBefore = (await getAdminFirestore().listCollections()).map((c) => c.id).sort();

    await handoffOf(viewer, reviewRef);
    await handoffOf(viewer, reviewRef, 1);
    await getReviewVersionCurrency(viewer, reviewRef, 1);

    expect(await reviewState(reviewRef)).toEqual(before.review);
    expect(await Promise.all(upstream.map(rawDoc))).toEqual(before.upstream);
    const rootAfter = (await getAdminFirestore().listCollections()).map((c) => c.id).sort();
    // The reads must not CREATE a root collection. (Other test files create and empty their own collections concurrently, so the
    // list itself is not compared - only what appeared that was not there before; the Agreement roots are owned by Step 14A files.)
    expect(rootAfter.filter((name) => !rootBefore.includes(name) && !FINANCE_AGREEMENT_ROOTS.test(name))).toEqual([]);
    expect(rootAfter.filter((name) => /finance|agreement|payable|invoice|payment|payee/i.test(name) && !FINANCE_AGREEMENT_ROOTS.test(name))).toEqual([]);
  });
});

describe("commercial evidence lifecycle: upstream change, revision, supersession (Step 13A.1 revised)", () => {
  it("a post-finalize upstream change raises revision_available, and the finalized doc AND its handoff stay byte-identical", async () => {
    const manager = await actorFor("partnership_manager");
    const fx = await seedCommercialPartner();
    const { head, reviewRef } = await generateSubmitFinalize(fx);
    const docBefore = await rawDoc(versionRef(reviewRef, 1));
    const handoffBefore = JSON.stringify(await handoffOf(head, reviewRef));

    // a2's Content is approved AFTER finalize: the count would now be 2.
    await contentCollection().doc(fx.t2.uid).update({ status: "APPROVED", approvedAt: "2019-03-15T00:00:00.000Z", version: 4, updatedAt: new Date().toISOString() });

    const freshness = await inspectPartnerReviewFreshness(manager, reviewRef);
    if (!freshness.ok) throw new Error(freshness.message);
    expect(freshness.data.freshness).toMatchObject({ state: "revision_available" });
    expect(freshness.data.freshness.currentFingerprint).not.toBe(freshness.data.freshness.snapshotFingerprint);

    expect(await rawDoc(versionRef(reviewRef, 1))).toBe(docBefore);
    expect(JSON.stringify(await handoffOf(head, reviewRef))).toBe(handoffBefore);
    expect((await handoffOf(head, reviewRef)).paymentAffectingEvidence.monthlyDeliverable).toMatchObject({ actualQualifyingCount: 1, evaluation: "below_requirement" });
  });

  it("revision -> finalize v2 supersedes v1: v1 stays addressable (version read + handoff 'referenced_review_version_is_stale', current = 2) with a byte-identical snapshot/fingerprint; v2's handoff is current_finalized", async () => {
    const manager = await actorFor("partnership_manager");
    const head = await actorFor("partnership_head");
    const fx = await seedCommercialPartner();
    const first = await generateSubmitFinalize(fx);
    const reviewRef = first.reviewRef;
    const v1Before = JSON.parse(await rawDoc(versionRef(reviewRef, 1)));
    const v1Handoff = await handoffOf(head, reviewRef, 1);

    await contentCollection().doc(fx.t2.uid).update({ status: "APPROVED", approvedAt: "2019-03-15T00:00:00.000Z", version: 4, updatedAt: new Date().toISOString() });

    const revision = await createPartnerReviewRevision(manager, reviewRef, { expectedDocVersion: first.finalized.head.docVersion }, "req-rev");
    if (!revision.ok) throw new Error(revision.message);
    expect(revision.data.selectedVersion!.snapshot.commercial.monthlyDeliverable).toMatchObject({ actualQualifyingCount: 2, variance: 0, evaluation: "met" });
    const submitted = await submitPartnerReviewForReview(manager, reviewRef, { expectedDocVersion: revision.data.selectedVersion!.docVersion }, "req-s2");
    if (!submitted.ok) throw new Error(submitted.message);
    const finalized2 = await finalizePartnerReview(head, reviewRef, { expectedDocVersion: submitted.data.selectedVersion!.docVersion }, "req-f2");
    if (!finalized2.ok) throw new Error(finalized2.message);

    // v1 is SUPERSEDED but its evidence and fingerprint are byte-identical.
    const v1After = JSON.parse(await rawDoc(versionRef(reviewRef, 1)));
    expect(v1After.status).toBe("SUPERSEDED");
    expect(v1After.snapshot).toEqual(v1Before.snapshot);
    expect(JSON.stringify(v1After.snapshot)).toBe(JSON.stringify(v1Before.snapshot));
    expect(v1After.sourceFingerprint).toBe(v1Before.sourceFingerprint);
    expect(v1After.sourceRefs).toEqual(v1Before.sourceRefs);

    // Still fully addressable through the version read...
    const v1Read = await getPartnerReviewVersion(head, reviewRef, "1");
    if (!v1Read.ok) throw new Error(v1Read.message);
    expect(v1Read.data.version).toMatchObject({ version: 1, status: "SUPERSEDED", sourceFingerprint: v1Before.sourceFingerprint });
    expect(v1Read.data.version.snapshot.commercial.monthlyDeliverable).toMatchObject({ actualQualifyingCount: 1, evaluation: "below_requirement" });

    // ...and through the handoff, which now reports it is stale.
    const staleHandoff = await handoffOf(head, reviewRef, 1);
    expect(staleHandoff.versionCurrency).toEqual({ state: "referenced_review_version_is_stale", currentFinalizedVersion: 2, referencedVersion: 1 });
    expect(staleHandoff.sourceFingerprint).toBe(v1Before.sourceFingerprint);
    expect({ ...staleHandoff, versionCurrency: null }).toEqual({ ...v1Handoff, versionCurrency: null });
    expect(await getReviewVersionCurrency(head, reviewRef, 1)).toEqual({ ok: true, data: { state: "referenced_review_version_is_stale", currentFinalizedVersion: 2, referencedVersion: 1 } });

    const currentHandoff = await handoffOf(head, reviewRef);
    expect(currentHandoff).toMatchObject({ reviewVersion: 2, versionCurrency: { state: "current_finalized", currentFinalizedVersion: 2, referencedVersion: 2 } });
    expect(currentHandoff.paymentAffectingEvidence.monthlyDeliverable).toMatchObject({ actualQualifyingCount: 2, variance: 0, evaluation: "met" });
    expect(await handoffOf(head, reviewRef, 2)).toEqual(currentHandoff);
    expect(await getReviewVersionCurrency(head, reviewRef, 2)).toEqual({ ok: true, data: { state: "current_finalized", currentFinalizedVersion: 2, referencedVersion: 2 } });
  });

  it("an Agreement version bump (upstream unchanged) makes a Draft refresh_available and a finalized version revision_available; the finalized doc is untouched and a revision then carries the new version", async () => {
    const manager = await actorFor("partnership_manager");
    const fx = await seedCommercialPartner();

    // Draft: refresh_available after the bump.
    const generated = await generateFor(manager, fx.partner.partnerRef);
    const draftRef = generated.review.head.reviewRef;
    fx.state.policy = { ...fx.state.policy!, agreementVersion: 4 };
    const draftFreshness = await inspectPartnerReviewFreshness(manager, draftRef);
    if (!draftFreshness.ok) throw new Error(draftFreshness.message);
    expect(draftFreshness.data.freshness.state).toBe("refresh_available");
    // A refresh incorporates it (same version number, new commercial identity).
    const refreshed = await refreshPartnerReviewEvidence(manager, draftRef, { expectedDocVersion: 1 }, "req-refresh");
    if (!refreshed.ok) throw new Error(refreshed.message);
    expect(refreshed.data.selectedVersion!.snapshot.commercial.governingAgreement).toEqual({ agreementRef: `agr-${fx.tag}`, agreementVersion: 4 });
    expect(refreshed.data.freshness?.state).toMatch(/current|evidence_incomplete/);

    // Finalized: revision_available after the NEXT bump; nothing upstream changed.
    const head = await actorFor("partnership_head");
    const submitted = await submitPartnerReviewForReview(manager, draftRef, { expectedDocVersion: refreshed.data.selectedVersion!.docVersion }, "req-s");
    if (!submitted.ok) throw new Error(submitted.message);
    const finalized = await finalizePartnerReview(head, draftRef, { expectedDocVersion: submitted.data.selectedVersion!.docVersion }, "req-f");
    if (!finalized.ok) throw new Error(finalized.message);
    const docBefore = await rawDoc(versionRef(draftRef, 1));
    const handoffBefore = JSON.stringify(await handoffOf(head, draftRef));

    fx.state.policy = { ...fx.state.policy!, agreementVersion: 5, monthlyDeliverableRequirement: { ...fx.state.policy!.monthlyDeliverableRequirement!, requiredCount: 1 } };
    const finalizedFreshness = await inspectPartnerReviewFreshness(manager, draftRef);
    if (!finalizedFreshness.ok) throw new Error(finalizedFreshness.message);
    expect(finalizedFreshness.data.freshness.state).toBe("revision_available");
    expect(await rawDoc(versionRef(draftRef, 1))).toBe(docBefore);
    expect(JSON.stringify(await handoffOf(head, draftRef))).toBe(handoffBefore);

    const revision = await createPartnerReviewRevision(manager, draftRef, { expectedDocVersion: finalized.data.head.docVersion }, "req-rev");
    if (!revision.ok) throw new Error(revision.message);
    expect(revision.data.selectedVersion!.snapshot.commercial).toMatchObject({ governingAgreement: { agreementVersion: 5 }, monthlyDeliverable: { requiredCount: 1, actualQualifyingCount: 1, evaluation: "met" } });
    expect(revision.data.selectedVersion!.sourceFingerprint).not.toBe(finalized.data.selectedVersion!.sourceFingerprint);
  });

  it("finalize still refuses stale evidence when only the policy changed after In Review (REFRESH_REQUIRED, zero writes); an explicit refresh then finalizes; incomplete-but-current still finalizes", async () => {
    const manager = await actorFor("partnership_manager");
    const head = await actorFor("partnership_head");
    const fx = await seedCommercialPartner();
    // Incomplete-but-current: an Analytics row with no reporting period rides along.
    await seedAnalyticsRecord(fx.partner.partnerRef, { contentRef: null, period: null });
    const { reviewRef, inReviewDocVersion } = await generateAndSubmit(fx.partner.partnerRef);
    const before = await reviewState(reviewRef);

    fx.state.policy = { ...fx.state.policy!, agreementVersion: 4 };
    const blocked = await finalizePartnerReview(head, reviewRef, { expectedDocVersion: inReviewDocVersion }, "req-blocked");
    expect(blocked).toMatchObject({ ok: false, code: "not_ready", blockers: [expect.objectContaining({ code: "REFRESH_REQUIRED" })] });
    expect(await reviewState(reviewRef)).toEqual(before);

    const refreshed = await refreshPartnerReviewEvidence(manager, reviewRef, { expectedDocVersion: inReviewDocVersion }, "req-refresh");
    if (!refreshed.ok) throw new Error(refreshed.message);
    const finalized = await finalizePartnerReview(head, reviewRef, { expectedDocVersion: refreshed.data.selectedVersion!.docVersion }, "req-finalize");
    expect(finalized.ok).toBe(true);
    if (!finalized.ok) return;
    expect(finalized.data.freshness).toMatchObject({ state: "evidence_incomplete" });
    expect(finalized.data.selectedVersion!.snapshot.commercial.governingAgreement).toEqual({ agreementRef: `agr-${fx.tag}`, agreementVersion: 4 });
  });
});

describe("commercial evidence is actor-independent and redacted per actor (Step 13A.1 revised)", () => {
  it("a Manager without the private scope sees the SAME commercial results and fingerprint as the global actor, and none of the out-of-scope Assignment / Content / Analytics identifiers", async () => {
    const manager = await actorFor("partnership_manager");
    const admin = await actorFor("super_admin");
    const fx = await seedScopeFixture();
    // Both threads APPROVED (a2/t2 are in the private region); a1 and a3 exist as before.
    await contentCollection().doc(fx.t1.uid).update({ status: "APPROVED", approvedAt: "2019-03-09T00:00:00.000Z", version: 4, updatedAt: new Date().toISOString() });
    await contentCollection().doc(fx.t2.uid).update({ status: "APPROVED", approvedAt: "2019-03-14T00:00:00.000Z", version: 4, updatedAt: new Date().toISOString() });
    // One channel snapshot in Kerala (visible to the Manager), one in the private region.
    const accountRef = `pr-test-acct-${fx.tag}`;
    const chIn = await seedChannelRecord(fx.partner.partnerRef, { accountRef, followers: 1000, day: "2019-03-02", regionIds: ["Kerala"] });
    const chOut = await seedChannelRecord(fx.partner.partnerRef, { accountRef, followers: 1300, day: "2019-03-28", regionIds: [PRIVATE_REGION] });
    stubPolicies.set(fx.partner.partnerRef, () => ({
      agreementRef: `agr-${fx.tag}`,
      agreementVersion: 3,
      monthlyDeliverableRequirement: { requiredCount: 2, qualifyingUnit: "approved_content_thread" },
      lfcSfcRule: { ruleRef: `rule-${fx.tag}`, byFormat: { reel: "LFC" }, affectsPayment: true },
      targets: [
        { targetRef: "t-likes", metricId: "likes", targetValue: 300, unit: "count", comparison: "at_least" },
        { targetRef: "t-growth", metricId: "followerGrowth", targetValue: 300, unit: "followers", comparison: "at_least" },
      ],
    }));

    const generated = await generateFor(manager, fx.partner.partnerRef);
    const reviewRef = generated.review.head.reviewRef;
    const managerDetail = await getPartnerReview(manager, reviewRef);
    const adminDetail = await getPartnerReview(admin, reviewRef);
    if (!managerDetail.ok || !adminDetail.ok) throw new Error("read failed");
    const m = managerDetail.data.selectedVersion!;
    const a = adminDetail.data.selectedVersion!;

    expect(m.sourceFingerprint).toBe(a.sourceFingerprint);
    // Canonical results: identical for both actors.
    const results = (commercial: typeof m.snapshot.commercial) => ({
      agreement: commercial.governingAgreement,
      deliverable: { ...commercial.monthlyDeliverable, actualCountSources: commercial.monthlyDeliverable.actualCountSources?.units.map((u) => u.unitCount) },
      lfcSfc: { ...commercial.lfcSfc, units: commercial.lfcSfc.units.map((u) => [u.unitCount, u.classification, u.basis]) },
      targets: commercial.targets.map((t) => ({ ...t, provenance: { ...t.provenance, refs: t.provenance.refs.length, redactedContext: undefined } })),
    });
    expect(results(m.snapshot.commercial)).toEqual(results(a.snapshot.commercial));
    expect(a.snapshot.commercial.monthlyDeliverable).toMatchObject({ actualQualifyingCount: 2, variance: 0, evaluation: "met" });
    expect(a.snapshot.commercial.lfcSfc).toMatchObject({ status: "evaluated", lfcCount: 2, sfcCount: 0 });
    expect(a.snapshot.commercial.targets.map((t) => [t.targetRef, t.evaluation, t.actualValue])).toEqual([
      ["t-growth", "met", 300],
      ["t-likes", "met", 333],
    ]);

    // The Manager's JSON never carries an out-of-scope identifier, in ANY part of the response (commercial included).
    const managerJson = JSON.stringify(managerDetail.data);
    expectNone(managerJson, [...fx.hidden, chOut.sourceRef]);
    expectNone(JSON.stringify(generated.review), [...fx.hidden, chOut.sourceRef]);
    expectAll(managerJson, [fx.a1.assignmentRef, fx.t1.contentRef, chIn.sourceRef]);
    // In-scope units carry refs; the out-of-scope unit is null + a neutral marker.
    const units = m.snapshot.commercial.monthlyDeliverable.actualCountSources!.units;
    expect(units.map((u) => u.assignmentRef).sort((x, y) => String(x).localeCompare(String(y)))).toEqual([fx.a1.assignmentRef, null].sort((x, y) => String(x).localeCompare(String(y))));
    expect(units.find((u) => u.assignmentRef === null)!.redactedContext).toEqual(expect.arrayContaining([{ sourceType: "assignment", redacted: true }]));
    const growth = m.snapshot.commercial.targets.find((t) => t.targetRef === "t-growth")!;
    expect(growth.provenance.refs.filter((ref) => ref !== null)).toEqual([chIn.sourceRef]);
    expect(growth.provenance.refs).toHaveLength(2);
    // The channel snapshot is counted as withheld, not named.
    expect(m.withheldSourceCounts.analyticsSourceRecord).toBe(2); // r2 (content record) and chOut
    expect(a.withheldSourceCounts.analyticsSourceRecord).toBe(0);

    // The STORED canonical section is complete (redaction is DTO-only).
    const stored = JSON.parse(await rawDoc(versionRef(reviewRef, 1)));
    expectAll(JSON.stringify(stored.snapshot.commercial), [fx.a2.assignmentRef, fx.t2.contentRef, chOut.sourceRef]);
  });
});
