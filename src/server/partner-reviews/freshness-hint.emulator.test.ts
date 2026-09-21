// Step 13C section 7 - certification of the best-effort `freshnessHint` read-side projection, against the real
// Firestore/Auth emulator (no mocks of Firestore): the hint is projection/cache metadata ONLY - never authorization
// truth, never lifecycle truth, never a docVersion bump, never a version-snapshot mutation, never a write on a
// repeated read of unchanged source state, never able to corrupt canonical state under concurrency, never able to fail
// a valid read, and never consulted by finalize / refresh / revision (which recompute the source state themselves).
//
// Hermetic by construction (same idioms as partner-reviews-ui-services.emulator.test.ts): every test gets a PRIVATE
// region (beforeEach) that only its synthetic actors hold, Partners / Assignments / Content / Analytics fixtures
// are schema-valid Admin-SDK writes dated in the PAST (2016), nothing asserts a whole-collection size, and every
// fixture (review heads with their versions/events subcollections, scope grants) is deleted afterwards.
import { randomUUID } from "node:crypto";

import { FieldValue } from "firebase-admin/firestore";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { analyticsContentSourceRecordsCollection } from "@/server/analytics/firestore";
import { analyticsContentSourceRecordDocSchema } from "@/server/analytics/types";
import { assignmentsCollection } from "@/server/assignments/firestore";
import { assignmentBriefSchema, assignmentDocSchema } from "@/server/assignments/types";
import { seedEmulatorTestUsers } from "@/server/auth/seed-users";
import { COLLECTIONS } from "@/server/authz/firestore";
import { scopeGrantDocId } from "@/server/authz/scope";
import { seedAccessControlData } from "@/server/authz/seed-access-data";
import type { ActorContext, ScopeGrant } from "@/server/authz/types";
import { contentCollection } from "@/server/content/firestore";
import { contentDocSchema } from "@/server/content/types";
import { getAdminFirestore } from "@/server/firebase/admin";
import { partnersCollection } from "@/server/partners/firestore";
import { seedPartnersData } from "@/server/partners/seed-partners-data";
import { partnerDocSchema, type PartnerDoc } from "@/server/partners/types";
import { computeReviewActionState } from "@/features/partner-reviews/review-action-state";

import * as evidenceCollector from "./evidence-collector";
import { PARTNER_REVIEWS_COLLECTIONS, getPartnerReviewHeadDoc, partnerReviewEventsCollection, partnerReviewsCollection, partnerReviewVersionsCollection } from "./firestore";
import { recordFreshnessHint } from "./freshness-hint";
import { createPartnerReviewRevision, finalizePartnerReview, submitPartnerReviewForReview } from "./partner-review-lifecycle-service";
import { getPartnerReviewPage } from "./partner-review-page-service";
import { generatePartnerReviewDraft, getPartnerReview, getPartnerReviewVersion, inspectPartnerReviewFreshness, refreshPartnerReviewEvidence } from "./partner-review-service";
import { getPartnerReviewsWorkspace, type WorkspaceQuery } from "./partner-review-workspace-service";
import { PARTNER_REVIEW_FRESHNESS_STATES, type PartnerReviewFreshnessState } from "./types";
import { parseMonthParam } from "./ui-params";

vi.setConfig({ testTimeout: 60_000 });

const runId = Date.now();
const PERIOD = "2016-03";
let R_IN = `pr-fh-in-${runId}`;
let R_OUT = `pr-fh-out-${runId}`;
let regionCounter = 0;

const cleanup: FirebaseFirestore.DocumentReference[] = [];
const analyticsCleanup: FirebaseFirestore.DocumentReference[] = [];
const reviewRefsToClean = new Set<string>();
const grantDocIds: string[] = [];

beforeAll(async () => {
  const password = process.env.EMULATOR_TEST_USER_PASSWORD;
  if (!password) throw new Error("EMULATOR_TEST_USER_PASSWORD is not set - check .env.local. Requires a running Firebase emulator.");
  await seedEmulatorTestUsers(password);
  await seedAccessControlData();
  await seedPartnersData();
}, 60_000);

beforeEach(() => {
  regionCounter += 1;
  R_IN = `pr-fh-in-${runId}-${regionCounter}`;
  R_OUT = `pr-fh-out-${runId}-${regionCounter}`;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(analyticsCleanup.splice(0).map((ref) => ref.delete()));
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
  await Promise.all(grantDocIds.splice(0).map((id) => getAdminFirestore().collection(COLLECTIONS.scopeAssignments).doc(id).delete()));
});

// ---- Actors ---------------------------------------------------------------------------------------------------------
type Role = ActorContext["role"];

// A synthetic actor: the given ROLE's explicit feature/action grants (accessGrants/{role}) + a scope made of exactly the
// REGION grants named here.
async function syntheticActor(role: Role, regions: string[] = [R_IN]): Promise<ActorContext> {
  const uid = `pr-fh-${role}-${runId}-${randomUUID().slice(0, 6)}`;
  const grantedAt = new Date().toISOString();
  for (const region of regions) {
    const input = { type: "REGION" as const, region };
    const grant = { ...input, uid, grantedAt, grantedBy: "pr-fh-test" } as ScopeGrant;
    const id = scopeGrantDocId(uid, input);
    await getAdminFirestore().collection(COLLECTIONS.scopeAssignments).doc(id).set(grant);
    grantDocIds.push(id);
  }
  return { uid, email: `${uid}@example.test`, role, displayName: `PR FH ${role}`, userRef: `pr-fh-ref-${uid}` };
}

// ---- Fixtures -------------------------------------------------------------------------------------------------------
let counter = 0;

async function seedPartner(): Promise<PartnerDoc> {
  counter += 1;
  const uid = `pr-fh-partner-${runId}-${counter}-${randomUUID().slice(0, 6)}`;
  const now = new Date().toISOString();
  const displayName = `PRFH Partner ${String(counter).padStart(3, "0")} ${runId}`;
  const partner = partnerDocSchema.parse({
    uid,
    partnerRef: uid,
    version: 1,
    displayName,
    displayNameLower: displayName.toLowerCase(),
    legalName: null,
    status: "ACTIVE",
    previousStatus: null,
    statusReason: null,
    regionIds: [R_IN],
    languageIds: [],
    categoryIds: [],
    tier: null,
    priority: null,
    targetAudience: [],
    email: `${uid}@example-partner.test`,
    phone: "+91 90000 00077",
    ownerUid: null,
    teamIds: [],
    originLeadRefs: [],
    sourceDiscovery: null,
    pendingPartnerAccountSetup: false,
    sequenceNumber: null,
    createdAt: now,
    createdByUserRef: "pr-fh-test",
    updatedAt: now,
    updatedByUserRef: "pr-fh-test",
  });
  const ref = partnersCollection().doc(uid);
  await ref.set(partner);
  cleanup.push(ref);
  return partner;
}

async function seedAssignment(partnerRef: string) {
  const uid = assignmentsCollection().doc().id;
  const now = new Date().toISOString();
  const assignment = assignmentDocSchema.parse({
    uid,
    assignmentRef: `pr-fh-as-${uid}`,
    version: 1,
    campaignRef: `pr-fh-camp-${runId}`,
    partnerRef,
    partnerAccountRefs: [],
    status: "IN_PROGRESS",
    statusReason: null,
    brief: assignmentBriefSchema.parse({ dueAt: "2016-03-10", requiredCount: 2, formats: ["reel"], platforms: ["instagram"], reviewPolicy: "REVIEW_REQUIRED", campaignName: "PRFH Campaign" }),
    ownerUid: null,
    regionIds: [R_IN],
    teamIds: [],
    createdAt: "2011-01-05T08:00:00.000Z",
    createdByUserRef: "pr-fh-test",
    updatedAt: now,
    updatedByUserRef: "pr-fh-test",
  });
  const ref = assignmentsCollection().doc(uid);
  await ref.set(assignment);
  cleanup.push(ref);
  return assignment;
}

async function seedThread(assignment: { assignmentRef: string; campaignRef: string; partnerRef: string }) {
  const uid = contentCollection().doc().id;
  const thread = contentDocSchema.parse({
    uid,
    contentRef: `pr-fh-ct-${uid}`,
    version: 3,
    assignmentRef: assignment.assignmentRef,
    campaignRef: assignment.campaignRef,
    partnerRef: assignment.partnerRef,
    status: "UNDER_REVIEW",
    statusReason: null,
    currentRevisionNumber: 1,
    reviewedRevisionNumber: 1,
    currentLinks: [{ platform: "instagram", originalUrl: `https://instagram.com/p/PRFH${uid}`, normalizedUrl: `https://instagram.com/p/prfh${uid.toLowerCase()}`, recordedAt: "2016-03-08T10:00:00.000Z" }],
    qualifyingFulfillment: null,
    dueAt: null,
    openedAt: "2016-03-01T00:00:00.000Z",
    firstSubmittedAt: "2016-03-08T10:00:00.000Z",
    lastSubmittedAt: "2016-03-08T10:00:00.000Z",
    approvedAt: null,
    cancelledAt: null,
    ownerUid: null,
    regionIds: [R_IN],
    teamIds: [],
    createdAt: "2016-03-01T00:00:00.000Z",
    createdByUserRef: "pr-fh-test",
    updatedAt: "2016-03-08T10:00:00.000Z",
    updatedByUserRef: "pr-fh-test",
  });
  const ref = contentCollection().doc(uid);
  await ref.set(thread);
  cleanup.push(ref);
  return thread;
}

async function seedAnalytics(partnerRef: string, over: { contentRef?: string | null; likes?: number } = {}) {
  const uid = `pr-fh-an-${randomUUID()}`;
  const record = analyticsContentSourceRecordDocSchema.parse({
    uid,
    sourceRef: uid,
    batchRef: `pr-fh-batch-${runId}`,
    sheetName: "Posts",
    sourceRowNumber: 2,
    platform: "instagram",
    rowIdentityKey: `pr-fh:${uid}`,
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
    normalizedUrl: "https://instagram.com/p/pr-fh-analytics",
    postDateTimeIso: "2016-03-09T10:00:00.000Z",
    comments: null,
    likes: over.likes ?? 120,
    views: null,
    profileFollowers: null,
    engagement: null,
    reportingPeriod: { start: "2016-03-01", end: "2016-03-28" },
    matchState: "MATCHED",
    matchEvidence: { tier: "published_url", value: "https://instagram.com/p/pr-fh-analytics", reasonCode: null, candidateCount: 1 },
    matchedContentRef: over.contentRef ?? null,
    matchedAssignmentRef: null,
    matchedCampaignRef: null,
    matchedPartnerRef: partnerRef,
    matchedPartnerAccountRef: null,
    ownerUid: null,
    regionIds: [R_IN],
    teamIds: [],
    createdAt: "2016-04-02T00:00:00.000Z",
  });
  const ref = analyticsContentSourceRecordsCollection().doc(uid);
  await ref.set(record);
  analyticsCleanup.push(ref);
  return record;
}

// A Partner with one in-period Assignment, its Content thread and one matched Analytics record.
async function seedRich() {
  const partner = await seedPartner();
  const assignment = await seedAssignment(partner.partnerRef);
  const thread = await seedThread(assignment);
  await seedAnalytics(partner.partnerRef, { contentRef: thread.contentRef });
  return partner;
}

// New upstream evidence for the Partner's month: changes the source fingerprint.
async function driftSource(partnerRef: string) {
  await seedAnalytics(partnerRef, { contentRef: null, likes: 55 });
}

async function generate(actor: ActorContext, partnerRef: string) {
  const result = await generatePartnerReviewDraft(actor, { partnerRef, periodKey: PERIOD }, `req-${randomUUID().slice(0, 8)}`);
  if (!result.ok) throw new Error(`generate failed: ${result.code} ${result.message}`);
  reviewRefsToClean.add(result.data.review.head.reviewRef);
  return result.data.review;
}

// A fresh review driven to IN_REVIEW (Manager prepares) with a Head actor ready to finalize.
async function inReview(partner: PartnerDoc) {
  const manager = await syntheticActor("partnership_manager");
  const head = await syntheticActor("partnership_head");
  const draft = await generate(manager, partner.partnerRef);
  const reviewRef = draft.head.reviewRef;
  const submitted = await submitPartnerReviewForReview(manager, reviewRef, { expectedDocVersion: draft.selectedVersion!.docVersion }, "req-submit");
  if (!submitted.ok) throw new Error(`submit failed: ${submitted.message}`);
  return { manager, head, reviewRef, detail: submitted.data };
}

// ---- Raw-state helpers ----------------------------------------------------------------------------------------------
const headRef = (reviewRef: string) => partnerReviewsCollection().doc(reviewRef);
const stamp = (snap: FirebaseFirestore.DocumentSnapshot) => {
  const t = snap.updateTime;
  if (!t) throw new Error("document has no updateTime");
  return `${t.seconds}.${t.nanoseconds}`;
};

type RawHint = { state: string; checkedAt: string } | null;

// Everything canonical about a review, straight from Firestore: the head's updateTime, its hint, every OTHER head
// field byte-for-byte, and every version doc byte-for-byte + updateTime, plus the audit event kinds.
async function capture(reviewRef: string) {
  const h = await headRef(reviewRef).get();
  const { freshnessHint, ...rest } = (h.data() ?? {}) as Record<string, unknown>;
  const versions = await partnerReviewVersionsCollection(reviewRef).get();
  return {
    headStamp: stamp(h),
    hint: (freshnessHint ?? null) as RawHint,
    headSansHint: JSON.stringify(rest),
    head: rest,
    versions: Object.fromEntries(versions.docs.map((d) => [d.id, { json: JSON.stringify(d.data()), stamp: stamp(d) }])),
    eventKinds: (await partnerReviewEventsCollection(reviewRef).get()).docs.map((d) => d.data().kind as string).sort(),
  };
}

async function forgeHint(reviewRef: string, hint: PartnerReviewFreshnessState | "remove") {
  await headRef(reviewRef).update({ freshnessHint: hint === "remove" ? FieldValue.delete() : { state: hint, checkedAt: "2017-01-03T00:00:00.000Z" } });
}

// A mix of every read path, cycling over the given actors.
function readerCalls(actors: ActorContext[], reviewRef: string, count: number): Promise<{ ok: boolean }>[] {
  const paths = [
    (a: ActorContext) => getPartnerReview(a, reviewRef),
    (a: ActorContext) => getPartnerReviewVersion(a, reviewRef, "1"),
    (a: ActorContext) => inspectPartnerReviewFreshness(a, reviewRef),
    (a: ActorContext) => getPartnerReviewPage(a, reviewRef, { state: "absent" }),
  ];
  return Array.from({ length: count }, (_, i) => paths[i % paths.length]!(actors[i % actors.length]!));
}

function query(over: Partial<WorkspaceQuery> = {}): WorkspaceQuery {
  return { month: { state: "absent" }, filter: null, signal: null, region: [], limit: 10, ...over };
}

// =====================================================================================================================
describe("freshnessHint: a repeated read of unchanged source state performs NO write (item 6)", () => {
  it("head updateTime, every other head byte and every version doc (bytes + updateTime) stay identical across every read path and actor; a missing hint is written once", async () => {
    const partner = await seedRich();
    const manager = await syntheticActor("partnership_manager");
    const head = await syntheticActor("partnership_head");
    const viewer = await syntheticActor("viewer");
    const analyst = await syntheticActor("analyst");
    const review = await generate(manager, partner.partnerRef);
    const reviewRef = review.head.reviewRef;

    const settled = await capture(reviewRef);
    expect(settled.hint).toMatchObject({ state: "current" });

    // Same source state, hint already records it: NO write, by any read path, for any actor.
    for (const actor of [manager, head, viewer, analyst]) {
      for (const result of await Promise.all(readerCalls([actor], reviewRef, 4))) expect(result.ok).toBe(true);
    }
    const afterReads = await capture(reviewRef);
    expect(afterReads.headStamp).toBe(settled.headStamp);
    expect(afterReads).toEqual(settled);

    // No hint recorded yet (e.g. a review written before Step 13B): the first read records the current state...
    await forgeHint(reviewRef, "remove");
    const bare = await capture(reviewRef);
    expect(bare.hint).toBeNull();
    for (const result of await Promise.all(readerCalls([manager, head, viewer, analyst], reviewRef, 16))) expect(result.ok).toBe(true);
    const recorded = await capture(reviewRef);
    expect(recorded.hint).toMatchObject({ state: "current" });
    expect(recorded.headStamp).not.toBe(bare.headStamp);
    // ...and everything else on the head + every version doc is exactly what it was.
    expect(recorded.headSansHint).toBe(bare.headSansHint);
    expect(recorded.versions).toEqual(bare.versions);

    // ...after which further reads of the unchanged source write nothing at all.
    for (const result of await Promise.all(readerCalls([manager, viewer], reviewRef, 8))) expect(result.ok).toBe(true);
    for (const result of readerCalls([head], reviewRef, 4)) expect((await result).ok).toBe(true);
    const settledAgain = await capture(reviewRef);
    expect(settledAgain.headStamp).toBe(recorded.headStamp);
    expect(settledAgain).toEqual(recorded);
  });
});

describe("freshnessHint never changes docVersion and never mutates version snapshots (items 4, 5)", () => {
  it("a state flip on an open Draft rewrites only the hint; head docVersion / updatedAt / pointers / display and the version doc are byte-identical", async () => {
    const partner = await seedRich();
    const manager = await syntheticActor("partnership_manager");
    const review = await generate(manager, partner.partnerRef);
    const reviewRef = review.head.reviewRef;
    const before = await capture(reviewRef);
    expect(before.hint).toMatchObject({ state: "current" });

    await driftSource(partner.partnerRef);
    const inspected = await inspectPartnerReviewFreshness(manager, reviewRef);
    expect(inspected.ok && inspected.data.freshness.state).toBe("refresh_available");

    const after = await capture(reviewRef);
    expect(after.hint).toMatchObject({ state: "refresh_available" });
    expect(after.headStamp).not.toBe(before.headStamp); // the hint really was written...
    expect(after.headSansHint).toBe(before.headSansHint); // ...and nothing else on the head moved
    expect(after.head.docVersion).toBe(before.head.docVersion);
    expect(after.head.updatedAt).toBe(before.head.updatedAt);
    expect(after.versions).toEqual(before.versions); // version docs: identical bytes AND identical updateTime
    expect(after.eventKinds).toEqual(before.eventKinds);
  });

  it("a state flip on a FINALIZED head, and reads of a SUPERSEDED historical version, never touch any version doc; historical reads write nothing at all", async () => {
    const partner = await seedRich();
    const { manager, head, reviewRef, detail } = await inReview(partner);
    const v1 = await finalizePartnerReview(head, reviewRef, { expectedDocVersion: detail.selectedVersion!.docVersion }, "req-fin-1");
    if (!v1.ok) throw new Error(v1.message);

    // Second version: new evidence -> revision -> submit -> finalize; version 1 becomes SUPERSEDED.
    await driftSource(partner.partnerRef);
    const stale = await getPartnerReview(manager, reviewRef);
    if (!stale.ok) throw new Error(stale.message);
    expect(stale.data.freshness?.state).toBe("revision_available");
    const revision = await createPartnerReviewRevision(manager, reviewRef, { expectedDocVersion: stale.data.head.docVersion }, "req-rev");
    if (!revision.ok) throw new Error(revision.message);
    const submitted = await submitPartnerReviewForReview(manager, reviewRef, { expectedDocVersion: revision.data.selectedVersion!.docVersion }, "req-sub-2");
    if (!submitted.ok) throw new Error(submitted.message);
    const v2 = await finalizePartnerReview(head, reviewRef, { expectedDocVersion: submitted.data.selectedVersion!.docVersion }, "req-fin-2");
    if (!v2.ok) throw new Error(v2.message);

    const settled = await capture(reviewRef);
    expect(JSON.parse(settled.versions["1"]!.json)).toMatchObject({ status: "SUPERSEDED" });
    expect(JSON.parse(settled.versions["2"]!.json)).toMatchObject({ status: "FINALIZED" });
    expect(settled.hint).toMatchObject({ state: "current" });

    // Historical (superseded) version reads: nothing is written.
    for (const result of [await getPartnerReview(manager, reviewRef, { version: 1 }), await getPartnerReviewVersion(manager, reviewRef, "1"), await inspectPartnerReviewFreshness(manager, reviewRef, { version: 1 })]) {
      expect(result.ok).toBe(true);
    }
    expect(await capture(reviewRef)).toEqual(settled);

    // New evidence again: reading the DEFAULT version flips the hint - and only the hint.
    await driftSource(partner.partnerRef);
    const inspected = await inspectPartnerReviewFreshness(manager, reviewRef);
    expect(inspected.ok && inspected.data.freshness.state).toBe("revision_available");
    const after = await capture(reviewRef);
    expect(after.hint).toMatchObject({ state: "revision_available" });
    expect(after.headSansHint).toBe(settled.headSansHint);
    expect(after.head.docVersion).toBe(settled.head.docVersion);
    expect(after.versions).toEqual(settled.versions);
    expect(after.eventKinds).toEqual(settled.eventKinds);
  });
});

describe("freshnessHint cannot corrupt canonical review state under concurrency (item 7)", () => {
  it("a slow reader that loaded the head BEFORE a lifecycle mutation cannot stamp its outdated verdict onto the mutated head (docVersion guard)", async () => {
    const partner = await seedRich();
    const manager = await syntheticActor("partnership_manager");
    const review = await generate(manager, partner.partnerRef);
    const reviewRef = review.head.reviewRef;
    expect((await capture(reviewRef)).hint).toMatchObject({ state: "current" });

    // Hold ONE reader inside its bounded evidence collection: it has already loaded the head (docVersion 1).
    const original = evidenceCollector.collectPartnerEvidence;
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => (entered = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    vi.spyOn(evidenceCollector, "collectPartnerEvidence").mockImplementationOnce(async (...args) => {
      entered();
      await gate;
      return original(...args);
    });
    const slowReader = getPartnerReview(manager, reviewRef);
    await enteredPromise;

    // Meanwhile the source changes and a lifecycle mutation (refresh) commits: docVersion 1 -> 2, hint reset then re-recorded.
    await driftSource(partner.partnerRef);
    const refreshed = await refreshPartnerReviewEvidence(manager, reviewRef, { expectedDocVersion: review.selectedVersion!.docVersion }, "req-refresh");
    if (!refreshed.ok) throw new Error(refreshed.message);
    const afterMutation = await capture(reviewRef);
    expect(afterMutation.head.docVersion).toBe(2);
    expect(afterMutation.hint).toMatchObject({ state: "current" });

    // The slow reader resumes: against ITS (pre-mutation) snapshot the evidence looks stale, and it still returns ok...
    release();
    const late = await slowReader;
    if (!late.ok) throw new Error(late.message);
    expect(late.data.freshness?.state).toBe("refresh_available");
    expect(late.data.head.docVersion).toBe(1);

    // ...but its verdict was NOT recorded on the mutated head: nothing on the head or any version changed.
    const afterLate = await capture(reviewRef);
    expect(afterLate.hint).toEqual(afterMutation.hint);
    expect(afterLate.headStamp).toBe(afterMutation.headStamp);
    expect(afterLate).toEqual(afterMutation);
    expect(JSON.parse(afterLate.versions["1"]!.json).sourceFingerprint).toBe(refreshed.data.selectedVersion!.sourceFingerprint);
  });

  it("recordFreshnessHint records only for the head revision it was computed against (stale head copy dropped)", async () => {
    const partner = await seedRich();
    const manager = await syntheticActor("partnership_manager");
    const draft = await generate(manager, partner.partnerRef);
    const reviewRef = draft.head.reviewRef;
    const oldHead = (await getPartnerReviewHeadDoc(reviewRef))!;
    const submitted = await submitPartnerReviewForReview(manager, reviewRef, { expectedDocVersion: draft.selectedVersion!.docVersion }, "req-sub");
    if (!submitted.ok) throw new Error(submitted.message);
    const settled = await capture(reviewRef);
    expect(settled.head.docVersion).toBe(oldHead.docVersion + 1);
    const settledHint = settled.hint;

    const versionDoc = (await partnerReviewVersionsCollection(reviewRef).doc("1").get()).data() as never;
    // A verdict computed against the pre-submit head (docVersion 1) is dropped: nothing changes.
    await recordFreshnessHint({ ...oldHead, freshnessHint: null }, versionDoc, { state: "evidence_incomplete", incompleteReasons: [] });
    expect(await capture(reviewRef)).toEqual(settled);
    expect(settledHint === null || settledHint.state !== "evidence_incomplete").toBe(true);
  });

  it("many parallel readers of the same review interleaved with a lifecycle mutation leave head docVersion / lifecycle / pointers / version docs / events exactly as the lifecycle service wrote them (submit, then finalize)", async () => {
    // --- submit vs. readers, with source drift so every reader wants to record a NEW hint state ---
    const partner = await seedRich();
    const manager = await syntheticActor("partnership_manager");
    const head = await syntheticActor("partnership_head");
    const viewer = await syntheticActor("viewer");
    const draft = await generate(manager, partner.partnerRef);
    const reviewRef = draft.head.reviewRef;
    await driftSource(partner.partnerRef);
    const preSubmit = await capture(reviewRef);
    expect(preSubmit.hint).toMatchObject({ state: "current" });

    const submitPromise = submitPartnerReviewForReview(manager, reviewRef, { expectedDocVersion: draft.selectedVersion!.docVersion }, "req-flood-submit");
    const [submitted, ...readResults] = await Promise.all([submitPromise, ...readerCalls([manager, head, viewer], reviewRef, 18)]);
    for (const result of readResults) expect(result.ok).toBe(true);
    if (!submitted.ok) throw new Error(`submit lost to readers: ${submitted.code} ${submitted.message}`);

    const afterSubmit = await capture(reviewRef);
    // Head: exactly the lifecycle service's write (docVersion +1, its updatedAt, IN_REVIEW, pointers untouched).
    expect(afterSubmit.head).toMatchObject({ docVersion: (preSubmit.head.docVersion as number) + 1, updatedAt: submitted.data.head.updatedAt, latestStatus: "IN_REVIEW", latestVersion: 1, openVersion: 1, currentFinalizedVersion: null });
    // Version doc: only the lifecycle fields changed; the snapshot / fingerprint / refs are byte-identical.
    const v1Before = JSON.parse(preSubmit.versions["1"]!.json) as Record<string, unknown>;
    const v1After = JSON.parse(afterSubmit.versions["1"]!.json) as Record<string, unknown>;
    const lifecycleFields = { status: "IN_REVIEW", submittedAt: submitted.data.selectedVersion!.submittedAt, submittedByUserRef: manager.userRef, docVersion: (v1Before.docVersion as number) + 1 };
    expect(v1After).toEqual({ ...v1Before, ...lifecycleFields });
    expect(afterSubmit.eventKinds).toEqual(["generated", "submitted"]);
    // Whatever hint survived is a schema-valid recorded verdict.
    if (afterSubmit.hint) {
      expect(PARTNER_REVIEW_FRESHNESS_STATES as readonly string[]).toContain(afterSubmit.hint.state);
      expect(Object.keys(afterSubmit.hint).sort()).toEqual(["checkedAt", "state"]);
    }

    // --- finalize vs. readers on an unchanged source, hint removed so every reader wants to record "current" ---
    const partner2 = await seedRich();
    const flow = await inReview(partner2);
    await forgeHint(flow.reviewRef, "remove");
    const preFinalize = await capture(flow.reviewRef);
    const finalizePromise = finalizePartnerReview(flow.head, flow.reviewRef, { expectedDocVersion: flow.detail.selectedVersion!.docVersion }, "req-flood-finalize");
    const [finalized, ...readResults2] = await Promise.all([finalizePromise, ...readerCalls([flow.manager, flow.head, viewer], flow.reviewRef, 18)]);
    for (const result of readResults2) expect(result.ok).toBe(true);
    if (!finalized.ok) throw new Error(`finalize lost to readers: ${finalized.code} ${finalized.message}`);

    const afterFinalize = await capture(flow.reviewRef);
    expect(afterFinalize.head).toMatchObject({ docVersion: (preFinalize.head.docVersion as number) + 1, updatedAt: finalized.data.head.updatedAt, latestStatus: "FINALIZED", latestVersion: 1, openVersion: null, currentFinalizedVersion: 1 });
    const f1Before = JSON.parse(preFinalize.versions["1"]!.json) as Record<string, unknown>;
    const f1After = JSON.parse(afterFinalize.versions["1"]!.json) as Record<string, unknown>;
    expect(f1After).toEqual({ ...f1Before, status: "FINALIZED", finalizedAt: finalized.data.selectedVersion!.finalizedAt, finalizedByUserRef: flow.head.userRef, docVersion: (f1Before.docVersion as number) + 1 });
    expect(afterFinalize.eventKinds).toEqual(["finalized", "generated", "submitted"]);
    // Source is unchanged, so any hint that survived can only say "current".
    if (afterFinalize.hint) expect(afterFinalize.hint.state).toBe("current");
  });
});

describe("a failure to update freshnessHint can never fail an otherwise valid read (item 8)", () => {
  it("reads still return ok with correct data when the hint write rejects or throws synchronously; nothing is recorded; the next healthy read records it", async () => {
    const partner = await seedRich();
    const manager = await syntheticActor("partnership_manager");
    const viewer = await syntheticActor("viewer");
    const review = await generate(manager, partner.partnerRef);
    const reviewRef = review.head.reviewRef;
    await forgeHint(reviewRef, "remove"); // so a healthy read WOULD write

    const healthy = await getPartnerReview(manager, reviewRef);
    if (!healthy.ok) throw new Error(healthy.message);
    expect(healthy.data.freshness?.state).toBe("current");
    await forgeHint(reviewRef, "remove");
    const settled = await capture(reviewRef);

    const db = getAdminFirestore();
    for (const mode of ["reject", "throw"] as const) {
      const spy = vi.spyOn(db, "runTransaction").mockImplementation((() => {
        if (mode === "throw") throw new Error("injected synchronous hint failure");
        return Promise.reject(new Error("injected hint failure"));
      }) as never);

      const read = await getPartnerReview(manager, reviewRef);
      const version = await getPartnerReviewVersion(viewer, reviewRef, "1");
      const inspect = await inspectPartnerReviewFreshness(manager, reviewRef);
      const page = await getPartnerReviewPage(manager, reviewRef, { state: "absent" });
      expect(spy).toHaveBeenCalled(); // the write really was attempted (and really failed)

      if (!read.ok || !version.ok || !inspect.ok || !page.ok) throw new Error(`a read failed because the hint write failed (${mode})`);
      // Correct data: identical to the healthy read (minus the evaluation clock).
      // (evaluation clock and the per-response opaque itemKeys are the only legitimately varying parts.)
      const strip = <T extends { freshness: { evaluatedAt: string } | null }>(d: T) =>
        JSON.parse(JSON.stringify({ ...d, freshness: d.freshness && { ...d.freshness, evaluatedAt: "-" } }), (key, value: unknown) => (key === "itemKey" ? "-" : value)) as unknown;
      expect(strip(read.data)).toEqual(strip(healthy.data));
      expect(strip(page.data.detail)).toEqual(strip(healthy.data));
      expect(inspect.data.freshness.state).toBe("current");
      expect(version.data.freshness.state).toBe("current");
      expect(version.data.version.docVersion).toBe(healthy.data.selectedVersion!.docVersion);

      // Nothing was recorded, nothing else moved.
      expect(await capture(reviewRef)).toEqual(settled);
      vi.restoreAllMocks();
    }

    // Healthy again: the very next read records the hint.
    expect((await getPartnerReview(manager, reviewRef)).ok).toBe(true);
    expect((await capture(reviewRef)).hint).toMatchObject({ state: "current" });
  });

  it("a mutation whose own transaction commits still returns ok when the follow-up hint write fails; the canonical state is what the lifecycle wrote", async () => {
    const partner = await seedRich();
    const manager = await syntheticActor("partnership_manager");
    const review = await generate(manager, partner.partnerRef);
    const reviewRef = review.head.reviewRef;

    const db = getAdminFirestore();
    const realTx = db.runTransaction.bind(db) as unknown as (...args: unknown[]) => Promise<unknown>;
    let calls = 0;
    vi.spyOn(db, "runTransaction").mockImplementation(((...args: unknown[]) => {
      calls += 1;
      return calls === 1 ? realTx(...args) : Promise.reject(new Error("injected hint failure"));
    }) as never);

    const submitted = await submitPartnerReviewForReview(manager, reviewRef, { expectedDocVersion: review.selectedVersion!.docVersion }, "req-submit-hintfail");
    expect(calls).toBe(2); // the lifecycle transaction, then the (failed) hint write
    if (!submitted.ok) throw new Error(`mutation failed because the hint write failed: ${submitted.message}`);
    expect(submitted.data.selectedVersion).toMatchObject({ status: "IN_REVIEW", docVersion: 2 });
    expect(submitted.data.freshness?.state).toBe("current");

    const stored = await capture(reviewRef);
    expect(stored.head).toMatchObject({ docVersion: 2, latestStatus: "IN_REVIEW", openVersion: 1 });
    expect(stored.hint).toBeNull(); // reset by the lifecycle write, and the failed re-record left it absent
    expect(JSON.parse(stored.versions["1"]!.json)).toMatchObject({ status: "IN_REVIEW", docVersion: 2 });
  });
});

describe("a stale / missing / forged freshnessHint can never permit a forbidden action or steer a decision (items 1, 2, 3, 9, 10)", () => {
  it("finalize / refresh / revision recompute source state themselves: a forged 'current' hint over changed evidence still gets REFRESH_REQUIRED with zero writes; a stale hint over unchanged evidence does not block", async () => {
    const partner = await seedRich();
    const flow = await inReview(partner);
    const { head, manager, reviewRef } = flow;
    const expectedDocVersion = flow.detail.selectedVersion!.docVersion;

    await driftSource(partner.partnerRef);
    await forgeHint(reviewRef, "current"); // the hint claims "current" while the source evidence changed
    const before = await capture(reviewRef);
    expect(before.hint).toMatchObject({ state: "current", checkedAt: "2017-01-03T00:00:00.000Z" });

    const rejected = await finalizePartnerReview(head, reviewRef, { expectedDocVersion }, "req-forged-current");
    expect(rejected).toMatchObject({ ok: false, code: "not_ready" });
    expect(!rejected.ok && rejected.blockers?.map((b) => b.code)).toEqual(["REFRESH_REQUIRED"]);
    expect(await capture(reviewRef)).toEqual(before); // a rejected finalize performs no write of any kind

    // The detail DTO's freshness is the authoritative recompute, not the hint; reading also self-heals the hint.
    const page = await getPartnerReviewPage(head, reviewRef, { state: "absent" });
    if (!page.ok) throw new Error(page.message);
    expect(page.data.detail.freshness?.state).toBe("refresh_available");
    expect((await capture(reviewRef)).hint).toMatchObject({ state: "refresh_available" });

    // Refresh recomputes too (a forged "current" is ignored), after which finalize passes...
    await forgeHint(reviewRef, "current");
    const refreshed = await refreshPartnerReviewEvidence(manager, reviewRef, { expectedDocVersion }, "req-refresh-forged");
    if (!refreshed.ok) throw new Error(refreshed.message);
    expect(refreshed.data.selectedVersion!.sourceFingerprint).not.toBe(JSON.parse(before.versions["1"]!.json).sourceFingerprint);

    // ...even when the (stale) hint claims the opposite: finalize never reads the hint.
    await forgeHint(reviewRef, "refresh_available");
    const finalized = await finalizePartnerReview(head, reviewRef, { expectedDocVersion: refreshed.data.selectedVersion!.docVersion }, "req-fin-stale-hint");
    if (!finalized.ok) throw new Error(`finalize was blocked by a stale hint: ${finalized.message}`);
    expect(finalized.data.selectedVersion).toMatchObject({ status: "FINALIZED" });

    // Revision recomputes as well: a forged 'revision_available' over unchanged evidence -> REVISION_NOT_NEEDED;
    // a forged 'current' over changed evidence -> the revision is created.
    const docVersion = finalized.data.head.docVersion;
    await forgeHint(reviewRef, "revision_available");
    const notNeeded = await createPartnerReviewRevision(manager, reviewRef, { expectedDocVersion: docVersion }, "req-rev-forged");
    expect(notNeeded).toMatchObject({ ok: false, code: "not_ready" });
    expect(!notNeeded.ok && notNeeded.blockers?.map((b) => b.code)).toEqual(["REVISION_NOT_NEEDED"]);

    await driftSource(partner.partnerRef);
    await forgeHint(reviewRef, "current");
    const revision = await createPartnerReviewRevision(manager, reviewRef, { expectedDocVersion: docVersion }, "req-rev-forged-2");
    expect(revision.ok).toBe(true);
  });

  it("the actions the UI receives never derive from the hint: permissions are the actor's own grants; create-revision availability comes from the recomputed detail freshness", async () => {
    const partner = await seedRich();
    const flow = await inReview(partner);
    const { head, manager, reviewRef } = flow;
    const viewer = await syntheticActor("viewer");
    const analyst = await syntheticActor("analyst");
    const hints: (PartnerReviewFreshnessState | "remove")[] = ["remove", "current", "refresh_available", "revision_available", "evidence_incomplete"];

    for (const [actor, canFinalize, canCreate] of [
      [head, true, true],
      [manager, false, true],
      [viewer, false, false],
      [analyst, false, false],
    ] as const) {
      const seen = new Set<string>();
      for (const hint of hints) {
        await forgeHint(reviewRef, hint);
        const page = await getPartnerReviewPage(actor, reviewRef, { state: "absent" });
        if (!page.ok) throw new Error(page.message);
        seen.add(JSON.stringify(page.data.permissions));
        expect(page.data.permissions.canFinalize).toBe(canFinalize);
        expect(page.data.permissions.canCreateRevision).toBe(canCreate);
        // The head DTO the UI receives never carries the hint, and is identical whatever the hint says.
        expect(JSON.stringify(page.data.detail.head)).not.toContain("freshnessHint");
        expect(page.data.detail.head).toMatchObject({ docVersion: 2, latestStatus: "IN_REVIEW", openVersion: 1, currentFinalizedVersion: null });
      }
      expect(seen.size).toBe(1); // permissions are identical for every hint
    }

    // Finalize is denied for Viewer / Analyst / Manager whatever the hint says - and nothing is written.
    await forgeHint(reviewRef, "current");
    const before = await capture(reviewRef);
    const expectedDocVersion = flow.detail.selectedVersion!.docVersion;
    for (const actor of [viewer, analyst, manager]) {
      const denied = await finalizePartnerReview(actor, reviewRef, { expectedDocVersion }, "req-denied");
      expect(denied).toMatchObject({ ok: false, code: "unauthorized", reason: "action_denied" });
    }
    expect(await capture(reviewRef)).toEqual(before);

    // An actor with no scope over the Partner is refused (scope_denied) whatever the hint says; reads too.
    const outsider = await syntheticActor("partnership_head", [R_OUT]);
    expect(await finalizePartnerReview(outsider, reviewRef, { expectedDocVersion }, "req-outsider")).toMatchObject({ ok: false, code: "unauthorized", reason: "scope_denied" });
    expect(await getPartnerReview(outsider, reviewRef)).toMatchObject({ ok: false, code: "unauthorized", reason: "scope_denied" });
    expect(await capture(reviewRef)).toEqual(before);

    // create-revision availability in the UI comes from detail.freshness (an authoritative recompute), not the hint:
    // finalize, then a forged 'revision_available' over unchanged evidence offers nothing; a forged 'current' over
    // changed evidence still offers it.
    const finalized = await finalizePartnerReview(head, reviewRef, { expectedDocVersion }, "req-fin");
    if (!finalized.ok) throw new Error(finalized.message);
    const actionsFor = async (actor: ActorContext) => {
      const page = await getPartnerReviewPage(actor, reviewRef, { state: "absent" });
      if (!page.ok) throw new Error(page.message);
      const version = page.data.detail.selectedVersion!;
      return computeReviewActionState({
        permissions: page.data.permissions,
        version: { version: version.version, status: version.status, docVersion: version.docVersion },
        head: page.data.detail.head,
        freshnessState: page.data.detail.freshness?.state ?? null,
      });
    };
    await forgeHint(reviewRef, "revision_available");
    expect((await actionsFor(manager)).canCreateRevision).toBe(false);
    await driftSource(partner.partnerRef);
    await forgeHint(reviewRef, "current");
    expect((await actionsFor(manager)).canCreateRevision).toBe(true);
    expect((await actionsFor(viewer)).canCreateRevision).toBe(false);
    expect((await actionsFor(head)).canFinalize).toBe(false); // FINALIZED: nothing open to finalize
  });

  it("lifecycle truth is the head pointers + version docs, never the hint: workspace rows and detail head/versions are identical whatever the hint says (or is missing); a malformed hint fails closed", async () => {
    const partner = await seedRich();
    const flow = await inReview(partner);
    const { head, reviewRef } = flow;
    const hints: (PartnerReviewFreshnessState | "remove")[] = ["remove", "current", "refresh_available", "revision_available", "revision_in_progress", "evidence_incomplete", "superseded"];

    const rowShapes = new Set<string>();
    const detailShapes = new Set<string>();
    for (const hint of hints) {
      await forgeHint(reviewRef, hint);
      const workspace = await getPartnerReviewsWorkspace(head, query({ month: parseMonthParam(PERIOD), filter: "drafts" }));
      if (!workspace.ok) throw new Error(workspace.message);
      const row = workspace.data.rows.find((r) => r.reviewRef === reviewRef);
      expect(row).toBeTruthy();
      rowShapes.add(JSON.stringify({ lifecycle: row!.lifecycle, version: row!.version, revisionOpen: row!.revisionOpen, currentFinalizedVersion: row!.currentFinalizedVersion, revisionCount: row!.revisionCount }));

      await forgeHint(reviewRef, hint);
      const detail = await getPartnerReview(head, reviewRef);
      if (!detail.ok) throw new Error(detail.message);
      detailShapes.add(JSON.stringify({ head: detail.data.head, versions: detail.data.versions, selected: { version: detail.data.selectedVersion!.version, status: detail.data.selectedVersion!.status, docVersion: detail.data.selectedVersion!.docVersion } }));
    }
    expect(rowShapes.size).toBe(1);
    expect(detailShapes.size).toBe(1);
    expect(JSON.parse([...rowShapes][0]!)).toMatchObject({ lifecycle: "IN_REVIEW", version: 1, revisionOpen: false, currentFinalizedVersion: null });

    // A malformed forged hint (invalid state) is not a valid head: every path fails closed - nothing is authorized or written.
    await headRef(reviewRef).update({ freshnessHint: { state: "finalizable", checkedAt: "2017-01-03T00:00:00.000Z" } });
    const before = await capture(reviewRef);
    const attempt = await finalizePartnerReview(head, reviewRef, { expectedDocVersion: flow.detail.selectedVersion!.docVersion }, "req-malformed");
    expect(attempt.ok).toBe(false);
    expect((await getPartnerReview(head, reviewRef)).ok).toBe(false);
    expect(await capture(reviewRef)).toEqual(before);
  });
});
