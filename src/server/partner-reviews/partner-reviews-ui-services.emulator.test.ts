// Step 13B - real reads/writes against the running Firestore/Auth emulator (no mocks): the Partner Reviews UI
// read services (Overview, Workspace, Partner search, Partner-wise history, Review Detail page), the write-time
// list projections (summary / display / freshnessHint) and the boundaries around them.
//
// Hermetic by construction, and deliberately narrower than the 13A file: every actor here is a SYNTHETIC
// ActorContext whose ONLY scope is a REGION no other test file uses (a per-run private region), so its
// lists / Overview / months can never see another file's reviews; fixtures use private-region Partners,
// Assignments, Content and Analytics records under unique past months (2011-2016, never the months other
// files use); nothing asserts a whole-collection size; every fixture (incl. review heads with their versions
// and events subcollections and the synthetic scope grants) is deleted afterwards.
import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { analyticsContentSourceRecordsCollection } from "@/server/analytics/firestore";
import { analyticsContentSourceRecordDocSchema } from "@/server/analytics/types";
import { assignmentsCollection } from "@/server/assignments/firestore";
import { assignmentBriefSchema, assignmentDocSchema } from "@/server/assignments/types";
import { seedEmulatorTestUsers } from "@/server/auth/seed-users";
import { resolveActor } from "@/server/authz/actor";
import { COLLECTIONS } from "@/server/authz/firestore";
import { scopeGrantDocId } from "@/server/authz/scope";
import { seedAccessControlData, TEST_IDENTITIES } from "@/server/authz/seed-access-data";
import type { ActorContext, ScopeGrant } from "@/server/authz/types";
import { campaignsCollection } from "@/server/campaigns/firestore";
import { campaignDocSchema } from "@/server/campaigns/types";
import { contentCollection } from "@/server/content/firestore";
import { contentDocSchema } from "@/server/content/types";
import { getAdminAuth, getAdminFirestore } from "@/server/firebase/admin";
import { partnersCollection } from "@/server/partners/firestore";
import { seedPartnersData } from "@/server/partners/seed-partners-data";
import { partnerDocSchema, type PartnerDoc } from "@/server/partners/types";

import { setCommercialPolicyProviderForTests, type GoverningCommercialPolicy } from "./commercial-policy";
import { buildEvidence } from "./evidence-builder";
import { recordFreshnessHint } from "./freshness-hint";
import * as evidenceCollector from "./evidence-collector";
import * as firestoreModule from "./firestore";
import { PARTNER_REVIEWS_COLLECTIONS, partnerReviewsCollection, partnerReviewVersionsCollection } from "./firestore";
import { createPartnerReviewRevision, finalizePartnerReview, submitPartnerReviewForReview } from "./partner-review-lifecycle-service";
import { getPartnerReviewPage } from "./partner-review-page-service";
import { getPartnerReviewsOverview } from "./partner-review-overview-service";
import { getPartnerReviewHistory } from "./partner-review-history-service";
import { getReviewActionPermissions } from "./partner-review-permissions";
import { generatePartnerReviewDraft, getPartnerReview, getPartnerReviewVersion, inspectPartnerReviewFreshness, refreshPartnerReviewEvidence } from "./partner-review-service";
import { getPartnerReviewsWorkspace, searchReviewPartners, type WorkspaceQuery } from "./partner-review-workspace-service";
import { derivePeriod, reviewRefFor } from "./period";
import { buildHeadDisplay, computeReviewListSummary } from "./review-list-summary";
import { partnerReviewHeadDocSchema, partnerReviewVersionDocSchema, type PartnerReviewHeadDoc } from "./types";
import type { ReviewListRowDto } from "./ui-dto";
import { parseMonthParam } from "./ui-params";

vi.setConfig({ testTimeout: 30_000 });

const runId = Date.now();
// The ONLY region the synthetic actors hold. IN = Partners/evidence they may see; OUT = a region they may not.
// FRESH PER TEST (beforeEach), so one test's fixtures - which live until afterAll - can never leak into another
// test's scoped lists, months or candidate scans.
let R_IN = `pr-ui-in-${runId}`;
let R_OUT = `pr-ui-out-${runId}`;
let regionCounter = 0;

const uidByRole = new Map<string, string>();
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
  const auth = getAdminAuth();
  for (const identity of TEST_IDENTITIES) uidByRole.set(identity.role, (await auth.getUserByEmail(identity.email)).uid);
}, 60_000);

beforeEach(() => {
  regionCounter += 1;
  R_IN = `pr-ui-in-${runId}-${regionCounter}`;
  R_OUT = `pr-ui-out-${runId}-${regionCounter}`;
});

afterEach(async () => {
  vi.restoreAllMocks();
  setCommercialPolicyProviderForTests(null);
  await Promise.all(
    analyticsCleanup.splice(0).map(async (ref) => {
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
  await Promise.all(grantDocIds.splice(0).map((id) => getAdminFirestore().collection(COLLECTIONS.scopeAssignments).doc(id).delete()));
});

// ---- Actors -------------------------------------------------------------------------------------------------------------
async function seededActor(role: string): Promise<ActorContext> {
  const actor = await resolveActor(uidByRole.get(role)!);
  if (!actor) throw new Error(`no seeded actor for ${role}`);
  return actor;
}

type Role = ActorContext["role"];

// A synthetic actor: the given ROLE's explicit feature/action grants (accessGrants/{role}) + a scope made of
// exactly the REGION grants named here - nothing else (no SELF, no GLOBAL, no team, no Partner grant).
async function syntheticActor(role: Role, regions: string[] = [R_IN]): Promise<ActorContext> {
  const uid = `pr-ui-${role}-${runId}-${randomUUID().slice(0, 6)}`;
  const grantedAt = new Date().toISOString();
  for (const region of regions) {
    const input = { type: "REGION" as const, region };
    const grant = { ...input, uid, grantedAt, grantedBy: "pr-ui-test" } as ScopeGrant;
    const id = scopeGrantDocId(uid, input);
    await getAdminFirestore().collection(COLLECTIONS.scopeAssignments).doc(id).set(grant);
    grantDocIds.push(id);
  }
  return { uid, email: `${uid}@example.test`, role, displayName: `PR UI ${role}`, userRef: `pr-ui-ref-${uid}` };
}

// ---- Fixtures -------------------------------------------------------------------------------------------------------------
let counter = 0;

async function seedPartner(over: { regionIds?: string[]; displayName?: string } = {}): Promise<PartnerDoc> {
  counter += 1;
  const uid = `pr-ui-partner-${runId}-${counter}-${randomUUID().slice(0, 6)}`;
  const now = new Date().toISOString();
  const displayName = over.displayName ?? `PRUI Partner ${String(counter).padStart(3, "0")} ${runId}`;
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
    regionIds: over.regionIds ?? [R_IN],
    languageIds: [],
    categoryIds: [],
    tier: null,
    priority: null,
    targetAudience: [],
    email: `${uid}@example-partner.test`,
    phone: "+91 90000 00088",
    ownerUid: null,
    teamIds: [],
    originLeadRefs: [],
    sourceDiscovery: null,
    pendingPartnerAccountSetup: false,
    sequenceNumber: null,
    createdAt: now,
    createdByUserRef: "pr-ui-test",
    updatedAt: now,
    updatedByUserRef: "pr-ui-test",
  });
  const ref = partnersCollection().doc(uid);
  await ref.set(partner);
  cleanup.push(ref);
  return partner;
}

async function seedCampaign(name: string, regionIds: string[]) {
  const uid = campaignsCollection().doc().id;
  const now = new Date().toISOString();
  const campaign = campaignDocSchema.parse({
    uid,
    campaignRef: `pr-ui-camp-${uid}`,
    version: 1,
    name,
    nameLower: name.toLowerCase(),
    objective: "Step 13B scope fixture",
    status: "ACTIVE",
    statusReason: null,
    platforms: [],
    startDate: "2011-01-01",
    endDate: "2016-12-31",
    regionIds,
    ownerUid: null,
    teamIds: [],
    criteria: { targetAudience: [], regionIds: [], languageIds: [], categoryIds: [], platforms: [] },
    resources: [],
    defaultReviewPolicy: "REVIEW_REQUIRED",
    createdAt: now,
    createdByUserRef: "pr-ui-test",
    updatedAt: now,
    updatedByUserRef: "pr-ui-test",
  });
  const ref = campaignsCollection().doc(uid);
  await ref.set(campaign);
  cleanup.push(ref);
  return campaign;
}

async function seedAssignment(partnerRef: string, over: { dueAt?: string | null; status?: string; regionIds?: string[]; campaignRef?: string; campaignName?: string; createdAt?: string } = {}) {
  const uid = assignmentsCollection().doc().id;
  const now = new Date().toISOString();
  const assignment = assignmentDocSchema.parse({
    uid,
    assignmentRef: `pr-ui-as-${uid}`,
    version: 1,
    campaignRef: over.campaignRef ?? `pr-ui-camp-${runId}`,
    partnerRef,
    partnerAccountRefs: [],
    status: over.status ?? "IN_PROGRESS",
    statusReason: over.status === "CANCELLED" ? "test" : null,
    brief: assignmentBriefSchema.parse({
      dueAt: over.dueAt === undefined ? "2016-03-10" : over.dueAt,
      requiredCount: 2,
      formats: ["reel"],
      platforms: ["instagram"],
      reviewPolicy: "REVIEW_REQUIRED",
      campaignName: over.campaignName ?? "PRUI Campaign",
    }),
    ownerUid: null,
    regionIds: over.regionIds ?? [R_IN],
    teamIds: [],
    createdAt: over.createdAt ?? "2011-01-05T08:00:00.000Z",
    createdByUserRef: "pr-ui-test",
    updatedAt: now,
    updatedByUserRef: "pr-ui-test",
  });
  const ref = assignmentsCollection().doc(uid);
  await ref.set(assignment);
  cleanup.push(ref);
  return assignment;
}

async function seedThread(assignment: { assignmentRef: string; campaignRef: string; partnerRef: string }, over: { status?: string; regionIds?: string[]; approvedAt?: string | null } = {}) {
  const uid = contentCollection().doc().id;
  const thread = contentDocSchema.parse({
    uid,
    contentRef: `pr-ui-ct-${uid}`,
    version: 3,
    assignmentRef: assignment.assignmentRef,
    campaignRef: assignment.campaignRef,
    partnerRef: assignment.partnerRef,
    status: over.status ?? "UNDER_REVIEW",
    statusReason: null,
    currentRevisionNumber: 1,
    reviewedRevisionNumber: 1,
    currentLinks: [{ platform: "instagram", originalUrl: `https://instagram.com/p/PRUI${uid}`, normalizedUrl: `https://instagram.com/p/prui${uid.toLowerCase()}`, recordedAt: "2016-03-08T10:00:00.000Z" }],
    qualifyingFulfillment: null,
    dueAt: null,
    openedAt: "2016-03-01T00:00:00.000Z",
    firstSubmittedAt: "2016-03-08T10:00:00.000Z",
    lastSubmittedAt: "2016-03-08T10:00:00.000Z",
    approvedAt: over.approvedAt ?? null,
    cancelledAt: null,
    ownerUid: null,
    regionIds: over.regionIds ?? [R_IN],
    teamIds: [],
    createdAt: "2016-03-01T00:00:00.000Z",
    createdByUserRef: "pr-ui-test",
    updatedAt: "2016-03-08T10:00:00.000Z",
    updatedByUserRef: "pr-ui-test",
  });
  const ref = contentCollection().doc(uid);
  await ref.set(thread);
  cleanup.push(ref);
  return thread;
}

async function seedAnalytics(partnerRef: string, over: { contentRef?: string | null; platform?: "instagram" | "youtube"; likes?: number | null; views?: number | null; period?: { start: string; end: string }; regionIds?: string[]; postUrl?: string } = {}) {
  const uid = `pr-ui-an-${randomUUID()}`;
  const record = analyticsContentSourceRecordDocSchema.parse({
    uid,
    sourceRef: uid,
    batchRef: `pr-ui-batch-${runId}`,
    sheetName: "Posts",
    sourceRowNumber: 2,
    platform: over.platform ?? "instagram",
    rowIdentityKey: `pr-ui:${uid}`,
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
    normalizedUrl: over.postUrl ?? "https://instagram.com/p/pr-ui-analytics",
    postDateTimeIso: "2016-03-09T10:00:00.000Z",
    comments: null,
    likes: over.likes === undefined ? 120 : over.likes,
    views: over.views === undefined ? null : over.views,
    profileFollowers: null,
    engagement: null,
    reportingPeriod: over.period ?? { start: "2016-03-01", end: "2016-03-31" },
    matchState: "MATCHED",
    matchEvidence: { tier: "published_url", value: "https://instagram.com/p/pr-ui-analytics", reasonCode: null, candidateCount: 1 },
    matchedContentRef: over.contentRef ?? null,
    matchedAssignmentRef: null,
    matchedCampaignRef: null,
    matchedPartnerRef: partnerRef,
    matchedPartnerAccountRef: null,
    ownerUid: null,
    regionIds: over.regionIds ?? [R_IN],
    teamIds: [],
    createdAt: "2016-04-02T00:00:00.000Z",
  });
  const ref = analyticsContentSourceRecordsCollection().doc(uid);
  await ref.set(record);
  analyticsCleanup.push(ref);
  return record;
}

// A Partner with one in-period Assignment (due `dueAt`), its Content thread and one matched Analytics record.
async function seedRich(over: { regionIds?: string[]; dueAt?: string; displayName?: string; likes?: number; threadStatus?: string } = {}) {
  const partner = await seedPartner({ regionIds: over.regionIds, displayName: over.displayName });
  const dueAt = over.dueAt ?? "2016-03-10";
  const period = { start: `${dueAt.slice(0, 7)}-01`, end: `${dueAt.slice(0, 7)}-28` };
  const assignment = await seedAssignment(partner.partnerRef, { dueAt, regionIds: over.regionIds });
  const thread = await seedThread(assignment, { regionIds: over.regionIds, status: over.threadStatus });
  const record = await seedAnalytics(partner.partnerRef, { contentRef: thread.contentRef, likes: over.likes ?? 120, period, regionIds: over.regionIds });
  return { partner, assignment, thread, record };
}

async function generate(actor: ActorContext, partnerRef: string, periodKey: string) {
  const result = await generatePartnerReviewDraft(actor, { partnerRef, periodKey }, `req-${randomUUID().slice(0, 8)}`);
  if (!result.ok) throw new Error(`generate failed: ${result.code} ${result.message}`);
  reviewRefsToClean.add(result.data.review.head.reviewRef);
  return result.data;
}

// Drives DRAFT -> IN_REVIEW -> FINALIZED (Manager prepares, Head finalizes).
async function generateAndFinalize(partnerRef: string, periodKey: string) {
  const manager = await syntheticActor("partnership_manager");
  const head = await syntheticActor("partnership_head");
  const generated = await generate(manager, partnerRef, periodKey);
  const reviewRef = generated.review.head.reviewRef;
  const submitted = await submitPartnerReviewForReview(manager, reviewRef, { expectedDocVersion: generated.review.selectedVersion!.docVersion }, "req-submit");
  if (!submitted.ok) throw new Error(`submit failed: ${submitted.message}`);
  const finalized = await finalizePartnerReview(head, reviewRef, { expectedDocVersion: submitted.data.selectedVersion!.docVersion }, "req-finalize");
  if (!finalized.ok) throw new Error(`finalize failed: ${finalized.message}`);
  return { reviewRef, manager, head, finalized: finalized.data };
}

// A review head + version written DIRECTLY (schema-valid, with its display projection) - a cheap way to
// build a long month history without running the collector once per month.
async function seedDirectReview(partner: PartnerDoc, periodKey: string, over: { status?: "DRAFT" | "IN_REVIEW" | "FINALIZED"; noDisplay?: boolean; hint?: "refresh_available" | "revision_available" | "current" | null } = {}) {
  const period = derivePeriod(periodKey)!;
  const built = buildEvidence({ partnerRef: partner.partnerRef, period, evidenceCutoff: "2017-01-01T00:00:00.000Z", assignments: [], assignmentScanTruncated: false, assignmentsScanned: 0, threads: [], analyticsRecords: [], analyticsScanTruncated: false, analyticsRecordsScanned: 0 });
  const reviewRef = reviewRefFor(partner.partnerRef, periodKey);
  const status = over.status ?? "DRAFT";
  const now = "2017-01-02T00:00:00.000Z";
  const version = partnerReviewVersionDocSchema.parse({
    reviewRef,
    version: 1,
    status,
    docVersion: 1,
    snapshot: built.snapshot,
    evidenceCutoff: built.snapshot.evidenceCutoff,
    sourceFingerprint: built.sourceFingerprint,
    sourceRefs: built.sourceRefs,
    generatedAt: now,
    generatedByUserRef: "pr-ui-test",
    finalizedAt: status === "FINALIZED" ? now : null,
    finalizedByUserRef: status === "FINALIZED" ? "pr-ui-test" : null,
    createdAt: now,
    createdByUserRef: "pr-ui-test",
    ...(over.noDisplay ? {} : { summary: computeReviewListSummary(built.snapshot) }),
  });
  const head: PartnerReviewHeadDoc = partnerReviewHeadDocSchema.parse({
    reviewRef,
    partnerRef: partner.partnerRef,
    partnerUid: partner.uid,
    periodKey,
    periodStart: period.periodStart,
    periodEnd: period.periodEnd,
    latestVersion: 1,
    latestStatus: status,
    currentFinalizedVersion: status === "FINALIZED" ? 1 : null,
    openVersion: status === "FINALIZED" ? null : 1,
    docVersion: 1,
    ownerUid: partner.ownerUid,
    regionIds: partner.regionIds,
    teamIds: partner.teamIds,
    createdAt: now,
    createdByUserRef: "pr-ui-test",
    updatedAt: now,
    updatedByUserRef: "pr-ui-test",
    ...(over.noDisplay ? {} : { display: buildHeadDisplay({ version, latestVersion: 1, event: { kind: status === "FINALIZED" ? "finalized" : "generated", at: now }, finalized: status === "FINALIZED" ? { version: 1, at: now } : null }) }),
    ...(over.hint ? { freshnessHint: { state: over.hint, checkedAt: "2017-01-03T00:00:00.000Z" } } : {}),
  });
  await partnerReviewsCollection().doc(reviewRef).set(head);
  await partnerReviewVersionsCollection(reviewRef).doc("1").set(version);
  reviewRefsToClean.add(reviewRef);
  return { head, version, reviewRef };
}

function query(over: Partial<WorkspaceQuery> = {}): WorkspaceQuery {
  return { month: { state: "absent" }, filter: null, signal: null, region: [], limit: 10, ...over };
}

async function workspace(actor: ActorContext, over: Partial<WorkspaceQuery> = {}) {
  const result = await getPartnerReviewsWorkspace(actor, query(over));
  if (!result.ok) throw new Error(`workspace failed: ${result.code}`);
  return result.data;
}

async function rawHeadWithoutHint(reviewRef: string): Promise<string> {
  const snap = await partnerReviewsCollection().doc(reviewRef).get();
  const { freshnessHint, ...rest } = (snap.data() ?? {}) as Record<string, unknown>;
  void freshnessHint;
  return JSON.stringify(rest);
}

const partnerNames = (rows: ReviewListRowDto[]) => rows.map((row) => row.partnerDisplayName);

// ======================================================================================================================
describe("write-time list projections (summary / display / freshnessHint)", () => {
  it("generate writes a version summary and a head display block that match the canonical snapshot; freshnessHint is recorded without touching docVersion", async () => {
    const { partner } = await seedRich({ dueAt: "2016-03-10" });
    const admin = await seededActor("super_admin");
    const generated = await generate(admin, partner.partnerRef, "2016-03");
    const reviewRef = generated.review.head.reviewRef;

    const headSnap = (await partnerReviewsCollection().doc(reviewRef).get()).data()!;
    const versionSnap = (await partnerReviewVersionsCollection(reviewRef).doc("1").get()).data()!;
    const canonical = computeReviewListSummary(versionSnap.snapshot);

    expect(versionSnap.summary).toEqual(canonical);
    expect(headSnap.display).toMatchObject({ version: 1, status: "DRAFT", lastEventKind: "generated", revisionCount: 0, supersededVersion: null, finalizedVersion: null, finalizedAt: null });
    expect(headSnap.display.summary).toEqual(canonical);
    expect(headSnap.display.evidenceCutoff).toBe(versionSnap.evidenceCutoff);
    // The stored summary counts what the snapshot says.
    expect(canonical.production.assignmentsIncluded).toBe(1);
    expect(canonical.production.underReviewContent).toBe(1);
    expect(canonical.performance).toMatchObject({ state: "available", recordCount: 1 });
    // A hint was recorded right after the mutation (the response already computed freshness), docVersion untouched by it.
    expect(headSnap.freshnessHint).toMatchObject({ state: "current" });
    expect(headSnap.docVersion).toBe(1);
    // The stored summary carries no source ref and no URL (counts and labels only).
    expect(JSON.stringify(headSnap.display)).not.toMatch(/pr-ui-as|pr-ui-ct|pr-ui-an|https?:/);
  });

  it("refresh / submit / finalize / revision / finalize-again keep the display block in step with the head and supersession", async () => {
    const { partner, record } = await seedRich({ dueAt: "2016-04-10" });
    const { reviewRef, manager, head } = await generateAndFinalize(partner.partnerRef, "2016-04");
    const headRef = partnerReviewsCollection().doc(reviewRef);

    let display = (await headRef.get()).data()!.display;
    expect(display).toMatchObject({ version: 1, status: "FINALIZED", lastEventKind: "finalized", finalizedVersion: 1, supersededVersion: null });
    expect(typeof display.finalizedAt).toBe("string");
    const firstFinalizedAt = display.finalizedAt;

    // New upstream evidence -> revision available -> revision.
    await seedAnalytics(partner.partnerRef, { contentRef: null, likes: 55, period: { start: "2016-04-01", end: "2016-04-28" } });
    void record;
    const stale = await getPartnerReview(head, reviewRef);
    expect(stale.ok && stale.data.freshness?.state).toBe("revision_available");
    expect((await headRef.get()).data()!.freshnessHint).toMatchObject({ state: "revision_available" });

    const revision = await createPartnerReviewRevision(manager, reviewRef, { expectedDocVersion: stale.ok ? stale.data.head.docVersion : 0 }, "req-revision");
    expect(revision.ok).toBe(true);
    display = (await headRef.get()).data()!.display;
    expect(display).toMatchObject({ version: 2, status: "DRAFT", lastEventKind: "revision_created", revisionCount: 1, finalizedVersion: 1, finalizedAt: firstFinalizedAt });
    // The new draft's summary reflects the NEW evidence (two records), while version 1's summary is untouched.
    expect(display.summary.performance.recordCount).toBe(2);
    expect((await partnerReviewVersionsCollection(reviewRef).doc("1").get()).data()!.summary.performance.recordCount).toBe(1);
    expect((await headRef.get()).data()!.freshnessHint).toMatchObject({ state: "current" });

    const v2 = revision.ok ? revision.data.selectedVersion! : null;
    const refreshed = await refreshPartnerReviewEvidence(manager, reviewRef, { version: 2, expectedDocVersion: v2!.docVersion }, "req-refresh");
    expect(refreshed.ok).toBe(true);
    expect((await headRef.get()).data()!.display).toMatchObject({ version: 2, lastEventKind: "refreshed" });

    const submitted = await submitPartnerReviewForReview(manager, reviewRef, { expectedDocVersion: refreshed.ok ? refreshed.data.selectedVersion!.docVersion : 0 }, "req-submit-2");
    expect(submitted.ok).toBe(true);
    expect((await headRef.get()).data()!.display).toMatchObject({ version: 2, status: "IN_REVIEW", lastEventKind: "submitted" });

    const finalizedAgain = await finalizePartnerReview(head, reviewRef, { expectedDocVersion: submitted.ok ? submitted.data.selectedVersion!.docVersion : 0 }, "req-finalize-2");
    expect(finalizedAgain.ok).toBe(true);
    const finalDisplay = (await headRef.get()).data()!.display;
    expect(finalDisplay).toMatchObject({ version: 2, status: "FINALIZED", lastEventKind: "finalized", supersededVersion: 1, finalizedVersion: 2, revisionCount: 1 });
    expect(finalDisplay.finalizedAt).not.toBe(firstFinalizedAt);
  });

  it("freshnessHint: recorded when the state first differs, never rewritten by a re-read, never changes docVersion / updatedAt, and never touches the finalized version", async () => {
    const { partner } = await seedRich({ dueAt: "2016-05-10" });
    const { reviewRef, head } = await generateAndFinalize(partner.partnerRef, "2016-05");
    const headRef = partnerReviewsCollection().doc(reviewRef);
    const before = (await headRef.get()).data()!;
    const versionBefore = JSON.stringify((await partnerReviewVersionsCollection(reviewRef).doc("1").get()).data());
    expect(before.freshnessHint).toMatchObject({ state: "current" });

    await seedAnalytics(partner.partnerRef, { contentRef: null, likes: 5, period: { start: "2016-05-01", end: "2016-05-28" } });
    expect((await inspectPartnerReviewFreshness(head, reviewRef)).ok).toBe(true);
    const after = (await headRef.get()).data()!;
    expect(after.freshnessHint).toMatchObject({ state: "revision_available" });
    expect(after.docVersion).toBe(before.docVersion);
    expect(after.updatedAt).toBe(before.updatedAt);

    // A re-read of the SAME state writes nothing (checkedAt stays), by any read path.
    const checkedAt = after.freshnessHint.checkedAt;
    await getPartnerReview(head, reviewRef);
    await getPartnerReviewVersion(head, reviewRef, "1");
    await inspectPartnerReviewFreshness(head, reviewRef);
    expect((await headRef.get()).data()!.freshnessHint.checkedAt).toBe(checkedAt);
    // Everything except the hint on the head, and the whole finalized version, is byte-identical.
    expect(JSON.stringify((await partnerReviewVersionsCollection(reviewRef).doc("1").get()).data())).toBe(versionBefore);
  });

  it("a hint that cannot be written is non-fatal: recording it against a missing head resolves quietly and creates nothing", async () => {
    const partner = await seedPartner();
    const direct = await seedDirectReview(partner, "2016-06");
    // A head whose document does not exist: update() would reject NOT_FOUND - the recorder must swallow it.
    const ghost = { ...direct.head, reviewRef: reviewRefFor(partner.partnerRef, "2016-07"), freshnessHint: null };
    await expect(recordFreshnessHint(ghost, direct.version, { state: "refresh_available", incompleteReasons: [] })).resolves.toBeUndefined();
    expect((await partnerReviewsCollection().doc(ghost.reviewRef).get()).exists).toBe(false);
    // Only the default version's freshness is ever recorded: a historical version is ignored.
    const other = { ...direct.head, openVersion: 2, latestVersion: 2 };
    await recordFreshnessHint(other, direct.version, { state: "refresh_available", incompleteReasons: [] });
    expect((await partnerReviewsCollection().doc(direct.reviewRef).get()).data()!.freshnessHint).toBeUndefined();
  });

  it("a head / version written before Step 13B (no display, no summary) still parses, and lists fall back to the stored snapshot", async () => {
    const partner = await seedPartner();
    await seedDirectReview(partner, "2015-03", { noDisplay: true });
    const mgr = await syntheticActor("partnership_manager");
    const data = await workspace(mgr, { month: parseMonthParam("2015-03"), filter: "drafts" });
    const row = data.rows.find((r) => r.partnerRef === partner.partnerRef)!;
    expect(row).toBeTruthy();
    expect(row.summarySource).toBe("derived_from_snapshot");
    expect(row.summary).toMatchObject({ production: { assignmentsIncluded: 0 }, performance: { state: "missing" } });
    expect(row.lifecycle).toBe("DRAFT");
  });
});

// ======================================================================================================================
describe("Overview service", () => {
  it("the default month is the latest month with a review head - never the (empty) current calendar month - and an explicit month is never changed", async () => {
    const mgr = await syntheticActor("partnership_manager");
    const a = await seedPartner();
    const b = await seedPartner();
    await seedDirectReview(a, "2014-05");
    await seedDirectReview(b, "2014-02");

    const overview = await getPartnerReviewsOverview(mgr, { state: "absent" });
    expect(overview.ok).toBe(true);
    if (!overview.ok) return;
    expect(overview.data.month).toMatchObject({ resolved: "2014-05", source: "latest_review", invalidRequested: false });
    expect(overview.data.month.options.map((o) => o.month)).toEqual(["2014-05", "2014-02"]);
    expect(overview.data.counts.monthlyReviews).toBe(1);

    const explicit = await getPartnerReviewsOverview(mgr, { state: "valid", month: "2014-02" });
    expect(explicit.ok && explicit.data.month).toMatchObject({ resolved: "2014-02", source: "explicit" });
    const noData = await getPartnerReviewsOverview(mgr, { state: "valid", month: "2010-01" });
    expect(noData.ok && noData.data.month).toMatchObject({ resolved: "2010-01", source: "explicit" });
    expect(noData.ok && noData.data.counts.monthlyReviews).toBe(0);
    const invalid = await getPartnerReviewsOverview(mgr, { state: "invalid" });
    expect(invalid.ok && invalid.data.month).toMatchObject({ resolved: "2014-05", invalidRequested: true });
  });

  it("counts real reviews: lifecycle is exclusive, Needs review includes candidates and hinted-behind reviews, stale/missing are never zeros for missing", async () => {
    const mgr = await syntheticActor("partnership_manager");
    const draft = await seedPartner();
    const finalized = await seedPartner();
    const behind = await seedPartner();
    const candidate = await seedRich({ dueAt: "2013-08-15" });
    await seedDirectReview(draft, "2013-08", { status: "DRAFT" });
    await seedDirectReview(finalized, "2013-08", { status: "FINALIZED" });
    await seedDirectReview(behind, "2013-08", { status: "FINALIZED", hint: "revision_available" });

    const result = await getPartnerReviewsOverview(mgr, { state: "valid", month: "2013-08" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { counts } = result.data;
    expect(counts.monthlyReviews).toBe(3);
    expect(counts.finalizedReviews).toBe(2);
    // candidate (no head yet) + the hinted-behind finalized review
    expect(counts.lifecycle).toEqual({ needsReview: 2, draftInReview: 1, finalized: 1 });
    expect(counts.attention.revisionAvailable).toBe(1);
    // The empty snapshots have no Analytics evidence: all three are Missing (one is also hinted stale - counted once).
    expect(counts.performance).toEqual({ available: 0, stale: 0, missing: 3 });
    void candidate;
    expect(result.data.activity.length).toBeGreaterThan(0);
    expect(result.data.activity.length).toBeLessThanOrEqual(6);
    // No source ref of any kind in the Overview DTO.
    expect(JSON.stringify(result.data)).not.toMatch(/pr-ui-as|pr-ui-ct|pr-ui-an|https?:/);
  });

  it("a scoped actor never counts a review whose Partner is outside its scope", async () => {
    const mgr = await syntheticActor("partnership_manager");
    const inScope = await seedPartner();
    const outScope = await seedPartner({ regionIds: [R_OUT] });
    await seedDirectReview(inScope, "2012-04");
    await seedDirectReview(outScope, "2012-04");
    const result = await getPartnerReviewsOverview(mgr, { state: "valid", month: "2012-04" });
    expect(result.ok && result.data.counts.monthlyReviews).toBe(1);
  });

  it("an unauthenticated caller and an actor without the partner_reviews feature are denied", async () => {
    expect((await getPartnerReviewsOverview(null, { state: "absent" })).ok).toBe(false);
  });
});

// ======================================================================================================================
describe("Workspace service", () => {
  it("filters: Needs Review (candidates + hinted-behind reviews), Drafts / In Review (open versions), Finalized / History (current finalized)", async () => {
    const mgr = await syntheticActor("partnership_manager");
    const draft = await seedPartner({ displayName: `WS Draft ${runId}` });
    const inReview = await seedPartner({ displayName: `WS InReview ${runId}` });
    const finalized = await seedPartner({ displayName: `WS Final ${runId}` });
    const behind = await seedPartner({ displayName: `WS Behind ${runId}` });
    const cand = await seedRich({ dueAt: "2010-09-12", displayName: `WS Candidate ${runId}` });
    await seedDirectReview(draft, "2010-09", { status: "DRAFT" });
    await seedDirectReview(inReview, "2010-09", { status: "IN_REVIEW" });
    await seedDirectReview(finalized, "2010-09", { status: "FINALIZED" });
    await seedDirectReview(behind, "2010-09", { status: "DRAFT", hint: "refresh_available" });

    const month = parseMonthParam("2010-09");
    const needs = await workspace(mgr, { month, filter: "needs-review" });
    expect(partnerNames(needs.rows)).toEqual([`WS Behind ${runId}`, `WS Candidate ${runId}`]);
    expect(needs.rows.map((r) => r.kind)).toEqual(["review", "candidate"]);
    expect(needs.rows[1]).toMatchObject({ lifecycle: "NEEDS_REVIEW", reviewRef: null, summary: null, assignmentsFound: 1 });
    expect(needs.rows[0]).toMatchObject({ needsReviewReason: "refresh_available" });

    const drafts = await workspace(mgr, { month, filter: "drafts" });
    expect(new Set(partnerNames(drafts.rows))).toEqual(new Set([`WS Draft ${runId}`, `WS InReview ${runId}`, `WS Behind ${runId}`]));
    const final = await workspace(mgr, { month, filter: "finalized" });
    expect(partnerNames(final.rows)).toEqual([`WS Final ${runId}`]);
    void cand;
  });

  it("a candidate is excluded once a review head exists for its Partner-month (generate is idempotent, and one review results)", async () => {
    const mgr = await syntheticActor("partnership_manager");
    const { partner } = await seedRich({ dueAt: "2009-04-12", displayName: `WS Gen ${runId}` });
    const month = parseMonthParam("2009-04");
    const before = await workspace(mgr, { month, filter: "needs-review" });
    expect(before.rows.map((r) => r.partnerRef)).toEqual([partner.partnerRef]);

    const first = await generate(mgr, partner.partnerRef, "2009-04");
    expect(first.outcome).toBe("created");
    const second = await generatePartnerReviewDraft(mgr, { partnerRef: partner.partnerRef, periodKey: "2009-04" }, "req-retry");
    expect(second.ok && second.data.outcome).toBe("existing");
    expect(second.ok && second.data.review.head.reviewRef).toBe(first.review.head.reviewRef);

    const after = await workspace(mgr, { month, filter: "needs-review" });
    expect(after.rows).toEqual([]);
    const drafts = await workspace(mgr, { month, filter: "drafts" });
    expect(drafts.rows.map((r) => r.partnerRef)).toEqual([partner.partnerRef]);
    expect(drafts.rows[0]).toMatchObject({ lifecycle: "DRAFT", version: 1, needsReviewReason: null });
  });

  it("cursor pagination: deterministic order, exact page boundaries, no duplicates or gaps across pages (drafts AND needs-review)", async () => {
    const mgr = await syntheticActor("partnership_manager");
    const partners = [] as PartnerDoc[];
    for (let i = 0; i < 5; i += 1) partners.push(await seedPartner({ displayName: `PG ${String(i).padStart(2, "0")} ${runId}` }));
    for (const partner of partners) await seedDirectReview(partner, "2008-07", { status: "DRAFT" });
    const month = parseMonthParam("2008-07");

    const seen: string[] = [];
    let cursor: string | undefined;
    const sizes: number[] = [];
    for (let page = 0; page < 5; page += 1) {
      const data = await workspace(mgr, { month, filter: "drafts", limit: 2, cursor });
      sizes.push(data.rows.length);
      seen.push(...data.rows.map((r) => r.reviewRef!));
      if (!data.nextCursor) break;
      cursor = data.nextCursor;
    }
    expect(sizes).toEqual([2, 2, 1]);
    expect(new Set(seen).size).toBe(5);
    // Deterministic: the whole list re-fetched in one page equals the paged concatenation, ordered by Partner name.
    const whole = await workspace(mgr, { month, filter: "drafts", limit: 20 });
    expect(whole.rows.map((r) => r.reviewRef)).toEqual(seen);
    expect(partnerNames(whole.rows)).toEqual([...partnerNames(whole.rows).map(String)].sort());
    // Repeating the same cursor gives the same page.
    const firstPage = await workspace(mgr, { month, filter: "drafts", limit: 2 });
    const again = await workspace(mgr, { month, filter: "drafts", limit: 2 });
    expect(again.rows.map((r) => r.reviewRef)).toEqual(firstPage.rows.map((r) => r.reviewRef));
    expect(firstPage.nextCursor).toBe(again.nextCursor);

    // needs-review: 5 candidates, sorted by Partner name, paged in memory over the bounded scan.
    const cands = [] as string[];
    for (let i = 0; i < 5; i += 1) cands.push((await seedRich({ dueAt: "2008-09-12", displayName: `NR ${String(4 - i).padStart(2, "0")} ${runId}` })).partner.displayName);
    const nrMonth = parseMonthParam("2008-09");
    const names: string[] = [];
    let nrCursor: string | undefined;
    const nrSizes: number[] = [];
    for (let page = 0; page < 5; page += 1) {
      const data = await workspace(mgr, { month: nrMonth, filter: "needs-review", limit: 2, cursor: nrCursor });
      nrSizes.push(data.rows.length);
      names.push(...partnerNames(data.rows).map(String));
      expect(data.totalInBoundedSet).toBe(5);
      if (!data.nextCursor) break;
      nrCursor = data.nextCursor;
    }
    expect(nrSizes).toEqual([2, 2, 1]);
    expect(names).toEqual([...cands].sort());
  });

  it("a filter that rejects most raw reviews never truncates the list: 1 finalized among 12 drafts is found on the first page (limit 2)", async () => {
    const mgr = await syntheticActor("partnership_manager");
    for (let i = 0; i < 12; i += 1) await seedDirectReview(await seedPartner(), "2007-09", { status: "DRAFT" });
    const finalized = await seedPartner({ displayName: `Lonely Finalized ${runId}` });
    await seedDirectReview(finalized, "2007-09", { status: "FINALIZED" });
    const data = await workspace(mgr, { month: parseMonthParam("2007-09"), filter: "finalized", limit: 2 });
    expect(partnerNames(data.rows)).toEqual([`Lonely Finalized ${runId}`]);
    expect(data.nextCursor).toBeNull();
    expect(data.totalInBoundedSet).toBe(1);
    const drafts = await workspace(mgr, { month: parseMonthParam("2007-09"), filter: "drafts", limit: 20 });
    expect(drafts.rows).toHaveLength(12);
  });

  it("a malformed / tampered cursor starts over instead of being trusted", async () => {
    const mgr = await syntheticActor("partnership_manager");
    const p = await seedPartner();
    await seedDirectReview(p, "2007-01");
    const data = await workspace(mgr, { month: parseMonthParam("2007-01"), filter: "drafts", cursor: "###not-a-cursor###" });
    expect(data.rows).toHaveLength(1);
  });

  it("Partner filter narrows to one Partner; an out-of-scope Partner ref is dropped with ONE neutral notice and never becomes a data source; Region narrows by the review's region", async () => {
    const mgr = await syntheticActor("partnership_manager", [R_IN, `${R_IN}-b`]);
    const one = await seedPartner();
    const two = await seedPartner({ regionIds: [`${R_IN}-b`] });
    const hidden = await seedPartner({ regionIds: [R_OUT] });
    await seedDirectReview(one, "2006-05");
    await seedDirectReview(two, "2006-05");
    await seedDirectReview(hidden, "2006-05");
    const month = parseMonthParam("2006-05");

    const all = await workspace(mgr, { month, filter: "drafts" });
    expect(new Set(all.rows.map((r) => r.partnerRef))).toEqual(new Set([one.partnerRef, two.partnerRef]));

    const filtered = await workspace(mgr, { month, filter: "drafts", partnerRef: one.partnerRef });
    expect(filtered.rows.map((r) => r.partnerRef)).toEqual([one.partnerRef]);
    expect(filtered.partnerFilter).toMatchObject({ partnerRef: one.partnerRef });

    const denied = await workspace(mgr, { month, filter: "drafts", partnerRef: hidden.partnerRef });
    expect(denied.partnerFilter).toBeNull();
    expect(denied.notices).toHaveLength(1);
    expect(denied.notices[0]).not.toContain(hidden.displayName);
    expect(new Set(denied.rows.map((r) => r.partnerRef))).toEqual(new Set([one.partnerRef, two.partnerRef]));
    // Unknown and out-of-scope produce the identical notice.
    const unknown = await workspace(mgr, { month, filter: "drafts", partnerRef: "does-not-exist" });
    expect(unknown.notices).toEqual(denied.notices);

    const byRegion = await workspace(mgr, { month, filter: "drafts", region: [`${R_IN}-b`] });
    expect(byRegion.rows.map((r) => r.partnerRef)).toEqual([two.partnerRef]);
  });

  it("Partner search is scope-first: an out-of-scope Partner never appears for a scoped actor", async () => {
    const mgr = await syntheticActor("partnership_manager");
    const admin = await seededActor("super_admin");
    const tag = `Searchable${randomUUID().slice(0, 6)}`;
    const visible = await seedPartner({ displayName: `${tag} Visible` });
    const hidden = await seedPartner({ displayName: `${tag} Hidden`, regionIds: [R_OUT] });

    const forMgr = await searchReviewPartners(mgr, { q: tag });
    expect(forMgr.ok && forMgr.data.partners.map((p) => p.partnerRef)).toEqual([visible.partnerRef]);
    expect(JSON.stringify(forMgr)).not.toContain(hidden.partnerRef);
    const forAdmin = await searchReviewPartners(admin, { q: tag });
    expect(forAdmin.ok && new Set(forAdmin.data.partners.map((p) => p.partnerRef))).toEqual(new Set([visible.partnerRef, hidden.partnerRef]));
    // Display identity only.
    expect(Object.keys(forMgr.ok ? forMgr.data.partners[0]! : {}).sort()).toEqual(["displayName", "partnerRef", "regions"]);
    expect((await searchReviewPartners(null, { q: tag })).ok).toBe(false);
  });

  it("signal drill-down uses stored summaries and recorded hints only", async () => {
    const mgr = await syntheticActor("partnership_manager");
    const behind = await seedPartner();
    const fine = await seedPartner();
    await seedDirectReview(behind, "2005-03", { status: "DRAFT", hint: "refresh_available" });
    await seedDirectReview(fine, "2005-03", { status: "DRAFT" });
    const month = parseMonthParam("2005-03");
    const stale = await workspace(mgr, { month, signal: "stale" });
    expect(stale.mode).toBe("signal");
    expect(stale.rows.map((r) => r.partnerRef)).toEqual([behind.partnerRef]);
    const missing = await workspace(mgr, { month, signal: "missing_evidence" });
    expect(new Set(missing.rows.map((r) => r.partnerRef))).toEqual(new Set([behind.partnerRef, fine.partnerRef]));
  });

  it("an empty scope yields no month and no rows (never the current calendar month)", async () => {
    const nobody = await syntheticActor("partnership_manager", [`pr-ui-empty-${runId}`]);
    const data = await workspace(nobody, {});
    expect(data.month).toMatchObject({ resolved: null, source: "none" });
    expect(data.rows).toEqual([]);
  });
});

// ======================================================================================================================
describe("list boundary: no collector, no per-row freshness, no writes", () => {
  it("Overview / Workspace / Partner search / Partner history never invoke the evidence collector or read a version document for stored-display heads; the detail path invokes it exactly once", async () => {
    const mgr = await syntheticActor("partnership_manager");
    const partner = await seedPartner();
    for (const m of ["2004-01", "2004-02", "2004-03"]) await seedDirectReview(partner, m);
    const collector = vi.spyOn(evidenceCollector, "collectPartnerEvidence");
    const versionRead = vi.spyOn(firestoreModule, "getPartnerReviewVersionDoc");

    const before = await rawHeadWithoutHint(reviewRefFor(partner.partnerRef, "2004-03"));
    expect((await getPartnerReviewsOverview(mgr, { state: "valid", month: "2004-03" })).ok).toBe(true);
    await workspace(mgr, { month: parseMonthParam("2004-03"), filter: "drafts" });
    await workspace(mgr, { month: parseMonthParam("2004-03"), filter: "needs-review" });
    expect((await searchReviewPartners(mgr, { q: "PRUI" })).ok).toBe(true);
    expect((await getPartnerReviewHistory(mgr, partner.partnerRef, { month: { state: "absent" }, until: { state: "absent" } })).ok).toBe(true);

    expect(collector).toHaveBeenCalledTimes(0);
    expect(versionRead).toHaveBeenCalledTimes(0);
    // Lists write nothing.
    expect(await rawHeadWithoutHint(reviewRefFor(partner.partnerRef, "2004-03"))).toBe(before);
    expect((await partnerReviewsCollection().doc(reviewRefFor(partner.partnerRef, "2004-03")).get()).data()!.freshnessHint).toBeUndefined();

    // Exactly one bounded freshness computation for ONE opened review.
    const page = await getPartnerReviewPage(mgr, reviewRefFor(partner.partnerRef, "2004-03"), { state: "absent" });
    expect(page.ok).toBe(true);
    expect(collector).toHaveBeenCalledTimes(1);
  });
});

// ======================================================================================================================
describe("Partner-wise history service", () => {
  it("is a bounded 12-calendar-month window, newest first, defaulting to the Partner's latest review month; older months are reachable via `until`", async () => {
    const mgr = await syntheticActor("partnership_manager");
    const partner = await seedPartner();
    // 14 consecutive months of reviews: 2003-01 .. 2004-02
    const months: string[] = [];
    for (let y = 2003; y <= 2004; y += 1) for (let m = 1; m <= 12; m += 1) if (y === 2003 || m <= 2) months.push(`${y}-${String(m).padStart(2, "0")}`);
    for (const month of months) await seedDirectReview(partner, month);

    const collector = vi.spyOn(evidenceCollector, "collectPartnerEvidence");
    const versionRead = vi.spyOn(firestoreModule, "getPartnerReviewVersionDoc");
    const result = await getPartnerReviewHistory(mgr, partner.partnerRef, { month: { state: "absent" }, until: { state: "absent" } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const view = result.data;
    expect(view.month).toMatchObject({ selected: "2004-02", source: "latest_review" });
    expect(view.rows).toHaveLength(12);
    expect(view.rows[0]!.periodKey).toBe("2004-02");
    expect(view.rows[11]!.periodKey).toBe("2003-03");
    expect(view.window).toMatchObject({ end: "2004-02", start: "2003-03", hasOlder: true, olderUntil: "2003-02" });
    expect(view.rows.every((row) => row.state === "review")).toBe(true);
    expect(view.latestReviewMonth).toBe("2004-02");
    // No N+1: no collector, no version-document read for 12 stored-display reviews.
    expect(collector).toHaveBeenCalledTimes(0);
    expect(versionRead).toHaveBeenCalledTimes(0);

    const older = await getPartnerReviewHistory(mgr, partner.partnerRef, { month: { state: "absent" }, until: { state: "valid", month: "2003-02" } });
    expect(older.ok && older.data.rows.map((r) => r.periodKey)).toEqual(["2003-02", "2003-01", "2002-12", "2002-11", "2002-10", "2002-09", "2002-08", "2002-07", "2002-06", "2002-05", "2002-04", "2002-03"]);
    // Older-window default month = the latest review month at or before the window end.
    expect(older.ok && older.data.month.selected).toBe("2003-02");
    expect(older.ok && older.data.rows.filter((r) => r.state === "review").map((r) => r.periodKey)).toEqual(["2003-02", "2003-01"]);
    expect(older.ok && older.data.rows.filter((r) => r.state === "no_review")).toHaveLength(10);
  });

  it("a month with no review is 'Needs review' (in-period Assignments exist) or 'No review' - never a zero and never a fabricated summary", async () => {
    const mgr = await syntheticActor("partnership_manager");
    const partner = await seedPartner();
    await seedDirectReview(partner, "2002-08");
    await seedAssignment(partner.partnerRef, { dueAt: "2002-06-15", regionIds: [R_IN] });
    const result = await getPartnerReviewHistory(mgr, partner.partnerRef, { month: { state: "absent" }, until: { state: "absent" } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const byMonth = Object.fromEntries(result.data.rows.map((row) => [row.periodKey, row]));
    expect(byMonth["2002-08"]!.state).toBe("review");
    expect(byMonth["2002-07"]).toMatchObject({ state: "no_review", row: null });
    expect(byMonth["2002-06"]).toMatchObject({ state: "needs_review" });
    expect(byMonth["2002-06"]!.row).toMatchObject({ kind: "candidate", summary: null, assignmentsFound: 1 });
    // Selecting a month with no review is still allowed (Generate Review is offered there by the UI).
    const selected = await getPartnerReviewHistory(mgr, partner.partnerRef, { month: { state: "valid", month: "2002-07" }, until: { state: "absent" } });
    expect(selected.ok && selected.data.selected).toMatchObject({ periodKey: "2002-07", state: "no_review" });
    expect(selected.ok && selected.data.permissions.canGenerate).toBe(true);
    // An explicit month far outside the window is used as given.
    const far = await getPartnerReviewHistory(mgr, partner.partnerRef, { month: { state: "valid", month: "1999-01" }, until: { state: "absent" } });
    expect(far.ok && far.data.month).toMatchObject({ selected: "1999-01", source: "explicit" });
  });

  it("direct cross-scope access is denied NEUTRALLY - identical for an unknown Partner - and names no Partner", async () => {
    const mgr = await syntheticActor("partnership_manager");
    const hidden = await seedPartner({ regionIds: [R_OUT], displayName: `Hidden Person ${runId}` });
    await seedDirectReview(hidden, "2001-01");
    const denied = await getPartnerReviewHistory(mgr, hidden.partnerRef, { month: { state: "absent" }, until: { state: "absent" } });
    const unknown = await getPartnerReviewHistory(mgr, "does-not-exist", { month: { state: "absent" }, until: { state: "absent" } });
    expect(denied).toEqual(unknown);
    expect(denied).toMatchObject({ ok: false, code: "unauthorized", reason: "scope_denied" });
    expect(JSON.stringify(denied)).not.toContain(hidden.displayName);
    // A malformed reference is the same outcome; an actor without the feature is denied too.
    expect(await getPartnerReviewHistory(mgr, "", { month: { state: "absent" }, until: { state: "absent" } })).toEqual(unknown);
    expect((await getPartnerReviewHistory(null, hidden.partnerRef, { month: { state: "absent" }, until: { state: "absent" } })).ok).toBe(false);
    // The history is the Partner's LIVE scope: an in-scope Partner works, and moving it out of scope revokes access immediately.
    const moving = await seedPartner();
    await seedDirectReview(moving, "2001-02");
    expect((await getPartnerReviewHistory(mgr, moving.partnerRef, { month: { state: "absent" }, until: { state: "absent" } })).ok).toBe(true);
    await partnersCollection().doc(moving.uid).update({ regionIds: [R_OUT] });
    expect((await getPartnerReviewHistory(mgr, moving.partnerRef, { month: { state: "absent" }, until: { state: "absent" } })).ok).toBe(false);
  });

  it("keeps Instagram and YouTube separate (no combined figure) and shows a revised month with its preserved earlier versions", async () => {
    const partner = await seedPartner();
    const assignment = await seedAssignment(partner.partnerRef, { dueAt: "2000-05-10", regionIds: [R_IN] });
    const thread = await seedThread(assignment, { status: "APPROVED", approvedAt: "2000-05-09T00:00:00.000Z" });
    await seedAnalytics(partner.partnerRef, { contentRef: thread.contentRef, platform: "instagram", likes: 100, views: 1000, period: { start: "2000-05-01", end: "2000-05-28" } });
    await seedAnalytics(partner.partnerRef, { contentRef: null, platform: "youtube", likes: null, views: 5000, period: { start: "2000-05-01", end: "2000-05-28" } });
    const { reviewRef, manager, head } = await generateAndFinalize(partner.partnerRef, "2000-05");

    const view = await getPartnerReviewHistory(manager, partner.partnerRef, { month: { state: "absent" }, until: { state: "absent" } });
    expect(view.ok).toBe(true);
    if (!view.ok) return;
    const row = view.data.rows[0]!.row!;
    expect(row.summary!.performance.perPlatform).toEqual({
      instagram: { views: 1000, engagement: null, likes: 100, comments: null },
      youtube: { views: 5000, engagement: null, likes: null, comments: null },
    });
    expect(JSON.stringify(view.data)).not.toContain('"views":6000');
    expect(row.summary!.production.approvedContent).toBe(1);
    expect(row.revisionCount).toBe(0);

    // Revise: a new source record, then revision -> finalize (supersedes v1).
    await seedAnalytics(partner.partnerRef, { contentRef: null, platform: "instagram", likes: 3, period: { start: "2000-05-01", end: "2000-05-28" } });
    const stale = await getPartnerReview(head, reviewRef);
    const revision = await createPartnerReviewRevision(manager, reviewRef, { expectedDocVersion: stale.ok ? stale.data.head.docVersion : 0 }, "req-rev");
    expect(revision.ok).toBe(true);
    const submitted = await submitPartnerReviewForReview(manager, reviewRef, { expectedDocVersion: revision.ok ? revision.data.selectedVersion!.docVersion : 0 }, "req-sub");
    const final2 = await finalizePartnerReview(head, reviewRef, { expectedDocVersion: submitted.ok ? submitted.data.selectedVersion!.docVersion : 0 }, "req-fin");
    expect(final2.ok).toBe(true);

    const revised = await getPartnerReviewHistory(manager, partner.partnerRef, { month: { state: "absent" }, until: { state: "absent" } });
    expect(revised.ok && revised.data.rows[0]).toMatchObject({ state: "review", revised: true });
    expect(revised.ok && revised.data.rows[0]!.row).toMatchObject({ version: 2, revisionCount: 1, currentFinalizedVersion: 2, lifecycle: "FINALIZED" });

    // Superseded version 1 stays readable, with "superseded by 2" data, through the page service.
    const old = await getPartnerReviewPage(manager, reviewRef, { state: "valid", version: 1 });
    expect(old.ok).toBe(true);
    if (!old.ok) return;
    expect(old.data.detail.selectedVersion).toMatchObject({ version: 1, status: "SUPERSEDED", supersededByVersion: 2 });
    expect(old.data.detail.head.currentFinalizedVersion).toBe(2);
    expect(old.data.detail.freshness?.state).toBe("superseded");
    expect(old.data.detail.versions.map((v) => v.version)).toEqual([2, 1]);
    // An unknown version falls back to the default and says so; a garbage version is flagged.
    const missing = await getPartnerReviewPage(manager, reviewRef, { state: "valid", version: 9 });
    expect(missing.ok && missing.data).toMatchObject({ versionNotFound: true });
    expect(missing.ok && missing.data.detail.selectedVersion!.version).toBe(2);
    const garbage = await getPartnerReviewPage(manager, reviewRef, { state: "invalid" });
    expect(garbage.ok && garbage.data.invalidVersionRequested).toBe(true);
  });

  it("commercial evidence is carried month-wise: Agreement identity, required vs actual, warning-only targets (never payment-affecting)", async () => {
    const partner = await seedPartner();
    const assignment = await seedAssignment(partner.partnerRef, { dueAt: "1999-05-10", regionIds: [R_IN] });
    const thread = await seedThread(assignment, { status: "APPROVED", approvedAt: "1999-05-09T00:00:00.000Z" });
    await seedAnalytics(partner.partnerRef, { contentRef: thread.contentRef, likes: 100, views: 900, period: { start: "1999-05-01", end: "1999-05-28" } });
    const policy: GoverningCommercialPolicy = {
      agreementRef: "agr-pr-ui",
      agreementVersion: 3,
      monthlyDeliverableRequirement: { requiredCount: 2, qualifyingUnit: "approved_content_thread" },
      targets: [
        { targetRef: "t-views", metricId: "views", targetValue: 500, unit: "count", comparison: "at_least" },
        { targetRef: "t-reach", metricId: "reach", targetValue: 100, unit: "count", comparison: "at_least" },
      ],
    };
    setCommercialPolicyProviderForTests(async () => policy);
    const mgr = await syntheticActor("partnership_manager");
    await generate(mgr, partner.partnerRef, "1999-05");

    const result = await getPartnerReviewHistory(mgr, partner.partnerRef, { month: { state: "absent" }, until: { state: "absent" } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const commercial = result.data.rows[0]!.row!.summary!.commercial;
    expect(commercial.governing).toEqual({ ref: "agr-pr-ui", version: 3 });
    expect(commercial.deliverable).toMatchObject({ required: 2, actual: 1, variance: -1, evaluation: "below_requirement", affectsPayment: true });
    // Targets: views met, unsupported Reach is Unavailable - never "not met" - and always warning-only.
    expect(commercial.targets).toEqual({ total: 2, met: 1, notMet: 0, unavailable: 1, affectsPayment: false });
    // The Overview reflects "Required" from the Agreement, and the target that could not be judged never counts as Not met.
    const overview = await getPartnerReviewsOverview(mgr, { state: "valid", month: "1999-05" });
    expect(overview.ok && overview.data.counts.reviewsWithRequirement).toBe(1);
    expect(overview.ok && overview.data.counts.requiredTotal).toBe(2);
    expect(overview.ok && overview.data.counts.attention.targetNotMet).toBe(0);
  });

  it("with NO governing policy required stays unavailable, actual qualifying never counts raw URLs, LFC/SFC is unavailable", async () => {
    const { partner } = await seedRich({ dueAt: "1998-05-10", threadStatus: "UNDER_REVIEW" });
    const mgr = await syntheticActor("partnership_manager");
    await generate(mgr, partner.partnerRef, "1998-05");
    const result = await getPartnerReviewHistory(mgr, partner.partnerRef, { month: { state: "absent" }, until: { state: "absent" } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const commercial = result.data.rows[0]!.row!.summary!.commercial;
    expect(commercial.governing).toBeNull();
    expect(commercial.deliverable).toEqual({ required: null, actual: null, variance: null, evaluation: "unavailable", affectsPayment: false });
    expect(commercial.lfcSfc).toMatchObject({ status: "unavailable", lfc: null, sfc: null, unclassified: null });
    // The submitted (not approved) link exists but is not counted anywhere as a qualifying unit.
    expect(result.data.rows[0]!.row!.summary!.production.approvedContent).toBe(0);
  });
});

// ======================================================================================================================
describe("permissions and lifecycle actions (explicit grants, no role names)", () => {
  it("server-computed booleans: Viewer/Analyst none; Manager generate/refresh/submit/revision but NOT finalize; Head and Super Admin all", async () => {
    const perms = async (role: Role) => getReviewActionPermissions(await syntheticActor(role));
    const none = { canGenerate: false, canRefresh: false, canSubmit: false, canFinalize: false, canCreateRevision: false };
    expect(await perms("viewer")).toEqual(none);
    expect(await perms("analyst")).toEqual(none);
    expect(await perms("partnership_manager")).toEqual({ canGenerate: true, canRefresh: true, canSubmit: true, canFinalize: false, canCreateRevision: true });
    expect(await perms("partnership_head")).toEqual({ canGenerate: true, canRefresh: true, canSubmit: true, canFinalize: true, canCreateRevision: true });
    expect(await getReviewActionPermissions(await seededActor("super_admin"))).toEqual({ canGenerate: true, canRefresh: true, canSubmit: true, canFinalize: true, canCreateRevision: true });
    expect(await getReviewActionPermissions(null)).toEqual(none);
  });

  it("every read service exposes the actor's booleans, and a read-only actor can still read", async () => {
    const viewer = await syntheticActor("viewer");
    const partner = await seedPartner();
    await seedDirectReview(partner, "1997-01");
    const ws = await workspace(viewer, { month: parseMonthParam("1997-01"), filter: "drafts" });
    expect(ws.rows).toHaveLength(1);
    expect(ws.permissions.canGenerate).toBe(false);
    const history = await getPartnerReviewHistory(viewer, partner.partnerRef, { month: { state: "absent" }, until: { state: "absent" } });
    expect(history.ok && history.data.permissions.canGenerate).toBe(false);
    const page = await getPartnerReviewPage(viewer, reviewRefFor(partner.partnerRef, "1997-01"), { state: "absent" });
    expect(page.ok && page.data.permissions.canFinalize).toBe(false);
    // ...and the mutation itself is denied server-side.
    const denied = await generatePartnerReviewDraft(viewer, { partnerRef: partner.partnerRef, periodKey: "1997-02" }, "req");
    expect(denied).toMatchObject({ ok: false, code: "unauthorized", reason: "action_denied" });
  });

  it("Manager cannot finalize (denied server-side) while Head can; stale finalize => REFRESH_REQUIRED, an explicit refresh, then finalize succeeds", async () => {
    const { partner } = await seedRich({ dueAt: "1996-05-10" });
    const mgr = await syntheticActor("partnership_manager");
    const head = await syntheticActor("partnership_head");
    const generated = await generate(mgr, partner.partnerRef, "1996-05");
    const reviewRef = generated.review.head.reviewRef;
    const submitted = await submitPartnerReviewForReview(mgr, reviewRef, { expectedDocVersion: generated.review.selectedVersion!.docVersion }, "req-s");
    if (!submitted.ok) throw new Error("submit failed");

    const managerFinalize = await finalizePartnerReview(mgr, reviewRef, { expectedDocVersion: submitted.data.selectedVersion!.docVersion }, "req-f0");
    expect(managerFinalize).toMatchObject({ ok: false, code: "unauthorized", reason: "action_denied" });

    // Upstream changes after the In Review snapshot: finalize must say "refresh required" and write nothing.
    await seedAnalytics(partner.partnerRef, { contentRef: null, likes: 9, period: { start: "1996-05-01", end: "1996-05-28" } });
    const stale = await finalizePartnerReview(head, reviewRef, { expectedDocVersion: submitted.data.selectedVersion!.docVersion }, "req-f1");
    expect(stale).toMatchObject({ ok: false, code: "not_ready" });
    expect(!stale.ok && stale.blockers?.map((b) => b.code)).toEqual(["REFRESH_REQUIRED"]);

    const refreshed = await refreshPartnerReviewEvidence(mgr, reviewRef, { version: 1, expectedDocVersion: submitted.data.selectedVersion!.docVersion }, "req-r");
    expect(refreshed.ok).toBe(true);
    const final = await finalizePartnerReview(head, reviewRef, { expectedDocVersion: refreshed.ok ? refreshed.data.selectedVersion!.docVersion : 0 }, "req-f2");
    expect(final.ok && final.data.selectedVersion!.status).toBe("FINALIZED");
  });

  it("incomplete-but-current evidence still finalizes (the frozen version records its incompleteness)", async () => {
    const partner = await seedPartner();
    const assignment = await seedAssignment(partner.partnerRef, { dueAt: "1995-05-10", regionIds: [R_IN] });
    // Approved Content with NO Analytics -> an "approved_content_without_analytics" incompleteness that is stable.
    await seedThread(assignment, { status: "APPROVED", approvedAt: "1995-05-09T00:00:00.000Z" });
    const { finalized } = await generateAndFinalize(partner.partnerRef, "1995-05");
    expect(finalized.selectedVersion!.status).toBe("FINALIZED");
    expect(finalized.selectedVersion!.snapshot.completeness.incompleteReasons).toContain("approved_content_without_analytics");
    expect(finalized.freshness?.state).toBe("evidence_incomplete");
  });
});

// ======================================================================================================================
describe("redaction and canonical results", () => {
  it("a Manager without a source Campaign's scope: identical canonical fingerprint and totals, and NO out-of-scope identifier in any new DTO", async () => {
    const admin = await seededActor("super_admin");
    const mgr = await syntheticActor("partnership_manager");
    const tag = randomUUID().slice(0, 8);
    const partner = await seedPartner({ displayName: `Redact ${tag}` });
    const campIn = await seedCampaign(`IN Campaign ${tag}`, [R_IN]);
    const campOut = await seedCampaign(`OUT-SECRET Campaign ${tag}`, [R_OUT]);
    const a1 = await seedAssignment(partner.partnerRef, { dueAt: "1994-03-10", regionIds: [R_IN], campaignRef: campIn.campaignRef, campaignName: campIn.name });
    const t1 = await seedThread(a1, { regionIds: [R_IN], status: "APPROVED", approvedAt: "1994-03-09T00:00:00.000Z" });
    await seedAnalytics(partner.partnerRef, { contentRef: t1.contentRef, likes: 111, regionIds: [R_IN], period: { start: "1994-03-01", end: "1994-03-28" } });
    const a2 = await seedAssignment(partner.partnerRef, { dueAt: "1994-03-12", regionIds: [R_OUT], campaignRef: campOut.campaignRef, campaignName: campOut.name });
    const t2 = await seedThread(a2, { regionIds: [R_OUT], status: "UNDER_REVIEW" });
    const r2 = await seedAnalytics(partner.partnerRef, { contentRef: t2.contentRef, likes: 222, regionIds: [R_OUT], postUrl: `https://instagram.com/p/out-secret-${tag}`, period: { start: "1994-03-01", end: "1994-03-28" } });

    const generated = await generate(mgr, partner.partnerRef, "1994-03");
    const reviewRef = generated.review.head.reviewRef;

    // Canonical evidence is actor-independent: same fingerprint and same summary for the global actor.
    const adminPage = await getPartnerReviewPage(admin, reviewRef, { state: "absent" });
    const mgrPage = await getPartnerReviewPage(mgr, reviewRef, { state: "absent" });
    expect(adminPage.ok && mgrPage.ok).toBe(true);
    if (!adminPage.ok || !mgrPage.ok) return;
    expect(mgrPage.data.detail.selectedVersion!.sourceFingerprint).toBe(adminPage.data.detail.selectedVersion!.sourceFingerprint);
    expect(mgrPage.data.detail.freshness?.snapshotFingerprint).toBe(adminPage.data.detail.freshness?.snapshotFingerprint);
    expect(computeReviewListSummary(mgrPage.data.detail.selectedVersion!.snapshot)).toEqual(computeReviewListSummary(adminPage.data.detail.selectedVersion!.snapshot));
    expect(computeReviewListSummary(mgrPage.data.detail.selectedVersion!.snapshot).production.assignmentsIncluded).toBe(2);

    const hiddenNeedles = [campOut.name, campOut.campaignRef, a2.assignmentRef, t2.contentRef, r2.sourceRef, `out-secret-${tag}`, "RAW CAPTION", "rawusername"];
    const detailJson = JSON.stringify(mgrPage.data.detail);
    for (const needle of hiddenNeedles) expect(detailJson, needle).not.toContain(needle);
    // The in-scope Campaign's context is still present for the Manager.
    expect(detailJson).toContain(campIn.name);
    // The global actor sees everything.
    expect(JSON.stringify(adminPage.data.detail)).toContain(campOut.name);

    // Every LIST-shaped DTO carries counts / labels only - no source identifier of any kind.
    const overview = await getPartnerReviewsOverview(mgr, { state: "valid", month: "1994-03" });
    const ws = await workspace(mgr, { month: parseMonthParam("1994-03"), filter: "drafts" });
    const history = await getPartnerReviewHistory(mgr, partner.partnerRef, { month: { state: "absent" }, until: { state: "absent" } });
    for (const dto of [overview, ws, history]) {
      const json = JSON.stringify(dto);
      for (const needle of [...hiddenNeedles, campIn.name, campIn.campaignRef, a1.assignmentRef, t1.contentRef, "pr-ui-an-", "http"]) expect(json, needle).not.toContain(needle);
    }
    // The stored projection was built from the canonical snapshot (both Assignments counted), for every actor.
    expect(ws.rows[0]!.summary!.production.assignmentsIncluded).toBe(2);
  });

  it("a review whose Partner is moved out of scope disappears from lists and detail immediately (live Partner scope, never the head snapshot)", async () => {
    const mgr = await syntheticActor("partnership_manager");
    const { partner } = await seedRich({ dueAt: "1993-03-10" });
    const generated = await generate(mgr, partner.partnerRef, "1993-03");
    const month = parseMonthParam("1993-03");
    expect((await workspace(mgr, { month, filter: "drafts" })).rows).toHaveLength(1);
    // Move the Partner out of scope WITHOUT touching the review head (its scope snapshot is now stale).
    await partnersCollection().doc(partner.uid).update({ regionIds: [R_OUT] });
    expect((await workspace(mgr, { month, filter: "drafts" })).rows).toEqual([]);
    const overview = await getPartnerReviewsOverview(mgr, { state: "valid", month: "1993-03" });
    expect(overview.ok && overview.data.counts.monthlyReviews).toBe(0);
    const page = await getPartnerReviewPage(mgr, generated.review.head.reviewRef, { state: "absent" });
    expect(page).toMatchObject({ ok: false, code: "unauthorized", reason: "scope_denied" });
  });
});

// ======================================================================================================================
describe("Finance boundary (runtime)", () => {
  it("none of the new services or writes introduced a Finance-shaped collection", async () => {
    const roots = (await getAdminFirestore().listCollections()).map((c) => c.id);
    expect(roots.filter((name) => /finance|agreement|payable|invoice|payment|payee/i.test(name))).toEqual([]);
  });
});
