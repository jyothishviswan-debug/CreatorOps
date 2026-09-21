// Partner Reviews CLOSURE CERTIFICATION (R1..R9 evidence audit) - the focused tests that fill the gaps the
// existing 13A / 13A.1 / 13B suites do not prove. Real Firestore/Auth emulator, no mocks of business logic
// (only the session lookup is replaced for the API-route cases, exactly like the handoff route test in
// partner-reviews.emulator.test.ts). Run with `pnpm test:emulator` against a running `pnpm firebase:emulators`.
//
// Hermetic by construction:
//   * every Partner / Assignment / Content / Analytics / Campaign fixture is schema-valid, written through the
//     Admin SDK with PAST dates under unique months (1999-2009, never the months other files use), and removed
//     afterwards (review heads with their versions/events subcollections included);
//   * evidence lives in a PRIVATE region only GLOBAL holds (or in a per-test private region that only a
//     SYNTHETIC actor - the seeded role's real grants + a private-region scope grant - can reach), so nothing
//     here can leak into another file's scoped reads;
//   * no whole-collection size is asserted anywhere;
//   * the five-role matrix runs through the REAL services with the SEEDED emulator users (EMULATOR_TEST_USERS).
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { DocumentReference, Firestore, Query, Transaction, WriteBatch } from "firebase-admin/firestore";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { analyticsContentSourceRecordsCollection } from "@/server/analytics/firestore";
import { analyticsContentSourceRecordDocSchema } from "@/server/analytics/types";
import { assignmentsCollection } from "@/server/assignments/firestore";
import { assignmentBriefSchema, assignmentDocSchema } from "@/server/assignments/types";
import { seedEmulatorTestUsers } from "@/server/auth/seed-users";
import { resolveActor } from "@/server/authz/actor";
import { canPerformAction } from "@/server/authz/capabilities";
import { COLLECTIONS } from "@/server/authz/firestore";
import { MODULE_ACTIONS } from "@/server/authz/module-actions";
import { getActorScopeGrants, hasGlobalScope, scopeGrantDocId } from "@/server/authz/scope";
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
import { buildOverviewModel } from "@/features/partner-reviews/overview-model";

import { buildEvidence } from "./evidence-builder";
import * as evidenceCollector from "./evidence-collector";
import { getFinalizedReviewHandoff, getReviewVersionCurrency } from "./finalized-review-handoff-service";
import { PARTNER_REVIEWS_COLLECTIONS, partnerReviewsCollection, partnerReviewVersionsCollection } from "./firestore";
import { createPartnerReviewRevision, finalizePartnerReview, submitPartnerReviewForReview } from "./partner-review-lifecycle-service";
import { getPartnerReviewHistory } from "./partner-review-history-service";
import { getPartnerReviewsOverview } from "./partner-review-overview-service";
import { getPartnerReviewPage } from "./partner-review-page-service";
import { getReviewActionPermissions } from "./partner-review-permissions";
import { generatePartnerReviewDraft, getPartnerReview, getPartnerReviewVersion, inspectPartnerReviewFreshness, listPartnerReviewHeads, refreshPartnerReviewEvidence } from "./partner-review-service";
import { getPartnerReviewsWorkspace, type WorkspaceQuery } from "./partner-review-workspace-service";
import { derivePeriod, reviewRefFor } from "./period";
import { buildHeadDisplay, computeReviewListSummary } from "./review-list-summary";
import { partnerReviewHeadDocSchema, partnerReviewVersionDocSchema } from "./types";
import { parseMonthParam } from "./ui-params";

vi.setConfig({ testTimeout: 60_000 });

const runId = Date.now();
// A region no seeded actor holds except GLOBAL (Super Admin).
const PRIVATE_REGION = `pr-cl-private-${runId}`;

type Role = ActorContext["role"];
const uidByRole = new Map<string, string>();
const cleanup: FirebaseFirestore.DocumentReference[] = [];
const reviewRefsToClean = new Set<string>();
const grantDocIds: string[] = [];
let counter = 0;
let regionCounter = 0;

// The API-route cases replace ONLY the session lookup (the real routes, services, authz chain and Firestore are used).
let httpActor: ActorContext | null = null;
vi.mock("@/server/administration/http", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/administration/http")>();
  return { ...original, resolveRequestActor: async () => httpActor };
});

beforeAll(async () => {
  const password = process.env.EMULATOR_TEST_USER_PASSWORD;
  if (!password) throw new Error("EMULATOR_TEST_USER_PASSWORD is not set - check .env.local. Requires a running Firebase emulator.");
  await seedEmulatorTestUsers(password);
  await seedAccessControlData();
  await seedPartnersData();
  const auth = getAdminAuth();
  for (const identity of TEST_IDENTITIES) uidByRole.set(identity.role, (await auth.getUserByEmail(identity.email)).uid);
}, 60_000);

afterEach(() => {
  vi.restoreAllMocks();
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
  const db = getAdminFirestore();
  await Promise.all(grantDocIds.splice(0).map((id) => db.collection(COLLECTIONS.scopeAssignments).doc(id).delete()));
});

// ---- Actors ---------------------------------------------------------------------------------------------------------------

// The SEEDED emulator identity for a canonical role (EMULATOR_TEST_USERS) resolved exactly like production does.
async function seededActor(role: Role): Promise<ActorContext> {
  const uid = uidByRole.get(role);
  if (!uid) throw new Error(`No seeded uid for role ${role}`);
  const actor = await resolveActor(uid);
  if (!actor) throw new Error(`resolveActor returned null for seeded role ${role}`);
  return actor;
}

function newRegion(label: string): string {
  regionCounter += 1;
  return `pr-cl-${label}-${runId}-${regionCounter}`;
}

// A SYNTHETIC actor: the given role's real grants (accessGrants/{role}) with a scope made of exactly the REGION
// grants named here (no SELF, no GLOBAL) - so its lists / Overview / months can only ever see this test's fixtures.
async function syntheticActor(role: Role, regions: string[]): Promise<ActorContext> {
  const uid = `pr-cl-${role}-${runId}-${randomUUID().slice(0, 6)}`;
  const grantedAt = new Date().toISOString();
  for (const region of regions) {
    const input = { type: "REGION" as const, region };
    const grant = { ...input, uid, grantedAt, grantedBy: "pr-cl-test" } as ScopeGrant;
    const id = scopeGrantDocId(uid, input);
    await getAdminFirestore().collection(COLLECTIONS.scopeAssignments).doc(id).set(grant);
    grantDocIds.push(id);
  }
  return { uid, email: `${uid}@example.test`, role, displayName: `PR CL ${role}`, userRef: `pr-cl-ref-${uid}` };
}

// ---- Fixtures (schema-valid, PAST dates) -----------------------------------------------------------------------------------
async function seedPartner(over: { regionIds?: string[]; ownerUid?: string | null; teamIds?: string[]; displayName?: string } = {}): Promise<PartnerDoc> {
  counter += 1;
  const uid = `pr-cl-partner-${runId}-${counter}-${randomUUID().slice(0, 6)}`;
  const now = new Date().toISOString();
  const displayName = over.displayName ?? `PRCL Partner ${String(counter).padStart(3, "0")} ${runId}`;
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
    regionIds: over.regionIds ?? ["Kerala"],
    languageIds: [],
    categoryIds: [],
    tier: null,
    priority: null,
    targetAudience: [],
    email: `${uid}@example-partner.test`,
    phone: "+91 90000 00077",
    ownerUid: over.ownerUid ?? null,
    teamIds: over.teamIds ?? [],
    originLeadRefs: [],
    sourceDiscovery: null,
    pendingPartnerAccountSetup: false,
    sequenceNumber: null,
    createdAt: now,
    createdByUserRef: "pr-cl-test",
    updatedAt: now,
    updatedByUserRef: "pr-cl-test",
  });
  const ref = partnersCollection().doc(uid);
  await ref.set(partner);
  cleanup.push(ref);
  return partner;
}

async function seedCampaign(over: { name: string; regionIds: string[]; ownerUid?: string | null; teamIds?: string[] }) {
  const uid = campaignsCollection().doc().id;
  const now = new Date().toISOString();
  const campaign = campaignDocSchema.parse({
    uid,
    campaignRef: `pr-cl-camp-${uid}`,
    version: 1,
    name: over.name,
    nameLower: over.name.toLowerCase(),
    objective: "Closure certification scope fixture",
    status: "ACTIVE",
    statusReason: null,
    platforms: [],
    startDate: "2001-01-01",
    endDate: "2009-12-31",
    regionIds: over.regionIds,
    ownerUid: over.ownerUid ?? null,
    teamIds: over.teamIds ?? [],
    criteria: { targetAudience: [], regionIds: [], languageIds: [], categoryIds: [], platforms: [] },
    resources: [],
    defaultReviewPolicy: "REVIEW_REQUIRED",
    createdAt: now,
    createdByUserRef: "pr-cl-test",
    updatedAt: now,
    updatedByUserRef: "pr-cl-test",
  });
  const ref = campaignsCollection().doc(uid);
  await ref.set(campaign);
  cleanup.push(ref);
  return campaign;
}

async function seedAssignment(
  partnerRef: string,
  over: { dueAt?: string | null; createdAt?: string; status?: string; regionIds?: string[]; campaignRef?: string; campaignName?: string; ownerUid?: string | null; teamIds?: string[] } = {},
) {
  const uid = assignmentsCollection().doc().id;
  const now = new Date().toISOString();
  const assignment = assignmentDocSchema.parse({
    uid,
    assignmentRef: `pr-cl-as-${uid}`,
    version: 1,
    campaignRef: over.campaignRef ?? `pr-cl-camp-${runId}`,
    partnerRef,
    partnerAccountRefs: [],
    status: over.status ?? "IN_PROGRESS",
    statusReason: over.status === "CANCELLED" ? "test" : null,
    brief: assignmentBriefSchema.parse({
      dueAt: over.dueAt === undefined ? "2003-03-10" : over.dueAt,
      requiredCount: 2,
      formats: ["reel"],
      platforms: ["instagram"],
      reviewPolicy: "REVIEW_REQUIRED",
      campaignName: over.campaignName ?? "PRCL Campaign",
    }),
    ownerUid: over.ownerUid ?? null,
    regionIds: over.regionIds ?? [PRIVATE_REGION],
    teamIds: over.teamIds ?? [],
    createdAt: over.createdAt ?? "2002-01-05T08:00:00.000Z",
    createdByUserRef: "pr-cl-test",
    updatedAt: now,
    updatedByUserRef: "pr-cl-test",
  });
  const ref = assignmentsCollection().doc(uid);
  await ref.set(assignment);
  cleanup.push(ref);
  return assignment;
}

async function seedThread(
  assignment: { assignmentRef: string; campaignRef: string; partnerRef: string },
  over: { status?: string; links?: number; regionIds?: string[]; approvedAt?: string | null; ownerUid?: string | null; teamIds?: string[]; urlTag?: string } = {},
) {
  const uid = contentCollection().doc().id;
  const links = over.links ?? 1;
  const tag = over.urlTag ?? uid;
  const thread = contentDocSchema.parse({
    uid,
    contentRef: `pr-cl-ct-${uid}`,
    version: 3,
    assignmentRef: assignment.assignmentRef,
    campaignRef: assignment.campaignRef,
    partnerRef: assignment.partnerRef,
    status: over.status ?? "UNDER_REVIEW",
    statusReason: null,
    currentRevisionNumber: 1,
    reviewedRevisionNumber: 1,
    currentLinks: Array.from({ length: links }, (_, i) => ({ platform: "instagram", originalUrl: `https://instagram.com/p/PRCL${tag}${i}`, normalizedUrl: `https://instagram.com/p/prcl${tag.toLowerCase()}${i}`, recordedAt: "2003-03-08T10:00:00.000Z" })),
    qualifyingFulfillment: null,
    dueAt: null,
    openedAt: "2003-03-01T00:00:00.000Z",
    firstSubmittedAt: "2003-03-08T10:00:00.000Z",
    lastSubmittedAt: "2003-03-08T10:00:00.000Z",
    approvedAt: over.approvedAt ?? null,
    cancelledAt: null,
    ownerUid: over.ownerUid ?? null,
    regionIds: over.regionIds ?? [PRIVATE_REGION],
    teamIds: over.teamIds ?? [],
    createdAt: "2003-03-01T00:00:00.000Z",
    createdByUserRef: "pr-cl-test",
    updatedAt: "2003-03-08T10:00:00.000Z",
    updatedByUserRef: "pr-cl-test",
  });
  const ref = contentCollection().doc(uid);
  await ref.set(thread);
  cleanup.push(ref);
  return thread;
}

async function seedAnalytics(
  partnerRef: string,
  over: {
    contentRef?: string | null;
    likes?: number | null;
    views?: number | null;
    period?: { start: string; end: string };
    regionIds?: string[];
    ownerUid?: string | null;
    teamIds?: string[];
    postUrl?: string;
    matchedAssignmentRef?: string | null;
    matchedCampaignRef?: string | null;
  } = {},
) {
  const uid = `pr-cl-an-${randomUUID()}`;
  const record = analyticsContentSourceRecordDocSchema.parse({
    uid,
    sourceRef: uid,
    batchRef: `pr-cl-batch-${runId}`,
    sheetName: "Posts",
    sourceRowNumber: 2,
    platform: "instagram",
    rowIdentityKey: `pr-cl:${uid}`,
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
    normalizedUrl: over.postUrl ?? "https://instagram.com/p/pr-cl-analytics",
    postDateTimeIso: "2003-03-09T10:00:00.000Z",
    comments: null,
    likes: over.likes === undefined ? 120 : over.likes,
    views: over.views === undefined ? null : over.views,
    profileFollowers: null,
    engagement: null,
    reportingPeriod: over.period ?? { start: "2003-03-01", end: "2003-03-28" },
    matchState: "MATCHED",
    matchEvidence: { tier: "published_url", value: over.postUrl ?? "https://instagram.com/p/pr-cl-analytics", reasonCode: null, candidateCount: 1 },
    matchedContentRef: over.contentRef ?? null,
    matchedAssignmentRef: over.matchedAssignmentRef ?? null,
    matchedCampaignRef: over.matchedCampaignRef ?? null,
    matchedPartnerRef: partnerRef,
    matchedPartnerAccountRef: null,
    ownerUid: over.ownerUid ?? null,
    regionIds: over.regionIds ?? [PRIVATE_REGION],
    teamIds: over.teamIds ?? [],
    createdAt: "2003-04-02T00:00:00.000Z",
  });
  const ref = analyticsContentSourceRecordsCollection().doc(uid);
  await ref.set(record);
  cleanup.push(ref);
  return record;
}

// A review head + version written DIRECTLY (schema-valid, with its display projection): a cheap way to build a long
// month history without one evidence collection per month.
async function seedDirectReview(partner: PartnerDoc, periodKey: string, status: "DRAFT" | "IN_REVIEW" | "FINALIZED" = "DRAFT") {
  const period = derivePeriod(periodKey)!;
  const built = buildEvidence({ partnerRef: partner.partnerRef, period, evidenceCutoff: "2010-01-01T00:00:00.000Z", assignments: [], assignmentScanTruncated: false, assignmentsScanned: 0, threads: [], analyticsRecords: [], analyticsScanTruncated: false, analyticsRecordsScanned: 0 });
  const reviewRef = reviewRefFor(partner.partnerRef, periodKey);
  const stamp = "2010-01-02T00:00:00.000Z";
  const version = partnerReviewVersionDocSchema.parse({
    reviewRef,
    version: 1,
    status,
    docVersion: 1,
    snapshot: built.snapshot,
    evidenceCutoff: built.snapshot.evidenceCutoff,
    sourceFingerprint: built.sourceFingerprint,
    sourceRefs: built.sourceRefs,
    generatedAt: stamp,
    generatedByUserRef: "pr-cl-test",
    finalizedAt: status === "FINALIZED" ? stamp : null,
    finalizedByUserRef: status === "FINALIZED" ? "pr-cl-test" : null,
    createdAt: stamp,
    createdByUserRef: "pr-cl-test",
    summary: computeReviewListSummary(built.snapshot),
  });
  const head = partnerReviewHeadDocSchema.parse({
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
    createdAt: stamp,
    createdByUserRef: "pr-cl-test",
    updatedAt: stamp,
    updatedByUserRef: "pr-cl-test",
    display: buildHeadDisplay({ version, latestVersion: 1, event: { kind: status === "FINALIZED" ? "finalized" : "generated", at: stamp }, finalized: status === "FINALIZED" ? { version: 1, at: stamp } : null }),
  });
  await partnerReviewsCollection().doc(reviewRef).set(head);
  await partnerReviewVersionsCollection(reviewRef).doc("1").set(version);
  reviewRefsToClean.add(reviewRef);
  return reviewRef;
}

// ---- Service helpers --------------------------------------------------------------------------------------------------------
function must<T>(result: { ok: true; data: T } | { ok: false; code: string; message: string }, what: string): T {
  if (!result.ok) throw new Error(`${what} failed: ${result.code} ${result.message}`);
  return result.data;
}

async function generate(actor: ActorContext, partnerRef: string, periodKey: string) {
  const data = must(await generatePartnerReviewDraft(actor, { partnerRef, periodKey }, `req-${randomUUID().slice(0, 8)}`), `generate ${periodKey}`);
  reviewRefsToClean.add(data.review.head.reviewRef);
  return data;
}

async function submit(actor: ActorContext, reviewRef: string, expectedDocVersion: number) {
  return must(await submitPartnerReviewForReview(actor, reviewRef, { expectedDocVersion }, "req-submit"), "submit");
}

async function finalize(actor: ActorContext, reviewRef: string, expectedDocVersion: number) {
  return must(await finalizePartnerReview(actor, reviewRef, { expectedDocVersion }, "req-finalize"), "finalize");
}

// Generate -> submit (submitter) -> finalize (finalizer). Returns the finalized detail.
async function generateAndFinalize(submitter: ActorContext, finalizer: ActorContext, partnerRef: string, periodKey: string) {
  const generated = await generate(submitter, partnerRef, periodKey);
  const reviewRef = generated.review.head.reviewRef;
  const submitted = await submit(submitter, reviewRef, generated.review.selectedVersion!.docVersion);
  const finalized = await finalize(finalizer, reviewRef, submitted.selectedVersion!.docVersion);
  return { reviewRef, finalized };
}

async function rawDoc(ref: FirebaseFirestore.DocumentReference): Promise<string> {
  const snap = await ref.get();
  return JSON.stringify(snap.data() ?? null);
}

// The head minus the best-effort `freshnessHint` (the one field a READ may add - see freshness-hint.ts).
async function rawHeadDoc(reviewRef: string): Promise<string> {
  const snap = await partnerReviewsCollection().doc(reviewRef).get();
  const { freshnessHint, ...rest } = (snap.data() ?? {}) as Record<string, unknown>;
  void freshnessHint;
  return JSON.stringify(snap.exists ? rest : null);
}

const versionRef = (reviewRef: string, version: number) => partnerReviewVersionsCollection(reviewRef).doc(String(version));

// JSON-walk: every key and every string value of a DTO (the whole tree).
function walkJson(value: unknown, visit: (key: string | null, str: string | null) => void, key: string | null = null) {
  if (typeof value === "string") visit(key, value);
  else if (Array.isArray(value)) value.forEach((child) => walkJson(child, visit, key));
  else if (value && typeof value === "object") {
    for (const [childKey, child] of Object.entries(value)) {
      visit(childKey, null);
      walkJson(child, visit, childKey);
    }
  }
}

function keysOf(value: unknown): string[] {
  const keys: string[] = [];
  walkJson(value, (key, str) => {
    if (str === null && key) keys.push(key);
  });
  return keys;
}

// Handler-level GET of the four read routes (only the session lookup above is replaced).
async function callGet(kind: "detail" | "freshness" | "version" | "handoff", reviewRef: string) {
  const { GET: detail } = await import("@/app/api/partner-reviews/[reviewRef]/route");
  const { GET: freshness } = await import("@/app/api/partner-reviews/[reviewRef]/freshness/route");
  const { GET: version } = await import("@/app/api/partner-reviews/[reviewRef]/versions/[version]/route");
  const { GET: handoff } = await import("@/app/api/partner-reviews/[reviewRef]/handoff/route");
  const request = new Request(`http://localhost/api/partner-reviews/${reviewRef}`);
  const params = Promise.resolve({ reviewRef, version: "1" });
  const response = await { detail, freshness, version, handoff }[kind](request, { params } as never);
  return { status: response.status, body: (await response.json()) as unknown };
}

// ---- Firestore instrumentation (reads by collection name / call count, writes by path and transaction) --------------------------
type WriteRecord = { op: "set" | "create" | "update" | "delete"; path: string; tx: object | null };

function instrument() {
  const writes: WriteRecord[] = [];
  const collectionsTouched = new Set<string>();
  let readCalls = 0;
  type AnyFn = (...args: unknown[]) => unknown;
  const spies: Array<{ mockRestore: () => void }> = [];
  const wrap = (proto: object, name: string, before: (self: unknown, args: unknown[]) => void) => {
    const original = (proto as unknown as Record<string, AnyFn>)[name]!;
    spies.push(
      vi.spyOn(proto as unknown as Record<string, AnyFn>, name).mockImplementation(function (this: unknown, ...args: unknown[]) {
        before(this, args);
        return original.apply(this, args);
      }),
    );
  };
  const pathOf = (ref: unknown) => (ref as { path: string }).path;

  for (const op of ["set", "create", "update", "delete"] as const) {
    wrap(Transaction.prototype, op, (self, args) => writes.push({ op, path: pathOf(args[0]), tx: self as object }));
    wrap(WriteBatch.prototype, op, (_self, args) => writes.push({ op, path: pathOf(args[0]), tx: null }));
    wrap(DocumentReference.prototype, op, (self) => writes.push({ op, path: pathOf(self), tx: null }));
  }
  wrap(Firestore.prototype, "collection", (_self, args) => collectionsTouched.add(String(args[0]).split("/")[0]!));
  wrap(Firestore.prototype, "collectionGroup", (_self, args) => collectionsTouched.add(String(args[0])));
  wrap(Firestore.prototype, "doc", (_self, args) => collectionsTouched.add(String(args[0]).split("/")[0]!));
  wrap(Query.prototype, "get", () => (readCalls += 1));
  wrap(DocumentReference.prototype, "get", () => (readCalls += 1));
  wrap(Firestore.prototype, "getAll", () => (readCalls += 1));
  wrap(Transaction.prototype, "get", () => (readCalls += 1));
  return {
    writes,
    collectionsTouched,
    reads: () => readCalls,
    // Restores ONLY this recorder's own spies (an unrelated spy set up by the test stays in place).
    stop: () => spies.splice(0).forEach((spy) => spy.mockRestore()),
  };
}

// =====================================================================================================================
// STATIC scans (R2 / R4 / R8 / R9) - pure source scans over the four Partner Reviews source trees.
// =====================================================================================================================
const repoRoot = path.resolve(import.meta.dirname, "../../..");
const isSource = (name: string) => /\.(ts|tsx)$/.test(name) && !/\.(test|spec)\.(ts|tsx)$/.test(name);

function walkFiles(dir: string, accept: (name: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walkFiles(full, accept) : accept(entry.name) ? [full] : [];
  });
}

const TREES = {
  server: walkFiles(path.join(repoRoot, "src/server/partner-reviews"), isSource),
  features: walkFiles(path.join(repoRoot, "src/features/partner-reviews"), isSource),
  pages: walkFiles(path.join(repoRoot, "src/app/partner-reviews"), isSource),
  routes: walkFiles(path.join(repoRoot, "src/app/api/partner-reviews"), isSource),
};
const ALL_MODULE_FILES = Object.values(TREES).flat();

// Executable code only: comments (block, line, JSX) are allowed to explain a boundary by name.
function codeOf(file: string): string {
  return readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
}
const rel = (file: string) => path.relative(repoRoot, file);

describe("static scans over src/server, src/features, src/app pages and src/app/api of Partner Reviews", () => {
  it("the scanner really sees all four trees (a broken walker cannot pass silently)", () => {
    expect(TREES.server.length).toBeGreaterThan(30);
    expect(TREES.features.length).toBeGreaterThan(10);
    expect(TREES.pages.length).toBeGreaterThanOrEqual(4);
    expect(TREES.routes.length).toBeGreaterThanOrEqual(10);
  });

  it("R4: no minimumRole, no role-rank/order/level fallback and no role-name comparison anywhere in the module (executable code)", () => {
    const patterns: Array<[string, RegExp]> = [
      ["minimumRole", /minimumRole/i],
      ["role rank / order / level helper", /roleRank|ROLE_RANK|rankOf|hasMinimumRole|roleAtLeast|atLeastRole|roleLevel|ROLE_LEVEL|roleOrder|ROLE_ORDER|roleWeight|ROLE_WEIGHT/],
      ["the word rank", /\brank\b/i],
      ["reading the acting role", /\b(?:actor|user|session|viewer|principal)\.role\b/],
      ["comparing a role", /\brole\s*(?:===|!==|==|!=)/],
      ["comparing to a canonical role name", /(?:===|!==|==|!=|\bcase\b)\s*["'](?:viewer|analyst|partnership_manager|partnership_head|super_admin)["']/],
      ["switching on a role", /switch\s*\(\s*[\w.]*role\s*\)/],
      ["indexing roles", /ROLES?\.(?:indexOf|findIndex|includes)\(/],
    ];
    for (const file of ALL_MODULE_FILES) {
      const source = codeOf(file);
      for (const [label, pattern] of patterns) expect({ file: rel(file), label, hit: pattern.exec(source)?.[0] ?? null }).toEqual({ file: rel(file), label, hit: null });
    }
  });

  it("R4: only the two authorization files ask the capability layer anything, and each mutation names exactly its explicit action", () => {
    const users = ALL_MODULE_FILES.filter((file) => /@\/server\/authz\/capabilities/.test(readFileSync(file, "utf8"))).map((file) => path.basename(file)).sort();
    expect(users).toEqual(["partner-review-permissions.ts", "partner-reviews-gate.ts"]);

    const read = (name: string) => codeOf(path.join(repoRoot, "src/server/partner-reviews", name));
    const lifecycle = read("partner-review-lifecycle-service.ts");
    const service = read("partner-review-service.ts");
    const bodyOf = (source: string, fn: string) => {
      const start = source.indexOf(`export async function ${fn}(`);
      expect(start, fn).toBeGreaterThan(-1);
      const next = source.indexOf("\nexport ", start + 10);
      return source.slice(start, next === -1 ? undefined : next);
    };
    expect(bodyOf(service, "generatePartnerReviewDraft")).toMatch(/requirePartnerReviewsAccess\(actor, "create"\)/);
    expect(bodyOf(service, "refreshPartnerReviewEvidence")).toMatch(/loadAuthorizedReview\(actor, reviewRef, "create"\)/);
    expect(bodyOf(lifecycle, "submitPartnerReviewForReview")).toMatch(/loadAuthorizedReview\(actor, reviewRef, "submit_partner_review"\)/);
    expect(bodyOf(lifecycle, "finalizePartnerReview")).toMatch(/loadAuthorizedReview\(actor, reviewRef, "finalize_approve"\)/);
    expect(bodyOf(lifecycle, "createPartnerReviewRevision")).toMatch(/loadAuthorizedReview\(actor, reviewRef, "create"\)/);
    // The UI booleans are the same three explicit grants.
    const permissions = read("partner-review-permissions.ts");
    for (const action of ["create", "submit_partner_review", "finalize_approve"]) expect(permissions).toContain(`canPerformAction(actor, "partner_reviews", "${action}")`);
  });

  it("R2/R8: no Finance / Payable / Invoice / Payment / currency / money vocabulary in server, features, pages or routes beyond the accepted markers", () => {
    // The accepted payment markers (Agreement-governed commercial evidence) - everything else Finance-shaped is a violation.
    const ACCEPTED = /affectsPayment|paymentAffectingEvidence|payment-affecting|Payment-affecting|does not affect payment/g;
    // "currency" in this module means VERSION currency (is this the current finalized version?), never money.
    const VERSION_CURRENCY = /getReviewVersionCurrency|evaluateReviewVersionCurrency|ReviewVersionCurrencyState|ReviewVersionCurrency|versionCurrency|VersionCurrency/g;
    for (const file of ALL_MODULE_FILES) {
      // (partner-review-events.ts keeps a metadata key DENY-list that names money-shaped keys precisely so they are dropped.)
      const stripped = codeOf(file).replace(/const FORBIDDEN_METADATA_KEY_SUBSTRINGS = \[[^\]]*\];/, "").replace(ACCEPTED, "").replace(VERSION_CURRENCY, "");
      const money = /finance|payable|invoice|payment|payee|₹|\bINR\b|\bUSD\b|\bEUR\b|rupee|\bpayout\b|\bsalary\b|\bremuneration\b|\bprice\b|\bamount\b|\bfees?\b|\bbudget\b/i.exec(stripped)?.[0] ?? null;
      expect({ file: rel(file), money }).toEqual({ file: rel(file), money: null });
      // "currency" left after removing the version-currency identifiers: only the documented UI column header may remain.
      const leftover = /currency/i.exec(stripped)?.[0] ?? null;
      const allowedHeader = rel(file).endsWith("ReviewDetailTabs.tsx");
      expect({ file: rel(file), leftover: leftover && allowedHeader ? null : leftover }).toEqual({ file: rel(file), leftover: null });
    }
    // No import of a Finance-shaped module path from any of the four trees.
    for (const file of ALL_MODULE_FILES) {
      const imports = [...readFileSync(file, "utf8").matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]!);
      expect({ file: rel(file), bad: imports.filter((spec) => /finance|payable|invoice|payment|agreement/i.test(spec)) }).toEqual({ file: rel(file), bad: [] });
    }
  });

  it("R9: the shared `.sr` utility is the corrected clip pattern (never display:none / visibility:hidden), and no Partner Reviews source hides a label with display:none", () => {
    const css = readFileSync(path.join(repoRoot, "src/ui/foundation.css"), "utf8");
    const rule = /\.sr\{([^}]*)\}/.exec(css);
    expect(rule, ".sr rule exists in the shared foundation").not.toBeNull();
    const body = rule![1]!;
    for (const required of ["position:absolute", "width:1px", "height:1px", "overflow:hidden", "clip:rect(0,0,0,0)", "clip-path:inset(50%)", "white-space:nowrap"]) expect(body, required).toContain(required);
    expect(body).not.toMatch(/display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0/);
    for (const file of [...TREES.features, ...TREES.pages]) {
      const source = codeOf(file);
      expect({ file: rel(file), hidden: /display\s*:\s*["']?none|visibility\s*:\s*["']?hidden|\bhidden\b\s*(?:=|>)/.exec(source)?.[0] ?? null }).toEqual({ file: rel(file), hidden: null });
    }
    // The utility is really used for the tables' captions (screen-reader-only text stays in the accessibility tree).
    expect(TREES.features.filter((file) => /className="sr"/.test(readFileSync(file, "utf8"))).length).toBeGreaterThanOrEqual(3);
  });
});

// =====================================================================================================================
// R4 - the FIVE-ROLE action matrix through the real services with the SEEDED emulator users.
// =====================================================================================================================
const ROLE_MATRIX: Array<{ role: Role; generate: boolean; refresh: boolean; submit: boolean; finalize: boolean; revision: boolean }> = [
  { role: "viewer", generate: false, refresh: false, submit: false, finalize: false, revision: false },
  { role: "analyst", generate: false, refresh: false, submit: false, finalize: false, revision: false },
  { role: "partnership_manager", generate: true, refresh: true, submit: true, finalize: false, revision: true },
  { role: "partnership_head", generate: true, refresh: true, submit: true, finalize: true, revision: true },
  { role: "super_admin", generate: true, refresh: true, submit: true, finalize: true, revision: true },
];

describe("R4: five-role action matrix (seeded users, real service authorization, explicit grants only)", () => {
  it("getReviewActionPermissions and the three explicit action grants are exactly the matrix for every seeded role; Super Admin is GLOBAL by an explicit scope grant", async () => {
    for (const row of ROLE_MATRIX) {
      const actor = await seededActor(row.role);
      expect({ role: row.role, permissions: await getReviewActionPermissions(actor) }).toEqual({
        role: row.role,
        permissions: { canGenerate: row.generate, canRefresh: row.refresh, canSubmit: row.submit, canFinalize: row.finalize, canCreateRevision: row.revision },
      });
      expect(await canPerformAction(actor, "partner_reviews", "create")).toBe(row.generate);
      expect(await canPerformAction(actor, "partner_reviews", "submit_partner_review")).toBe(row.submit);
      expect(await canPerformAction(actor, "partner_reviews", "finalize_approve")).toBe(row.finalize);
    }
    expect(await getReviewActionPermissions(null)).toEqual({ canGenerate: false, canRefresh: false, canSubmit: false, canFinalize: false, canCreateRevision: false });

    // Super Admin: every catalogued action is an EXPLICIT stored grant and the scope is an explicit GLOBAL grant.
    const db = getAdminFirestore();
    const stored = (await db.collection(COLLECTIONS.accessGrants).doc("super_admin").get()).data()?.features?.partner_reviews;
    for (const action of MODULE_ACTIONS.partner_reviews) expect(stored.actions[action.id]).toBe(true);
    expect(hasGlobalScope(await getActorScopeGrants(await seededActor("super_admin")))).toBe(true);
    for (const role of ["viewer", "analyst", "partnership_manager", "partnership_head"] as const) expect(hasGlobalScope(await getActorScopeGrants(await seededActor(role)))).toBe(false);
  });

  it("decisions come from explicit grants, never the role name: a role-only Super Admin with no GLOBAL grant is scope-limited, and per-user overrides change the decision either way", async () => {
    const region = newRegion("noglobal");
    const partnerIn = await seedPartner({ regionIds: [region] });
    const partnerOut = await seedPartner({ regionIds: ["Kerala"] });
    await seedAssignment(partnerIn.partnerRef, { regionIds: [region] });
    await seedAssignment(partnerOut.partnerRef, { regionIds: [region] });
    // A Super Admin BY ROLE whose only scope is `region` (no GLOBAL): reaches its region, not Kerala.
    const roleOnlyAdmin = await syntheticActor("super_admin", [region]);
    expect(await getReviewActionPermissions(roleOnlyAdmin)).toEqual({ canGenerate: true, canRefresh: true, canSubmit: true, canFinalize: true, canCreateRevision: true });
    expect((await generatePartnerReviewDraft(roleOnlyAdmin, { partnerRef: partnerIn.partnerRef, periodKey: "2003-03" }, "req")).ok).toBe(true);
    reviewRefsToClean.add(reviewRefFor(partnerIn.partnerRef, "2003-03"));
    expect(await generatePartnerReviewDraft(roleOnlyAdmin, { partnerRef: partnerOut.partnerRef, periodKey: "2003-03" }, "req")).toMatchObject({ ok: false, code: "unauthorized", reason: "scope_denied" });

    // Overrides are tri-state explicit grants: deny finalize for a Super Admin, allow create for a Viewer.
    const db = getAdminFirestore();
    const denyFinalize = await syntheticActor("super_admin", [region]);
    const allowCreate = await syntheticActor("viewer", [region]);
    const overrideRefs = [denyFinalize, allowCreate].map((actor) => db.collection(COLLECTIONS.userAccessOverrides).doc(actor.uid));
    cleanup.push(...overrideRefs);
    await overrideRefs[0]!.set({ uid: denyFinalize.uid, features: { partner_reviews: { actions: { finalize_approve: false } } }, version: 1 });
    await overrideRefs[1]!.set({ uid: allowCreate.uid, features: { partner_reviews: { actions: { create: true } } }, version: 1 });
    expect(await getReviewActionPermissions(denyFinalize)).toEqual({ canGenerate: true, canRefresh: true, canSubmit: true, canFinalize: false, canCreateRevision: true });
    expect(await getReviewActionPermissions(allowCreate)).toEqual({ canGenerate: true, canRefresh: true, canSubmit: false, canFinalize: false, canCreateRevision: true });
    const created = await generatePartnerReviewDraft(allowCreate, { partnerRef: partnerIn.partnerRef, periodKey: "2003-02" }, "req");
    expect(created.ok).toBe(true);
    reviewRefsToClean.add(reviewRefFor(partnerIn.partnerRef, "2003-02"));
  });

  for (const row of ROLE_MATRIX) {
    it(`${row.role}: every lifecycle action through the real services is allowed/denied exactly per the matrix (finalize ${row.finalize ? "allowed" : "denied"}), and a denial writes nothing`, async () => {
      const actor = await seededActor(row.role);
      const head = await seededActor("partnership_head");
      const admin = await seededActor("super_admin");
      // One Kerala Partner (in every non-global seeded scope), evidence in the private region, four months.
      const partner = await seedPartner({ regionIds: ["Kerala"] });
      const evidence = { regionIds: [PRIVATE_REGION] };
      for (const day of ["2002-01-10", "2002-02-10", "2002-03-10", "2002-04-10"]) await seedAssignment(partner.partnerRef, { dueAt: day, ...evidence });
      const analytics = await seedAnalytics(partner.partnerRef, { period: { start: "2002-03-01", end: "2002-03-28" }, ...evidence });

      // Set-up (by the Head - not the role under test): D = Draft, I = In Review, F = Finalized with an upstream change (revision available).
      const draft = await generate(head, partner.partnerRef, "2002-01");
      const inReview = await generate(head, partner.partnerRef, "2002-02");
      const inReviewSubmitted = await submit(head, inReview.review.head.reviewRef, inReview.review.selectedVersion!.docVersion);
      const { reviewRef: finalizedRef, finalized } = await generateAndFinalize(head, head, partner.partnerRef, "2002-03");
      await analyticsContentSourceRecordsCollection().doc(analytics.uid).update({ likes: 7 });
      const refD = draft.review.head.reviewRef;
      const refI = inReview.review.head.reviewRef;
      const before = {
        d: [await rawDoc(versionRef(refD, 1)), await rawHeadDoc(refD)],
        i: [await rawDoc(versionRef(refI, 1)), await rawHeadDoc(refI)],
        f: [await rawDoc(versionRef(finalizedRef, 1)), await rawHeadDoc(finalizedRef)],
      };
      const adminRead = must(await getPartnerReview(admin, refD), "admin read");
      const globalTotals = computeReviewListSummary(adminRead.selectedVersion!.snapshot);

      // Sanitized, scoped READ is allowed for every role - and equals the global actor's totals.
      const read = must(await getPartnerReview(actor, refD), `${row.role} read`);
      expect(computeReviewListSummary(read.selectedVersion!.snapshot).production.assignmentsIncluded).toBe(globalTotals.production.assignmentsIncluded);
      if (row.role !== "super_admin") {
        // Evidence lives in a region the role does not hold: the DTO carries no Assignment ref, only counts (sanitized).
        expect(JSON.stringify(read)).not.toMatch(/pr-cl-as-/);
        expect(read.selectedVersion!.sourceRefs).toEqual([]);
      }
      const list = await listPartnerReviewHeads(actor, { partnerRef: partner.partnerRef });
      expect(list.ok && list.data.heads.map((h) => h.reviewRef).sort()).toEqual([refD, refI, finalizedRef].sort());

      // --- Generate (a new month) ---
      const generated = await generatePartnerReviewDraft(actor, { partnerRef: partner.partnerRef, periodKey: "2002-04" }, "req-g");
      if (row.generate) {
        expect(generated.ok).toBe(true);
        if (generated.ok) {
          reviewRefsToClean.add(generated.data.review.head.reviewRef);
          expect(generated.data).toMatchObject({ outcome: "created" });
          expect(generated.data.review.selectedVersion).toMatchObject({ status: "DRAFT", version: 1, generatedByUserRef: actor.userRef });
        }
      } else {
        expect(generated).toMatchObject({ ok: false, code: "unauthorized", reason: "action_denied" });
        expect((await partnerReviewsCollection().where("partnerRef", "==", partner.partnerRef).where("periodKey", "==", "2002-04").get()).size).toBe(0);
      }

      // --- Refresh (Draft D, in place: same version, still DRAFT) ---
      const refreshed = await refreshPartnerReviewEvidence(actor, refD, { expectedDocVersion: 1 }, "req-r");
      if (row.refresh) {
        expect(refreshed.ok).toBe(true);
        if (refreshed.ok) expect(refreshed.data.selectedVersion).toMatchObject({ version: 1, status: "DRAFT", docVersion: 2 });
      } else {
        expect(refreshed).toMatchObject({ ok: false, code: "unauthorized", reason: "action_denied" });
      }

      // --- Submit (Draft D -> In Review) ---
      const submitted = await submitPartnerReviewForReview(actor, refD, { expectedDocVersion: row.refresh ? 2 : 1 }, "req-s");
      if (row.submit) {
        expect(submitted.ok).toBe(true);
        if (submitted.ok) expect(submitted.data.selectedVersion).toMatchObject({ status: "IN_REVIEW", submittedByUserRef: actor.userRef });
      } else {
        expect(submitted).toMatchObject({ ok: false, code: "unauthorized", reason: "action_denied" });
      }

      // --- Finalize (In Review I -> Finalized): Head / Super Admin only ---
      const finalizeResult = await finalizePartnerReview(actor, refI, { expectedDocVersion: inReviewSubmitted.selectedVersion!.docVersion }, "req-f");
      if (row.finalize) {
        expect(finalizeResult.ok).toBe(true);
        if (finalizeResult.ok) expect(finalizeResult.data.selectedVersion).toMatchObject({ status: "FINALIZED", finalizedByUserRef: actor.userRef });
      } else {
        expect(finalizeResult).toMatchObject({ ok: false, code: "unauthorized", reason: "action_denied" });
        // Denied: the In Review version is byte-identical (a Manager cannot finalize what is In Review).
        expect(await rawDoc(versionRef(refI, 1))).toBe(before.i[0]);
        expect(await rawHeadDoc(refI)).toBe(before.i[1]);
      }

      // --- Create revision (Finalized F with an upstream change -> next Draft) ---
      const revision = await createPartnerReviewRevision(actor, finalizedRef, { expectedDocVersion: finalized.head.docVersion }, "req-v");
      if (row.revision) {
        expect(revision.ok).toBe(true);
        if (revision.ok) {
          expect(revision.data.selectedVersion).toMatchObject({ version: 2, status: "DRAFT" });
          expect(revision.data.head).toMatchObject({ latestVersion: 2, currentFinalizedVersion: 1, openVersion: 2 });
        }
        // The old FINALIZED version is untouched by the revision.
        expect(await rawDoc(versionRef(finalizedRef, 1))).toBe(before.f[0]);
      } else {
        expect(revision).toMatchObject({ ok: false, code: "unauthorized", reason: "action_denied" });
        expect(await rawDoc(versionRef(finalizedRef, 1))).toBe(before.f[0]);
        expect(await rawHeadDoc(finalizedRef)).toBe(before.f[1]);
        expect((await partnerReviewVersionsCollection(finalizedRef).get()).size).toBe(1);
      }

      // Viewer / Analyst: NOTHING was written anywhere by the whole denied attempt.
      if (!row.generate) {
        expect(await rawDoc(versionRef(refD, 1))).toBe(before.d[0]);
        expect(await rawHeadDoc(refD)).toBe(before.d[1]);
        expect(await rawDoc(versionRef(refI, 1))).toBe(before.i[0]);
      }
      // A Manager never finalizes: the In Review version it could submit is still In Review.
      if (row.role === "partnership_manager") expect(JSON.parse(await rawDoc(versionRef(refI, 1))).status).toBe("IN_REVIEW");
    });
  }
});

// =====================================================================================================================
// R2 / R3 / R8 - runtime Finance boundary, idempotent generate, atomic supersession (Firestore instrumentation).
// =====================================================================================================================
describe("R2/R3/R8: what the module reads and writes", () => {
  it("R2/R8: the whole lifecycle (generate, retry, refresh, submit, finalize, revision, reads, handoff) writes ONLY partnerReviews documents and reads NO Finance-shaped collection", async () => {
    const manager = await seededActor("partnership_manager");
    const head = await seededActor("partnership_head");
    const partner = await seedPartner({ regionIds: ["Kerala"] });
    await seedAssignment(partner.partnerRef, { dueAt: "2004-05-10" });
    const analytics = await seedAnalytics(partner.partnerRef, { period: { start: "2004-05-01", end: "2004-05-28" } });

    const io = instrument();
    const generated = await generate(manager, partner.partnerRef, "2004-05");
    const reviewRef = generated.review.head.reviewRef;
    const retry = await generate(manager, partner.partnerRef, "2004-05");
    expect(retry.outcome).toBe("existing");
    const refreshed = must(await refreshPartnerReviewEvidence(manager, reviewRef, { expectedDocVersion: 1 }, "req-r"), "refresh");
    const submitted = await submit(manager, reviewRef, refreshed.selectedVersion!.docVersion);
    const finalized = await finalize(head, reviewRef, submitted.selectedVersion!.docVersion);
    must(await getFinalizedReviewHandoff(manager, reviewRef), "handoff");
    must(await getReviewVersionCurrency(manager, reviewRef, 1), "currency");
    io.stop();
    // (the upstream write below is the TEST's own fixture edit, made outside the instrumented window)
    await analyticsContentSourceRecordsCollection().doc(analytics.uid).update({ likes: 9 });
    const io2 = instrument();
    must(await createPartnerReviewRevision(manager, reviewRef, { expectedDocVersion: finalized.head.docVersion }, "req-v"), "revision");
    must(await getPartnerReview(head, reviewRef), "read");
    must(await getPartnerReviewHistory(head, partner.partnerRef, { month: { state: "absent" }, until: { state: "absent" } }), "history");
    io2.stop();

    for (const recorder of [io, io2]) {
      expect(recorder.writes.length).toBeGreaterThan(0);
      // EVERY write (transactional, batch or direct) targets a document under the partnerReviews family.
      const outside = recorder.writes.filter((write) => write.path.split("/")[0] !== PARTNER_REVIEWS_COLLECTIONS.partnerReviews);
      expect(outside).toEqual([]);
      // Reads: only upstream domain collections + its own family - never a Finance-shaped one.
      const touched = [...recorder.collectionsTouched];
      expect(touched.filter((name) => /finance|payable|invoice|payment|payee|agreement|ledger|currency/i.test(name))).toEqual([]);
    }
    // Sanity: the instrumentation really saw the module's own and its upstream collections.
    expect([...io.collectionsTouched]).toEqual(expect.arrayContaining([PARTNER_REVIEWS_COLLECTIONS.partnerReviews, "assignments", "partners"]));
    expect(io.writes.some((write) => write.path.includes("/versions/"))).toBe(true);
    expect(io.writes.some((write) => write.path.includes("/events/"))).toBe(true);
  });

  it("R2: a generate retry is idempotent - no second version 1, no second head, no version/event write (at most the head's best-effort freshnessHint update)", async () => {
    const manager = await seededActor("partnership_manager");
    const head = await seededActor("partnership_head");
    const partner = await seedPartner({ regionIds: ["Kerala"] });
    await seedAssignment(partner.partnerRef, { dueAt: "2004-06-10" });
    const first = await generate(manager, partner.partnerRef, "2004-06");
    const reviewRef = first.review.head.reviewRef;
    expect(first.outcome).toBe("created");
    expect(first.review.selectedVersion).toMatchObject({ status: "DRAFT", version: 1 });

    const versionBefore = await rawDoc(versionRef(reviewRef, 1));
    const io = instrument();
    const retry = await generate(head, partner.partnerRef, "2004-06");
    io.stop();
    expect(retry.outcome).toBe("existing");
    expect(retry.review.head.reviewRef).toBe(reviewRef);
    expect(io.writes.filter((write) => /\/(versions|events)\//.test(write.path))).toEqual([]);
    expect(io.writes.filter((write) => write.op !== "update")).toEqual([]);
    expect(await rawDoc(versionRef(reviewRef, 1))).toBe(versionBefore);
    expect((await partnerReviewVersionsCollection(reviewRef).get()).size).toBe(1);
    expect((await partnerReviewsCollection().where("partnerRef", "==", partner.partnerRef).get()).size).toBe(1);

    // ...and after the review is FINALIZED a retry still creates nothing (no new Draft, no second v1).
    const submitted = await submit(manager, reviewRef, first.review.selectedVersion!.docVersion);
    await finalize(head, reviewRef, submitted.selectedVersion!.docVersion);
    const afterFinal = await generate(manager, partner.partnerRef, "2004-06");
    expect(afterFinal.outcome).toBe("existing");
    expect(afterFinal.review.head).toMatchObject({ latestVersion: 1, latestStatus: "FINALIZED" });
    expect((await partnerReviewVersionsCollection(reviewRef).get()).size).toBe(1);
  });

  it("R3: a replacement's finalization supersedes the previous version ATOMICALLY - both version documents, the head and the events are written by one transaction - and the historical version stays addressable", async () => {
    const manager = await seededActor("partnership_manager");
    const head = await seededActor("partnership_head");
    const partner = await seedPartner({ regionIds: ["Kerala"] });
    await seedAssignment(partner.partnerRef, { dueAt: "2004-07-10" });
    const analytics = await seedAnalytics(partner.partnerRef, { period: { start: "2004-07-01", end: "2004-07-28" } });
    const { reviewRef, finalized } = await generateAndFinalize(manager, head, partner.partnerRef, "2004-07");
    await analyticsContentSourceRecordsCollection().doc(analytics.uid).update({ likes: 3 });
    const revision = must(await createPartnerReviewRevision(manager, reviewRef, { expectedDocVersion: finalized.head.docVersion }, "req-v"), "revision");
    const v2Submitted = await submit(manager, reviewRef, revision.selectedVersion!.docVersion);
    const v1Before = await rawDoc(versionRef(reviewRef, 1));
    // While v2 is In Review, v1 is still the current FINALIZED version.
    expect(JSON.parse(v1Before).status).toBe("FINALIZED");

    const io = instrument();
    const done = must(await finalizePartnerReview(head, reviewRef, { expectedDocVersion: v2Submitted.selectedVersion!.docVersion }, "req-f2"), "finalize v2");
    io.stop();
    expect(done.head).toMatchObject({ currentFinalizedVersion: 2, openVersion: null, latestStatus: "FINALIZED" });

    const byTx = new Map<object, string[]>();
    for (const write of io.writes) if (write.tx) byTx.set(write.tx, [...(byTx.get(write.tx) ?? []), `${write.op}:${write.path}`]);
    const headPath = `${PARTNER_REVIEWS_COLLECTIONS.partnerReviews}/${reviewRef}`;
    const versionPath = (n: number) => `${headPath}/${PARTNER_REVIEWS_COLLECTIONS.versions}/${n}`;
    const eventsPrefix = `${headPath}/${PARTNER_REVIEWS_COLLECTIONS.events}/`;
    const supersedingTx = [...byTx.values()].filter((paths) => paths.some((p) => p.endsWith(versionPath(1))) && paths.some((p) => p.endsWith(versionPath(2))));
    expect(supersedingTx).toHaveLength(1);
    expect(supersedingTx[0]!.some((p) => p.endsWith(`:${headPath}`))).toBe(true);
    expect(supersedingTx[0]!.filter((p) => p.includes(eventsPrefix)).length).toBeGreaterThanOrEqual(2); // finalized + superseded
    // No direct (non-transactional) write touched either version document. (A Transaction delegates to its own WriteBatch,
    // which the instrumentation also sees: those are the same write, not a second, direct one.)
    const direct = io.writes.filter((write) => write.tx === null && !io.writes.some((other) => other.tx !== null && other.op === write.op && other.path === write.path));
    expect(direct.filter((write) => write.path.includes("/versions/"))).toEqual([]);

    // v1 is SUPERSEDED with its evidence byte-for-byte preserved, and addressable through the version read.
    const v1After = JSON.parse(await rawDoc(versionRef(reviewRef, 1)));
    expect(v1After).toMatchObject({ status: "SUPERSEDED", supersededByVersion: 2 });
    expect(v1After.snapshot).toEqual(JSON.parse(v1Before).snapshot);
    expect(v1After.sourceFingerprint).toBe(JSON.parse(v1Before).sourceFingerprint);
    const historical = must(await getPartnerReviewVersion(manager, reviewRef, "1"), "version 1");
    expect(historical.version).toMatchObject({ version: 1, status: "SUPERSEDED", supersededByVersion: 2 });
  });
});

// =====================================================================================================================
// R7 - frozen finalized evidence (injected clock).
// =====================================================================================================================
describe("R7: finalized evidence is frozen - a later clock never changes its Compliance facts", () => {
  it("time-dependent facts recorded against the evidence cutoff (notCompletedPastDue) stay exactly as finalized after 'now' moves on, while a fresh build at the later time WOULD differ and the fingerprint stays equal", async () => {
    const manager = await seededActor("partnership_manager");
    const head = await seededActor("partnership_head");
    const admin = await seededActor("super_admin");
    const partner = await seedPartner({ regionIds: ["Kerala"] });
    // Due on the 10th, no Content thread: 'not completed past due' depends ONLY on the evidence cutoff.
    await seedAssignment(partner.partnerRef, { dueAt: "2003-05-10" });
    const T0 = new Date("2003-05-05T00:00:00.000Z");
    const period = derivePeriod("2003-05")!;

    // Inject the clock for the whole build/refresh/finalize window (the collector already takes `now`).
    const realCollect = evidenceCollector.collectPartnerEvidence;
    const clock = vi.spyOn(evidenceCollector, "collectPartnerEvidence").mockImplementation((partnerRef, p, options) => realCollect(partnerRef, p, { ...options, now: () => T0 }));
    const { reviewRef } = await generateAndFinalize(manager, head, partner.partnerRef, "2003-05");
    clock.mockRestore();

    const finalizedDoc = await rawDoc(versionRef(reviewRef, 1));
    const stored = JSON.parse(finalizedDoc);
    expect(stored.status).toBe("FINALIZED");
    expect(stored.snapshot.evidenceCutoff).toBe(T0.toISOString());
    expect(stored.snapshot.compliance.assignments[0]).toMatchObject({ notCompletedPastDue: false, submittedBeforeDue: null });

    // Time has moved on (the real clock is years later): a fresh build says the Assignment IS now past due...
    const fresh = await realCollect(partner.partnerRef, period);
    expect(fresh.snapshot.compliance.assignments[0]!.notCompletedPastDue).toBe(true);
    // ...but the fingerprint is time-independent, so freshness stays 'current' and nothing is re-derived.
    expect(fresh.sourceFingerprint).toBe(stored.sourceFingerprint);

    const reread = must(await getPartnerReview(admin, reviewRef), "re-read");
    expect(reread.selectedVersion!.snapshot.compliance.assignments[0]).toMatchObject({ notCompletedPastDue: false });
    expect(reread.selectedVersion!.snapshot.evidenceCutoff).toBe(T0.toISOString());
    expect(reread.freshness?.state).not.toBe("revision_available");
    expect(["current", "evidence_incomplete"]).toContain(reread.freshness?.state);
    expect(must(await getPartnerReviewVersion(admin, reviewRef, "1"), "version").version.snapshot.compliance.assignments[0]!.notCompletedPastDue).toBe(false);
    // Reading never rewrote the finalized document.
    expect(await rawDoc(versionRef(reviewRef, 1))).toBe(finalizedDoc);
  });
});

// =====================================================================================================================
// R1 - Overview through the real service (synthetic actor with a private region: deterministic figures).
// =====================================================================================================================
const query = (over: Partial<WorkspaceQuery> = {}): WorkspaceQuery => ({ month: { state: "absent" }, filter: null, signal: null, region: [], limit: 10, ...over });

describe("R1: Overview figures and month rules through the real services", () => {
  it("future months are never the default (Overview, Workspace and Partner history), an all-future scope has no month, and the past month wins", async () => {
    const region = newRegion("future");
    const actor = await syntheticActor("partnership_manager", [region]);
    const partner = await seedPartner({ regionIds: [region] });
    await seedAssignment(partner.partnerRef, { dueAt: "2099-06-10", regionIds: [region] });
    // Assignment month = dueAt else createdAt: a future createdAt (no dueAt) is also a future month.
    await seedAssignment(partner.partnerRef, { dueAt: null, createdAt: "2099-01-05T08:00:00.000Z", regionIds: [region] });
    const only = must(await getPartnerReviewsOverview(actor, { state: "absent" }), "overview only-future");
    expect(only.month).toMatchObject({ resolved: null, source: "none", options: [] });
    expect(only.counts.monthlyReviews).toBe(0);
    expect(buildOverviewModel(only).kpis.map((kpi) => kpi.value)).toEqual(["—", "—", "—", "—"]);
    const wsOnly = must(await getPartnerReviewsWorkspace(actor, query()), "workspace only-future");
    expect(wsOnly.month).toMatchObject({ resolved: null, source: "none" });
    const historyOnly = must(await getPartnerReviewHistory(actor, partner.partnerRef, { month: { state: "absent" }, until: { state: "absent" } }), "history only-future");
    expect(historyOnly.month).toMatchObject({ selected: null, source: "none" });

    await seedAssignment(partner.partnerRef, { dueAt: "2003-04-10", regionIds: [region] });
    const overview = must(await getPartnerReviewsOverview(actor, { state: "absent" }), "overview");
    expect(overview.month).toMatchObject({ resolved: "2003-04", source: "latest_candidate" });
    expect(overview.month.options.map((o) => o.month)).toEqual(["2003-04"]);
    const workspace = must(await getPartnerReviewsWorkspace(actor, query()), "workspace");
    expect(workspace.month).toMatchObject({ resolved: "2003-04", source: "latest_candidate" });
    const history = must(await getPartnerReviewHistory(actor, partner.partnerRef, { month: { state: "absent" }, until: { state: "absent" } }), "history");
    expect(history.month).toMatchObject({ selected: "2003-04", source: "latest_candidate" });
    expect(history.rows.map((row) => row.periodKey)).not.toContain("2099-06");
    // A future month is still refused by Generate.
    expect(await generatePartnerReviewDraft(actor, { partnerRef: partner.partnerRef, periodKey: "2099-06" }, "req")).toMatchObject({ ok: false, code: "invalid_input" });
  });

  it("Assignment month = dueAt else createdAt; qualifying content counts approved Content only (never raw links); Required is Unavailable without an Agreement; Finalized reviews is a truthful count of current finalized versions", async () => {
    const region = newRegion("overview");
    const manager = await syntheticActor("partnership_manager", [region]);
    const head = await syntheticActor("partnership_head", [region]);
    const partner = await seedPartner({ regionIds: [region] });
    const inRegion = { regionIds: [region] };
    // 2003-05: x (createdAt only), z (approved thread, 2 links), w (under-review thread, 3 links). y is due in 2003-06 although created in 2003-05.
    await seedAssignment(partner.partnerRef, { dueAt: null, createdAt: "2003-05-05T08:00:00.000Z", ...inRegion });
    const z = await seedAssignment(partner.partnerRef, { dueAt: "2003-05-15", ...inRegion });
    await seedThread(z, { status: "APPROVED", approvedAt: "2003-05-14T00:00:00.000Z", links: 2, ...inRegion });
    const w = await seedAssignment(partner.partnerRef, { dueAt: "2003-05-20", ...inRegion });
    await seedThread(w, { status: "UNDER_REVIEW", links: 3, ...inRegion });
    await seedAssignment(partner.partnerRef, { dueAt: "2003-06-02", createdAt: "2003-05-20T08:00:00.000Z", ...inRegion });
    const analytics = await seedAnalytics(partner.partnerRef, { period: { start: "2003-05-01", end: "2003-05-28" }, ...inRegion });

    await generate(manager, partner.partnerRef, "2003-05");
    await generate(manager, partner.partnerRef, "2003-06");

    const may = must(await getPartnerReviewsOverview(manager, { state: "valid", month: "2003-05" }), "overview may");
    expect(may.counts).toMatchObject({ monthlyReviews: 1, finalizedReviews: 0, assignmentsReceived: 3, qualifyingContent: 1, requiredTotal: 0, reviewsWithRequirement: 0 });
    expect(may.counts.production).toMatchObject({ underReview: 1, approved: 1 });
    const june = must(await getPartnerReviewsOverview(manager, { state: "valid", month: "2003-06" }), "overview june");
    expect(june.counts.assignmentsReceived).toBe(1);
    // The default month is the latest review month.
    const dflt = must(await getPartnerReviewsOverview(manager, { state: "absent" }), "overview default");
    expect(dflt.month).toMatchObject({ resolved: "2003-06", source: "latest_review" });

    // Frozen composition + unavailable-not-zero at the model level, from real data.
    const model = buildOverviewModel(may);
    expect(model.kpis.map((kpi) => kpi.label)).toEqual(["Monthly reviews", "Assignments received", "Qualifying content", "Finalized reviews"]);
    expect(model.kpis.map((kpi) => kpi.value)).toEqual(["1", "3", "1", "0"]);
    expect(model.kpis[2]!.hint).toBe("Requirement unavailable");
    const production = model.topPanels[0]!;
    expect(production.kind === "columns" && production.rows[0]).toMatchObject({ label: "Required", unavailable: true });
    expect(model.topPanels.map((panel) => panel.span)).toEqual([4, 4, 4]);
    expect(model.bottomPanels.map((panel) => panel.span)).toEqual([3, 3, 3, 3]);
    // No raw URL anywhere in the Overview DTO.
    expect(JSON.stringify(may)).not.toMatch(/https?:|instagram\.com/i);

    // Finalized reviews: 1 finalized (Head) + 1 draft in the same month => 1 of 2; a revision that supersedes v1 still counts ONE.
    const second = await seedPartner({ regionIds: [region] });
    await seedAssignment(second.partnerRef, { dueAt: "2003-05-18", ...inRegion });
    const mayRef = reviewRefFor(partner.partnerRef, "2003-05");
    const draftDetail = must(await getPartnerReview(manager, mayRef), "may detail");
    const submitted = await submit(manager, mayRef, draftDetail.selectedVersion!.docVersion);
    const finalized = await finalize(head, mayRef, submitted.selectedVersion!.docVersion);
    await generate(manager, second.partnerRef, "2003-05");
    const afterFinal = must(await getPartnerReviewsOverview(manager, { state: "valid", month: "2003-05" }), "overview after");
    expect(afterFinal.counts).toMatchObject({ monthlyReviews: 2, finalizedReviews: 1 });
    expect(buildOverviewModel(afterFinal).kpis[3]).toMatchObject({ value: "1", hint: "of 2 monthly reviews" });

    await analyticsContentSourceRecordsCollection().doc(analytics.uid).update({ likes: 11 });
    const revision = must(await createPartnerReviewRevision(manager, mayRef, { expectedDocVersion: finalized.head.docVersion }, "req-v"), "revision");
    const revSubmitted = await submit(manager, mayRef, revision.selectedVersion!.docVersion);
    await finalize(head, mayRef, revSubmitted.selectedVersion!.docVersion);
    const afterRevision = must(await getPartnerReviewsOverview(manager, { state: "valid", month: "2003-05" }), "overview after revision");
    expect(afterRevision.counts).toMatchObject({ monthlyReviews: 2, finalizedReviews: 1 });
  });
});

// =====================================================================================================================
// R6 - Partner-wise history: bounded reads (no per-month N+1), no combined score, neutral denials.
// =====================================================================================================================
describe("R6: Partner-wise history", () => {
  it("the number of Firestore read calls is CONSTANT in the number of months (2 reviews vs 14 reviews): no per-month freshness or version read", async () => {
    const region = newRegion("history");
    const actor = await syntheticActor("partnership_manager", [region]);
    const few = await seedPartner({ regionIds: [region] });
    const many = await seedPartner({ regionIds: [region] });
    for (const month of ["2008-01", "2008-02"]) await seedDirectReview(few, month);
    const months: string[] = [];
    for (let y = 2006; y <= 2007; y += 1) for (let m = 1; m <= 12; m += 1) months.push(`${y}-${String(m).padStart(2, "0")}`);
    for (const month of months.slice(0, 14)) await seedDirectReview(many, month);

    const collector = vi.spyOn(evidenceCollector, "collectPartnerEvidence");
    const readsFor = async (partnerRef: string) => {
      const io = instrument();
      const result = await getPartnerReviewHistory(actor, partnerRef, { month: { state: "absent" }, until: { state: "absent" } });
      const calls = io.reads();
      const writes = io.writes.length;
      io.stop();
      return { result, calls, writes };
    };
    const a = await readsFor(few.partnerRef);
    const b = await readsFor(many.partnerRef);
    expect(a.result.ok && b.result.ok).toBe(true);
    if (!a.result.ok || !b.result.ok) return;
    expect(a.result.data.rows.filter((row) => row.state === "review")).toHaveLength(2);
    expect(b.result.data.rows).toHaveLength(12); // bounded latest-12-month window
    expect(b.result.data.rows.every((row) => row.state === "review")).toBe(true);
    // Constant read count: more months cost no more reads. And a read never writes.
    expect(b.calls).toBe(a.calls);
    expect(a.writes + b.writes).toBe(0);
    expect(collector).toHaveBeenCalledTimes(0);
  });

  it("no combined productivity score, rating, rank or blended figure exists anywhere in the history / Workspace / Overview / page DTOs (whole-tree key and value walk)", async () => {
    const region = newRegion("noscore");
    const actor = await syntheticActor("partnership_manager", [region]);
    const partner = await seedPartner({ regionIds: [region] });
    const a = await seedAssignment(partner.partnerRef, { dueAt: "2003-08-10", regionIds: [region] });
    const t = await seedThread(a, { status: "APPROVED", approvedAt: "2003-08-09T00:00:00.000Z", regionIds: [region] });
    await seedAnalytics(partner.partnerRef, { contentRef: t.contentRef, likes: 10, views: 100, period: { start: "2003-08-01", end: "2003-08-28" }, regionIds: [region] });
    await generate(actor, partner.partnerRef, "2003-08");
    const history = must(await getPartnerReviewHistory(actor, partner.partnerRef, { month: { state: "absent" }, until: { state: "absent" } }), "history");
    const workspace = must(await getPartnerReviewsWorkspace(actor, query({ month: parseMonthParam("2003-08"), filter: "drafts" })), "workspace");
    const overview = must(await getPartnerReviewsOverview(actor, { state: "valid", month: "2003-08" }), "overview");
    const page = must(await getPartnerReviewPage(actor, reviewRefFor(partner.partnerRef, "2003-08"), { state: "absent" }), "page");
    const FORBIDDEN = /score|rating|rank|tier|overall|blended|composite|weighted|combined|productivity/i;
    for (const [name, dto] of Object.entries({ history, workspace, overview, page })) {
      // (`matchEvidenceTier` is the Analytics record-matching tier of a source record - provenance, not a rating.)
      expect({ name, keys: keysOf(dto).filter((key) => FORBIDDEN.test(key) && key !== "matchEvidenceTier") }).toEqual({ name, keys: [] });
      const values: string[] = [];
      walkJson(dto, (_key, str) => {
        if (str !== null) values.push(str);
      });
      // A score-shaped LABEL never appears in a DTO value.
      expect({ name, values: values.filter((value) => /\b(score|rating|ranking|blended|composite)\b/i.test(value)) }).toEqual({ name, values: [] });
    }
    // Platform figures stay per platform (no combined total key).
    const row = history.rows[0]!.row!;
    expect(Object.keys(row.summary!.performance.perPlatform)).toEqual(["instagram"]);
  });

  it("unknown, malformed, forged and out-of-scope Partner ids are ONE identical neutral response for every scoped role, and it names no Partner", async () => {
    const region = newRegion("neutral");
    const roles: Role[] = ["viewer", "analyst", "partnership_manager", "partnership_head"];
    const actors = await Promise.all(roles.map((role) => syntheticActor(role, [region])));
    const hidden = await seedPartner({ regionIds: [newRegion("hidden")], displayName: `Hidden Person ${runId}` });
    await seedDirectReview(hidden, "2002-09");
    const ids = [hidden.partnerRef, `forged-${randomUUID()}`, "does-not-exist", "../partners/creator-house", "", "x".repeat(300)];
    let neutral: unknown = null;
    for (const actor of actors) {
      for (const id of ids) {
        const result = await getPartnerReviewHistory(actor, id, { month: { state: "absent" }, until: { state: "absent" } });
        expect(result).toMatchObject({ ok: false, code: "unauthorized", reason: "scope_denied" });
        neutral ??= result;
        expect(result).toEqual(neutral);
        expect(JSON.stringify(result)).not.toContain(hidden.displayName);
        expect(JSON.stringify(result)).not.toContain(hidden.partnerRef);
      }
    }
    // A GLOBAL actor asking for a forged id gets the same neutral response as a scoped actor asking for a hidden one.
    expect(await getPartnerReviewHistory(await seededActor("super_admin"), `forged-${randomUUID()}`, { month: { state: "absent" }, until: { state: "absent" } })).toEqual(neutral);
  });
});

// =====================================================================================================================
// R5 - redaction and direct-access negatives (seeded Manager / Head, real services and real API route handlers).
// =====================================================================================================================
describe("R5: scope-safe DTOs and direct-access negatives", () => {
  it("Manager with Partner access but one source Campaign OUTSIDE its scope: canonical fingerprint + totals equal the global actor's, and NO hidden Campaign / Content URL / raw ref / owner / team / uid leaks in any DTO (whole-tree walk)", async () => {
    const admin = await seededActor("super_admin");
    const manager = await seededActor("partnership_manager");
    const head = await seededActor("partnership_head");
    const tag = randomUUID().slice(0, 8);
    const ownerSecret = `owner-secret-${tag}`;
    const teamSecret = `team-secret-${tag}`;
    const hiddenUrlTag = `OUTSECRETURL${tag}`;
    const partner = await seedPartner({ regionIds: ["Kerala"], ownerUid: ownerSecret, teamIds: [teamSecret], displayName: `Redact ${tag}` });
    const campIn = await seedCampaign({ name: `SCOPE-IN Campaign ${tag}`, regionIds: ["Kerala"], ownerUid: ownerSecret, teamIds: [teamSecret] });
    const campOut = await seedCampaign({ name: `SCOPE-OUT-SECRET Campaign ${tag}`, regionIds: [PRIVATE_REGION], ownerUid: ownerSecret, teamIds: [teamSecret] });
    const owned = { ownerUid: ownerSecret, teamIds: [teamSecret] };
    const a1 = await seedAssignment(partner.partnerRef, { dueAt: "2001-03-10", regionIds: ["Kerala"], campaignRef: campIn.campaignRef, campaignName: campIn.name, ...owned });
    const t1 = await seedThread(a1, { regionIds: ["Kerala"], status: "APPROVED", approvedAt: "2001-03-09T00:00:00.000Z", ...owned });
    await seedAnalytics(partner.partnerRef, { contentRef: t1.contentRef, likes: 111, regionIds: ["Kerala"], matchedAssignmentRef: a1.assignmentRef, matchedCampaignRef: campIn.campaignRef, period: { start: "2001-03-01", end: "2001-03-28" }, ...owned });
    const a2 = await seedAssignment(partner.partnerRef, { dueAt: "2001-03-12", regionIds: [PRIVATE_REGION], campaignRef: campOut.campaignRef, campaignName: campOut.name, ...owned });
    const t2 = await seedThread(a2, { regionIds: [PRIVATE_REGION], urlTag: hiddenUrlTag, ...owned });
    const r2 = await seedAnalytics(partner.partnerRef, { contentRef: t2.contentRef, likes: 222, regionIds: [PRIVATE_REGION], postUrl: `https://instagram.com/p/${hiddenUrlTag}-analytics`, matchedAssignmentRef: a2.assignmentRef, matchedCampaignRef: campOut.campaignRef, period: { start: "2001-03-01", end: "2001-03-28" }, ...owned });
    // An Assignment the Manager CAN see, under a Campaign it CANNOT.
    const a3 = await seedAssignment(partner.partnerRef, { dueAt: "2001-03-18", regionIds: ["Kerala"], campaignRef: campOut.campaignRef, campaignName: campOut.name, ...owned });

    const generated = await generate(manager, partner.partnerRef, "2001-03");
    const reviewRef = generated.review.head.reviewRef;
    const refreshed = must(await refreshPartnerReviewEvidence(manager, reviewRef, { expectedDocVersion: generated.review.selectedVersion!.docVersion }, "req-r"), "refresh");
    const submitted = await submit(manager, reviewRef, refreshed.selectedVersion!.docVersion);
    const finalized = await finalize(head, reviewRef, submitted.selectedVersion!.docVersion);

    // Canonical evidence is actor-independent: same fingerprint + totals as the GLOBAL actor.
    const adminPage = must(await getPartnerReviewPage(admin, reviewRef, { state: "absent" }), "admin page");
    const managerPage = must(await getPartnerReviewPage(manager, reviewRef, { state: "absent" }), "manager page");
    expect(managerPage.detail.selectedVersion!.sourceFingerprint).toBe(adminPage.detail.selectedVersion!.sourceFingerprint);
    expect(managerPage.detail.freshness?.snapshotFingerprint).toBe(adminPage.detail.freshness?.snapshotFingerprint);
    expect(computeReviewListSummary(managerPage.detail.selectedVersion!.snapshot)).toEqual(computeReviewListSummary(adminPage.detail.selectedVersion!.snapshot));
    expect(computeReviewListSummary(managerPage.detail.selectedVersion!.snapshot).production.assignmentsIncluded).toBe(3);
    expect(JSON.stringify(adminPage.detail)).toContain(campOut.name); // sanity: the global actor sees it, so the walk below can see a leak

    const historyDto = must(await getPartnerReviewHistory(manager, partner.partnerRef, { month: { state: "absent" }, until: { state: "absent" } }), "history");
    const overviewDto = must(await getPartnerReviewsOverview(manager, { state: "valid", month: "2001-03" }), "overview");
    const workspaceDto = must(await getPartnerReviewsWorkspace(manager, query({ month: parseMonthParam("2001-03"), filter: "finalized", partnerRef: partner.partnerRef })), "workspace");
    httpActor = manager;
    const apiDetail = await callGet("detail", reviewRef);
    expect(apiDetail.status).toBe(200);
    const dtos: Record<string, unknown> = {
      "generate response (manager)": generated.review,
      "refresh response (manager)": refreshed,
      "submit response (manager)": submitted,
      "finalize response (head)": finalized,
      "page (manager)": managerPage,
      "page (head)": must(await getPartnerReviewPage(head, reviewRef, { state: "absent" }), "head page"),
      "version read (manager)": must(await getPartnerReviewVersion(manager, reviewRef, "1"), "version"),
      "freshness (manager)": must(await inspectPartnerReviewFreshness(manager, reviewRef), "freshness"),
      "handoff (manager)": must(await getFinalizedReviewHandoff(manager, reviewRef), "handoff"),
      "history (manager)": historyDto,
      "overview (manager)": overviewDto,
      "workspace (manager)": workspaceDto,
      "API detail (manager)": apiDetail.body,
    };

    const hiddenNeedles = [campOut.name, campOut.campaignRef, campOut.uid, a2.assignmentRef, a2.uid, t2.contentRef, t2.uid, r2.sourceRef, hiddenUrlTag, hiddenUrlTag.toLowerCase(), "RAW CAPTION", "rawusername", PRIVATE_REGION];
    const secretNeedles = [ownerSecret, teamSecret];
    const forbiddenKeys = new Set(["ownerUid", "teamIds", "partnerUid", "uid", "regionIds", "scope", "grants", "rawPostUrl", "rawCaption", "rawUsername"]);
    for (const [name, dto] of Object.entries(dtos)) {
      const json = JSON.stringify(dto);
      for (const needle of [...hiddenNeedles, ...secretNeedles]) expect({ name, needle, leaked: json.includes(needle) }).toEqual({ name, needle, leaked: false });
      expect({ name, keys: [...new Set(keysOf(dto).filter((key) => forbiddenKeys.has(key)))] }).toEqual({ name, keys: [] });
    }
    // List-shaped DTOs carry counts / labels only: no Content URL of any kind, no Campaign or Assignment identity.
    for (const name of ["history (manager)", "overview (manager)", "workspace (manager)", "handoff (manager)"]) {
      const json = JSON.stringify(dtos[name]);
      for (const needle of ["http", campIn.name, campIn.campaignRef, a1.assignmentRef, a3.assignmentRef, t1.contentRef, "pr-cl-as-", "pr-cl-ct-", "pr-cl-an-", "pr-cl-camp-"]) expect({ name, needle, leaked: json.includes(needle) }).toEqual({ name, needle, leaked: false });
    }
    // In-scope context is still present for the Manager, and Assignment a3 is visible while its hidden Campaign is not.
    expect(JSON.stringify(managerPage.detail)).toContain(campIn.name);
    expect(JSON.stringify(managerPage.detail)).toContain(a3.assignmentRef);
  });

  it("direct access fails closed: out-of-scope review, forged and malformed reviewRef, through the page service AND every API route, name nothing and are identical per family", async () => {
    const admin = await seededActor("super_admin");
    const hidden = await seedPartner({ regionIds: [PRIVATE_REGION], displayName: `Hidden Review Partner ${runId}` });
    await seedAssignment(hidden.partnerRef, { dueAt: "2001-08-10" });
    const reviewRef = (await generate(admin, hidden.partnerRef, "2001-08")).review.head.reviewRef;
    const forged = `pr_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const roles: Role[] = ["viewer", "analyst", "partnership_manager", "partnership_head"];
    const kinds = ["detail", "freshness", "version", "handoff"] as const;

    let deniedShape: unknown = null;
    let forgedShape: unknown = null;
    for (const role of roles) {
      const actor = await seededActor(role);
      // Page service (the Review Detail page): out-of-scope is the neutral scope_denied for EVERY scoped role.
      const denied = await getPartnerReviewPage(actor, reviewRef, { state: "absent" });
      expect(denied).toMatchObject({ ok: false, code: "unauthorized", reason: "scope_denied" });
      deniedShape ??= denied;
      expect(denied).toEqual(deniedShape);
      expect(JSON.stringify(denied)).not.toContain(hidden.displayName);
      expect(JSON.stringify(denied)).not.toContain(hidden.partnerRef);
      // A forged / malformed reference is one identical not_found for every role.
      const missing = await getPartnerReviewPage(actor, forged, { state: "absent" });
      expect(missing).toMatchObject({ ok: false, code: "not_found" });
      forgedShape ??= missing;
      expect(missing).toEqual(forgedShape);
      expect(await getPartnerReviewPage(actor, "../partners/creator-house", { state: "absent" })).toEqual(forgedShape);
      expect(await getPartnerReviewPage(actor, `pr_${"0".repeat(20)}`, { state: "valid", version: 1 })).toEqual(forgedShape);

      // API routes: 403 with the SAME body for every denied read; 404 for the forged ref; nothing names the Partner.
      httpActor = actor;
      for (const kind of kinds) expect(await callGet(kind, reviewRef)).toEqual({ status: 403, body: { error: "Forbidden." } });
      for (const kind of kinds) {
        const forgedResponse = await callGet(kind, forged);
        expect(forgedResponse.status).toBe(404);
        expect(JSON.stringify(forgedResponse.body)).not.toContain(hidden.displayName);
      }
    }
    // Unauthenticated: 401 on every route, same body.
    httpActor = null;
    for (const kind of kinds) expect(await callGet(kind, reviewRef)).toEqual({ status: 401, body: { error: "Forbidden." } });
    // The GLOBAL actor reaches the same review (the negatives are about scope, not a broken route).
    httpActor = admin;
    expect((await callGet("detail", reviewRef)).status).toBe(200);
    // Mutations of an out-of-scope review are denied by scope too (Head holds every action but not this Partner).
    const head = await seededActor("partnership_head");
    for (const result of [
      await refreshPartnerReviewEvidence(head, reviewRef, { expectedDocVersion: 1 }, "req"),
      await submitPartnerReviewForReview(head, reviewRef, { expectedDocVersion: 1 }, "req"),
      await finalizePartnerReview(head, reviewRef, { expectedDocVersion: 1 }, "req"),
      await createPartnerReviewRevision(head, reviewRef, { expectedDocVersion: 1 }, "req"),
    ]) expect(result).toMatchObject({ ok: false, code: "unauthorized", reason: "scope_denied" });
  });
});
