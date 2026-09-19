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

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { analyticsContentSourceRecordsCollection } from "@/server/analytics/firestore";
import { resolveAnalyticsSourceRecordMatch } from "@/server/analytics/correction-service";
import { analyticsContentSourceRecordDocSchema } from "@/server/analytics/types";
import { assignmentsCollection } from "@/server/assignments/firestore";
import { assignmentBriefSchema, assignmentDocSchema } from "@/server/assignments/types";
import { seedEmulatorTestUsers } from "@/server/auth/seed-users";
import { resolveActor } from "@/server/authz/actor";
import { canPerformAction } from "@/server/authz/capabilities";
import { COLLECTIONS } from "@/server/authz/firestore";
import { MODULE_ACTIONS } from "@/server/authz/module-actions";
import { seedAccessControlData, TEST_IDENTITIES } from "@/server/authz/seed-access-data";
import type { ActorContext } from "@/server/authz/types";
import { contentCollection } from "@/server/content/firestore";
import { contentDocSchema } from "@/server/content/types";
import { getAdminAuth, getAdminFirestore } from "@/server/firebase/admin";
import { partnersCollection } from "@/server/partners/firestore";
import { seedPartnersData } from "@/server/partners/seed-partners-data";
import { partnerDocSchema, type PartnerDoc } from "@/server/partners/types";

import { PERFORMANCE_METRIC_IDS } from "./evidence-builder";
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
import { PARTNER_REVIEW_EVENT_KINDS } from "./types";

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
const reviewRefsToClean = new Set<string>();

afterEach(async () => {
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

async function seedAssignment(partnerRef: string, over: { dueAt?: string | null; status?: string; createdAt?: string; campaignName?: string; requiredCount?: number } = {}) {
  const uid = assignmentsCollection().doc().id;
  const now = new Date().toISOString();
  const assignment = assignmentDocSchema.parse({
    uid,
    assignmentRef: `pr-test-as-${uid}`,
    version: 1,
    campaignRef: `pr-test-camp-${runId}`,
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
    regionIds: [PRIVATE_REGION],
    teamIds: [],
    createdAt: over.createdAt ?? "2019-01-05T08:00:00.000Z",
    createdByUserRef: "pr-test",
    updatedAt: now,
    updatedByUserRef: "pr-test",
  });
  const ref = assignmentsCollection().doc(uid);
  await ref.set(assignment);
  cleanup.push(ref);
  return assignment;
}

async function seedThread(assignment: { assignmentRef: string; campaignRef: string; partnerRef: string }, over: { status?: string; links?: number; revision?: number; approvedAt?: string | null } = {}) {
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
    regionIds: [PRIVATE_REGION],
    teamIds: [],
    createdAt: "2019-03-01T00:00:00.000Z",
    createdByUserRef: "pr-test",
    updatedAt: "2019-03-08T10:00:00.000Z",
    updatedByUserRef: "pr-test",
  });
  const ref = contentCollection().doc(uid);
  await ref.set(thread);
  cleanup.push(ref);
  return thread;
}

async function seedAnalyticsRecord(partnerRef: string, over: { contentRef?: string | null; likes?: number | null; period?: { start: string; end: string } | null } = {}) {
  const uid = `pr-test-an-${randomUUID()}`;
  const record = analyticsContentSourceRecordDocSchema.parse({
    uid,
    sourceRef: uid,
    batchRef: `pr-test-batch-${runId}`,
    sheetName: "Posts",
    sourceRowNumber: 2,
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
    matchedAssignmentRef: null,
    matchedCampaignRef: null,
    matchedPartnerRef: partnerRef,
    matchedPartnerAccountRef: null,
    ownerUid: null,
    regionIds: [PRIVATE_REGION],
    teamIds: [],
    createdAt: "2019-04-02T00:00:00.000Z",
  });
  const ref = analyticsContentSourceRecordsCollection().doc(uid);
  await ref.set(record);
  analyticsCleanup.push(ref);
  return record;
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

    const { outcome, review } = await generateFor(manager, partner.partnerRef);
    expect(outcome).toBe("created");
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
    const beforeHead = await rawDoc(partnerReviewsCollection().doc(reviewRef));

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
    expect(await rawDoc(partnerReviewsCollection().doc(reviewRef))).toBe(beforeHead);
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
    expect(rootAfter.filter((name) => /finance|agreement|payable|invoice|payment|payee/i.test(name))).toEqual([]);
    expect(rootAfter.filter((name) => !rootBefore.includes(name) && name !== PARTNER_REVIEWS_COLLECTIONS.partnerReviews)).toEqual([]);
  });
});
