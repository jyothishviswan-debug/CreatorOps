// Step 12E - real reads/writes against the running Firestore/Auth emulator (no
// mocks): the Partner-wise Analytics drill-down, its Partner Record Scope
// gate, its platform filter, its contextual links, and the Data Explorer's
// Partner / Partner Account filter. Run with `pnpm test:emulator` against a
// running `pnpm firebase:emulators`.
//
// Hermetic by construction (same idiom as platform-view.emulator.test.ts):
// every fixture doc is written schema-valid via the Admin SDK with a private
// region / unique refs and deleted afterwards. Exact assertions are made
// through SYNTHETIC scoped actors whose only scope grant is one private
// region, so they see precisely their own fixtures no matter what other files
// have seeded (and Partner refs are unique to this file, so even the GLOBAL
// Super Admin's Partner-filtered read is exact).
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { seedEmulatorTestUsers } from "@/server/auth/seed-users";
import { resolveActor } from "@/server/authz/actor";
import { COLLECTIONS } from "@/server/authz/firestore";
import { seedAccessControlData, TEST_IDENTITIES } from "@/server/authz/seed-access-data";
import { scopeGrantDocId } from "@/server/authz/scope";
import type { ActorContext, ScopeGrantInput } from "@/server/authz/types";
import { campaignsCollection } from "@/server/campaigns/firestore";
import { campaignDocSchema } from "@/server/campaigns/types";
import { getAdminAuth, getAdminFirestore } from "@/server/firebase/admin";
import { partnerAccountsCollection, partnersCollection } from "@/server/partners/firestore";
import { partnerAccountDocSchema, partnerDocSchema } from "@/server/partners/types";

import * as explorerService from "./explorer-service";
import { listAnalyticsSourceRecords } from "./explorer-service";
import { analyticsChannelSourceRecordsCollection, analyticsContentSourceRecordsCollection, analyticsImportBatchesCollection } from "./firestore";
import { resolveAnalyticsLabels } from "./label-resolution";
import { getPartnerAnalyticsView, PARTNER_ANALYTICS_NEUTRAL_MESSAGE } from "./partner-view-service";
import { getPlatformAnalyticsView } from "./platform-view-service";
import { analyticsChannelSourceRecordDocSchema, analyticsContentSourceRecordDocSchema, analyticsImportBatchDocSchema } from "./types";

vi.setConfig({ testTimeout: 60_000 });

// The REAL listAnalyticsSourceRecords (accepted, scoped planner - nothing is stubbed by default), wrapped in a spy so tests can
// assert exactly what the service passes to the planner, and - for the bounded-window test only - simulate an endless
// cursor without writing >1000 fixture documents (a huge write/delete burst would churn the shared collection that other
// files' whole-collection reads scan).
vi.mock("./explorer-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./explorer-service")>();
  return { ...actual, listAnalyticsSourceRecords: vi.fn(actual.listAnalyticsSourceRecords) };
});

const uidByRole = new Map<string, string>();
const runId = Date.now();
const tag = `p12e-${runId}`;
const REGION_A = `${tag}-region-a`;
const REGION_B = `${tag}-region-b`;
const REGION_BULK = `${tag}-region-bulk`;
// A real South-Zone state no other test or seed uses: reachable (per the accepted
// seeds) by Analyst / Manager / Head / Super Admin, so a Partner doc ALONE in it
// (never an Analytics record) proves those explicit grants pass the Partner gate.
const REGION_SEEDED_ROLES = "Lakshadweep";
const BATCH_REF = `${tag}-batch`;
const BATCH_FILENAME = `${tag}-export.xlsx`;
const now = new Date().toISOString();

// Numbers are matched as JSON NUMBER values, never as a raw substring (labels
// embed Date.now() digits that can legitimately contain any short number).
function jsonHasNumber(json: string, value: number | string): boolean {
  return new RegExp(`[:,\\[]${value}[,}\\]]`).test(json);
}

const cleanup: FirebaseFirestore.DocumentReference[] = [];

beforeAll(async () => {
  const password = process.env.EMULATOR_TEST_USER_PASSWORD;
  if (!password) throw new Error("EMULATOR_TEST_USER_PASSWORD is not set - check .env.local. Requires a running Firebase emulator.");
  await seedEmulatorTestUsers(password);
  await seedAccessControlData();

  const auth = getAdminAuth();
  for (const identity of TEST_IDENTITIES) {
    const user = await auth.getUserByEmail(identity.email);
    uidByRole.set(identity.role, user.uid);
  }
  await seedFixtures();
}, 120_000);

afterAll(async () => {
  const db = getAdminFirestore();
  for (let i = 0; i < cleanup.length; i += 400) {
    const batch = db.batch();
    for (const ref of cleanup.slice(i, i + 400)) batch.delete(ref);
    await batch.commit();
  }
}, 120_000);

async function seededActor(role: string): Promise<ActorContext> {
  const uid = uidByRole.get(role);
  if (!uid) throw new Error(`No seeded uid for role ${role}`);
  const actor = await resolveActor(uid);
  if (!actor) throw new Error(`resolveActor returned null for seeded role ${role}`);
  return actor;
}

// A synthetic actor: the Analyst ROLE baseline (analytics explore + partners/
// campaigns features from the seeded accessGrants/analyst document) with a
// private-region scope grant (plus any extra grant a test names).
async function syntheticActor(label: string, region: string, extraGrants: ScopeGrantInput[] = []): Promise<ActorContext> {
  const uid = `${tag}-actor-${label}`;
  for (const input of [{ type: "REGION", region } as ScopeGrantInput, ...extraGrants]) {
    const ref = getAdminFirestore().collection(COLLECTIONS.scopeAssignments).doc(scopeGrantDocId(uid, input));
    await ref.set({ ...input, uid, grantedAt: now, grantedBy: "system:test" });
    cleanup.push(ref);
  }
  return { uid, email: `${uid}@p12e.test`, role: "analyst", displayName: `P12E ${label}`, userRef: uid };
}

// ---- Fixture builders ------------------------------------------------------------------

async function put<T extends { uid: string }>(collection: FirebaseFirestore.CollectionReference, doc: T) {
  const ref = collection.doc(doc.uid);
  await ref.set(doc);
  cleanup.push(ref);
}

type ContentOver = {
  ref: string;
  platform: "instagram" | "youtube";
  region: string;
  views?: number | null;
  likes?: number | null;
  comments?: number | null;
  engagement?: number | null;
  posted?: string | null;
  period?: { start: string; end: string } | null;
  createdAt?: string;
  partnerRef?: string | null;
  accountRef?: string | null;
  campaignRef?: string | null;
};

function contentDoc(o: ContentOver) {
  return analyticsContentSourceRecordDocSchema.parse({
    uid: `${tag}-c-${o.ref}`,
    sourceRef: `${tag}-c-${o.ref}`,
    batchRef: BATCH_REF,
    sheetName: "Posts",
    sourceRowNumber: 2,
    platform: o.platform,
    rowIdentityKey: `${tag}:c:${o.ref}`,
    rawPostId: null,
    rawPostUrl: `https://${o.platform}.example/RAW-URL-${o.ref}`,
    rawPostType: null,
    rawPostDateTime: null,
    rawMediaUrl: null,
    rawCaption: `RAW CAPTION ${o.ref} MUST NEVER LEAK`,
    rawComments: null,
    rawLikes: null,
    rawViews: null,
    rawFollowers: null,
    rawUsername: `rawuser_${o.ref}`,
    rawEngagement: null,
    rawAccountOrChannelName: null,
    normalizedUrl: null,
    postDateTimeIso: o.posted === undefined ? null : o.posted,
    comments: o.comments ?? null,
    likes: o.likes ?? null,
    views: o.views ?? null,
    profileFollowers: null,
    engagement: o.engagement ?? null,
    reportingPeriod: o.period ?? null,
    matchState: o.partnerRef ? "MATCHED" : "UNMATCHED",
    matchEvidence: { tier: o.partnerRef ? "published_url" : "none", value: null, reasonCode: null, candidateCount: o.partnerRef ? 1 : 0 },
    matchedContentRef: null,
    matchedAssignmentRef: null,
    matchedCampaignRef: o.campaignRef ?? null,
    matchedPartnerRef: o.partnerRef ?? null,
    matchedPartnerAccountRef: o.accountRef ?? null,
    ownerUid: null,
    regionIds: [o.region],
    teamIds: [],
    createdAt: o.createdAt ?? now,
  });
}

type ChannelOver = {
  ref: string;
  platform: "instagram" | "youtube";
  region: string;
  followers?: number | null;
  period?: { start: string; end: string } | null;
  createdAt?: string;
  partnerRef?: string | null;
  accountRef?: string | null;
};

function channelDoc(o: ChannelOver) {
  return analyticsChannelSourceRecordDocSchema.parse({
    uid: `${tag}-ch-${o.ref}`,
    sourceRef: `${tag}-ch-${o.ref}`,
    batchRef: BATCH_REF,
    sheetName: "Channels",
    sourceRowNumber: 3,
    platform: o.platform,
    rowIdentityKey: `${tag}:ch:${o.ref}`,
    rawUsername: `rawchannel_${o.ref}`,
    rawProfileUrl: null,
    rawPlatformAccountId: null,
    rawFollowers: null,
    rawAccountOrChannelName: null,
    normalizedProfileUrl: null,
    profileFollowers: o.followers ?? null,
    reportingPeriod: o.period ?? null,
    matchState: o.partnerRef ? "MATCHED" : "UNMATCHED",
    matchEvidence: { tier: "none", value: null, reasonCode: null, candidateCount: 0 },
    matchedPartnerRef: o.partnerRef ?? null,
    matchedPartnerAccountRef: o.accountRef ?? null,
    ownerUid: null,
    regionIds: [o.region],
    teamIds: [],
    createdAt: o.createdAt ?? now,
  });
}

// ---- Fixture identities -----------------------------------------------------------------

const P1 = `${tag}-p1`; // the Partner under test (region A)
const P2 = `${tag}-p2`; // a SECOND Partner in the SAME region (never appears in P1's view)
const P3 = `${tag}-p3`; // region B (out of the region-A actor's Partner scope)
const P_ONLY_IG = `${tag}-p-only-ig`;
const P_ENG = `${tag}-p-eng`;
const P_NONE = `${tag}-p-none`;
const P_BULK = `${tag}-p-bulk`;
const P_SEEDED = `${tag}-p-seeded-roles`;
const UNKNOWN_PARTNER = `${tag}-p-does-not-exist`;

const ACC_IG1 = `${tag}-acct-ig1`;
const ACC_IG2 = `${tag}-acct-ig2`;
const ACC_YT1 = `${tag}-acct-yt1`;
const ACC_P2_IG = `${tag}-acct-p2-ig`;

const CAMP_A = `${tag}-camp-a`;
const CAMP_B = `${tag}-camp-b`;
const NAME = {
  [P1]: `P12E Partner One ${runId}`,
  [P2]: `P12E Partner Two ${runId}`,
  [P3]: `P12E Partner Three ${runId}`,
  [P_ONLY_IG]: `P12E Only IG ${runId}`,
  [P_ENG]: `P12E Eng ${runId}`,
  [P_NONE]: `P12E None ${runId}`,
  [P_BULK]: `P12E Bulk ${runId}`,
  [P_SEEDED]: `P12E Seeded Roles ${runId}`,
} as Record<string, string>;
const CAMP_A_NAME = `P12E Campaign In Scope ${runId}`;
const CAMP_B_NAME = `P12E Campaign Out Of Scope ${runId}`;
const P1_LEGAL_NAME = `SECRET LEGAL NAME ${runId}`;
const P1_EMAIL = `secret-${runId}@restricted-partner.test`;

async function seedFixtures(): Promise<void> {
  await put(
    analyticsImportBatchesCollection(),
    analyticsImportBatchDocSchema.parse({
      uid: BATCH_REF,
      batchRef: BATCH_REF,
      targetKind: "campaign_content",
      sourceFilename: BATCH_FILENAME,
      sourceMimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      sourceExtension: "xlsx",
      sourceHash: `${tag}-hash`,
      supersedesBatchRef: null,
      reportingPeriod: null,
      actorUserRef: "p12e",
      createdAt: now,
      startedAt: now,
      completedAt: now,
      status: "COMPLETED",
      totalRows: 0,
      actionableRows: 0,
      matchedRows: 0,
      unmatchedRows: 0,
      ambiguousRows: 0,
      invalidRows: 0,
      duplicateUnchangedRows: 0,
      failedRows: 0,
      sourceSheetInventory: [],
      safeErrorSummary: [],
    }),
  );

  const partner = (ref: string, regions: string[], extra: Partial<{ legalName: string; email: string; phone: string }> = {}) =>
    partnerDocSchema.parse({
      uid: ref,
      partnerRef: ref,
      version: 1,
      displayName: NAME[ref],
      displayNameLower: NAME[ref]!.toLowerCase(),
      legalName: extra.legalName ?? null,
      status: "ACTIVE",
      previousStatus: null,
      statusReason: null,
      regionIds: regions,
      languageIds: [],
      categoryIds: [],
      tier: "Tier 1",
      priority: null,
      targetAudience: [],
      email: extra.email ?? null,
      phone: extra.phone ?? null,
      ownerUid: null,
      teamIds: [],
      originLeadRefs: [],
      sourceDiscovery: null,
      pendingPartnerAccountSetup: false,
      sequenceNumber: null,
      createdAt: now,
      createdByUserRef: "p12e",
      updatedAt: now,
      updatedByUserRef: "p12e",
    });
  await put(partnersCollection(), partner(P1, [REGION_A], { legalName: P1_LEGAL_NAME, email: P1_EMAIL, phone: "+91 90000 00097" }));
  await put(partnersCollection(), partner(P2, [REGION_A]));
  await put(partnersCollection(), partner(P3, [REGION_B]));
  await put(partnersCollection(), partner(P_ONLY_IG, [REGION_A]));
  await put(partnersCollection(), partner(P_ENG, [REGION_A]));
  await put(partnersCollection(), partner(P_NONE, [REGION_A]));
  await put(partnersCollection(), partner(P_BULK, [REGION_BULK]));
  await put(partnersCollection(), partner(P_SEEDED, [REGION_SEEDED_ROLES]));

  const account = (uid: string, partnerRef: string, platform: string, handle: string, displayName: string | null) =>
    partnerAccountDocSchema.parse({
      uid,
      partnerAccountRef: uid,
      version: 1,
      partnerRef,
      platform,
      handle,
      displayName,
      profileUrl: null,
      platformAccountId: null,
      normalizedIdentity: `${tag}:${uid}`,
      primary: false,
      status: "ACTIVE",
      followerSnapshot: null,
      originAssetDecision: null,
      originLeadRef: null,
      createdAt: now,
      createdByUserRef: "p12e",
      updatedAt: now,
      updatedByUserRef: "p12e",
    });
  await put(partnerAccountsCollection(), account(ACC_IG1, P1, "instagram", `${tag}_ig1_handle`, `P12E IG One ${runId}`));
  await put(partnerAccountsCollection(), account(ACC_IG2, P1, "instagram", `${tag}_ig2_handle`, null));
  await put(partnerAccountsCollection(), account(ACC_YT1, P1, "youtube", `${tag}_yt1_handle`, `P12E YT One ${runId}`));
  await put(partnerAccountsCollection(), account(ACC_P2_IG, P2, "instagram", `${tag}_p2_handle`, `P12E P2 Account ${runId}`));

  const campaign = (ref: string, name: string, region: string) =>
    campaignDocSchema.parse({
      uid: ref,
      campaignRef: ref,
      version: 1,
      name,
      nameLower: name.toLowerCase(),
      objective: "Step 12E scope fixture",
      status: "ACTIVE",
      statusReason: null,
      platforms: [],
      startDate: "2019-01-01",
      endDate: "2019-12-31",
      regionIds: [region],
      ownerUid: null,
      teamIds: [],
      criteria: { targetAudience: [], regionIds: [], languageIds: [], categoryIds: [], platforms: [] },
      resources: [],
      defaultReviewPolicy: "REVIEW_REQUIRED",
      createdAt: now,
      createdByUserRef: "p12e",
      updatedAt: now,
      updatedByUserRef: "p12e",
    });
  await put(campaignsCollection(), campaign(CAMP_A, CAMP_A_NAME, REGION_A));
  await put(campaignsCollection(), campaign(CAMP_B, CAMP_B_NAME, REGION_B));

  const march = { start: "2019-03-01", end: "2019-03-31" };
  const april = { start: "2019-04-01", end: "2019-04-30" };
  const contents = [
    // ---- P1, region A ----
    contentDoc({ ref: "p1-ig-1", platform: "instagram", region: REGION_A, views: 1000, likes: 100, comments: 10, engagement: 55, posted: "2019-03-10T10:00:00.000Z", period: march, partnerRef: P1, accountRef: ACC_IG1, campaignRef: CAMP_A, createdAt: "2019-04-01T00:00:00.000Z" }),
    contentDoc({ ref: "p1-ig-2", platform: "instagram", region: REGION_A, views: null, likes: 50, comments: null, engagement: null, posted: "2019-04-10T10:00:00.000Z", period: april, partnerRef: P1, accountRef: ACC_IG2, createdAt: "2019-05-01T00:00:00.000Z" }),
    // matched to the Partner but NOT to an account, and no reporting period (bucketed by import month)
    contentDoc({ ref: "p1-ig-3", platform: "instagram", region: REGION_A, views: 250, likes: null, comments: null, engagement: null, posted: "2019-05-10T10:00:00.000Z", period: null, partnerRef: P1, accountRef: null, createdAt: "2019-06-01T00:00:00.000Z" }),
    contentDoc({ ref: "p1-yt-1", platform: "youtube", region: REGION_A, views: 7123, likes: 712, comments: 71, engagement: 501, posted: "2019-03-12T10:00:00.000Z", period: march, partnerRef: P1, accountRef: ACC_YT1, campaignRef: CAMP_B, createdAt: "2019-04-02T00:00:00.000Z" }),
    contentDoc({ ref: "p1-yt-2", platform: "youtube", region: REGION_A, views: 3456, likes: null, comments: 33, engagement: null, posted: "2019-04-12T10:00:00.000Z", period: april, partnerRef: P1, accountRef: ACC_YT1, createdAt: "2019-05-02T00:00:00.000Z" }),
    // ---- P1's records that live in region B (NOT in the region-A actor's Analytics scope) ----
    contentDoc({ ref: "p1-ig-b", platform: "instagram", region: REGION_B, views: 888_002, likes: 888_003, comments: 888_004, engagement: 888_005, posted: "2019-06-01T00:00:00.000Z", period: march, partnerRef: P1 }),
    contentDoc({ ref: "p1-yt-b", platform: "youtube", region: REGION_B, views: 999_003, posted: "2019-06-02T00:00:00.000Z", period: march, partnerRef: P1 }),
    // ---- P2, SAME region A: distinctive values that must never appear in P1's view ----
    contentDoc({ ref: "p2-ig", platform: "instagram", region: REGION_A, views: 777_001, likes: 777_002, comments: 777_003, engagement: 777_004, posted: "2019-07-01T00:00:00.000Z", period: march, partnerRef: P2, accountRef: ACC_P2_IG }),
    contentDoc({ ref: "p2-yt", platform: "youtube", region: REGION_A, views: 666_001, likes: 666_002, posted: "2019-07-02T00:00:00.000Z", period: march, partnerRef: P2 }),
    // ---- P3, region B ----
    contentDoc({ ref: "p3-ig", platform: "instagram", region: REGION_B, views: 444_001, posted: "2019-07-03T00:00:00.000Z", period: march, partnerRef: P3 }),
    // ---- P_ONLY_IG: Instagram only, no reporting period; one record points at ANOTHER Partner's account ----
    contentDoc({ ref: "onlyig-1", platform: "instagram", region: REGION_A, views: 11, likes: 3, posted: "2019-08-01T00:00:00.000Z", period: null, partnerRef: P_ONLY_IG, accountRef: ACC_P2_IG, createdAt: "2019-08-05T00:00:00.000Z" }),
    contentDoc({ ref: "onlyig-2", platform: "instagram", region: REGION_A, views: 22, likes: null, posted: "2019-08-02T00:00:00.000Z", period: null, partnerRef: P_ONLY_IG, createdAt: "2019-08-06T00:00:00.000Z" }),
    // ---- P_ENG: Engagement only (no Views anywhere) ----
    contentDoc({ ref: "eng-1", platform: "instagram", region: REGION_A, views: null, engagement: 10, likes: 999_010, posted: "2019-08-03T00:00:00.000Z", period: march, partnerRef: P_ENG }),
    contentDoc({ ref: "eng-2", platform: "instagram", region: REGION_A, views: null, engagement: 99, likes: 5, posted: "2019-08-04T00:00:00.000Z", period: march, partnerRef: P_ENG }),
    // ---- P_NONE: neither Views nor Engagement ----
    contentDoc({ ref: "none-1", platform: "instagram", region: REGION_A, views: null, engagement: null, likes: 8, comments: 2, posted: "2019-08-05T00:00:00.000Z", period: march, partnerRef: P_NONE }),
  ];

  const channels = [
    // ---- P1, region A ----
    channelDoc({ ref: "p1-ig1-old", platform: "instagram", region: REGION_A, followers: 5000, period: march, partnerRef: P1, accountRef: ACC_IG1, createdAt: "2019-04-01T00:00:00.000Z" }),
    channelDoc({ ref: "p1-ig1-new", platform: "instagram", region: REGION_A, followers: 5500, period: april, partnerRef: P1, accountRef: ACC_IG1, createdAt: "2019-05-01T00:00:00.000Z" }),
    channelDoc({ ref: "p1-ig2", platform: "instagram", region: REGION_A, followers: 300, period: april, partnerRef: P1, accountRef: ACC_IG2, createdAt: "2019-05-01T00:00:00.000Z" }),
    channelDoc({ ref: "p1-yt1", platform: "youtube", region: REGION_A, followers: 9000, period: april, partnerRef: P1, accountRef: ACC_YT1, createdAt: "2019-05-01T00:00:00.000Z" }),
    // matched to the Partner but no Partner Account, no period
    channelDoc({ ref: "p1-ig-noacct", platform: "instagram", region: REGION_A, followers: 42, period: null, partnerRef: P1, accountRef: null, createdAt: "2019-05-03T00:00:00.000Z" }),
    // ---- P1, region B ----
    channelDoc({ ref: "p1-ig-b", platform: "instagram", region: REGION_B, followers: 424_242, partnerRef: P1 }),
    // ---- P2 ----
    channelDoc({ ref: "p2-ig", platform: "instagram", region: REGION_A, followers: 555_001, period: april, partnerRef: P2, accountRef: ACC_P2_IG }),
  ];

  // ---- P_BULK: 101 Instagram content records (forces the service's cursor loop past page 1) + 2 YouTube ones ----
  const huge = [
    ...Array.from({ length: 101 }, (_, i) => contentDoc({ ref: `bulk-ig-${i}`, platform: "instagram", region: REGION_BULK, views: 1, posted: "2019-09-01T00:00:00.000Z", partnerRef: P_BULK, createdAt: new Date(Date.UTC(2019, 8, 1, 0, 0, i)).toISOString() })),
    ...Array.from({ length: 2 }, (_, i) => contentDoc({ ref: `bulk-yt-${i}`, platform: "youtube", region: REGION_BULK, views: 5, posted: "2019-09-01T00:00:00.000Z", partnerRef: P_BULK, createdAt: new Date(Date.UTC(2019, 8, 1, 0, 1, i)).toISOString() })),
  ];

  const db = getAdminFirestore();
  const all: { collection: FirebaseFirestore.CollectionReference; doc: { uid: string } }[] = [
    ...contents.map((doc) => ({ collection: analyticsContentSourceRecordsCollection(), doc })),
    ...channels.map((doc) => ({ collection: analyticsChannelSourceRecordsCollection(), doc })),
    ...huge.map((doc) => ({ collection: analyticsContentSourceRecordsCollection(), doc })),
  ];
  for (let i = 0; i < all.length; i += 400) {
    const writeBatch = db.batch();
    for (const { collection, doc } of all.slice(i, i + 400)) {
      const ref = collection.doc(doc.uid);
      writeBatch.set(ref, doc);
      cleanup.push(ref);
    }
    await writeBatch.commit();
  }
}

async function partnerView(actor: ActorContext | null, partnerRef: unknown, platform?: unknown) {
  const result = await getPartnerAnalyticsView(actor, partnerRef, platform);
  if (!result.ok) throw new Error(`expected ok, got ${result.code}: ${result.message}`);
  return result.data;
}

// ---- Access: Partner Record Scope, neutral denial, explicit grants ------------------------------------

describe("Partner Analytics access - Analytics gate + live Partner Record Scope", () => {
  it("a same-scope actor sees the Partner's own data", async () => {
    const dto = await partnerView(await syntheticActor("a", REGION_A), P1);
    expect(dto.partner).toEqual({ displayName: NAME[P1] });
    expect(dto.selection).toBe("all");
    expect(dto.coverage).toEqual({ contentTruncated: false, channelTruncated: false });
    expect(dto.kpis.publishedContent).toEqual({ total: 5, byPlatform: [{ platform: "instagram", count: 3 }, { platform: "youtube", count: 2 }] });
  });

  it("a cross-scope actor and an UNKNOWN Partner get the identical neutral outcome - no name, no existence signal", async () => {
    const actorA = await syntheticActor("a", REGION_A);
    const actorB = await syntheticActor("b", REGION_B);
    const outOfScope = await getPartnerAnalyticsView(actorA, P3); // P3 exists, in region B
    const unknown = await getPartnerAnalyticsView(actorA, UNKNOWN_PARTNER);
    const otherWay = await getPartnerAnalyticsView(actorB, P1); // P1 exists, in region A
    for (const result of [outOfScope, unknown, otherWay]) {
      expect(result).toEqual({ ok: false, code: "not_found", message: PARTNER_ANALYTICS_NEUTRAL_MESSAGE });
    }
    expect(JSON.stringify([outOfScope, unknown, otherWay])).not.toContain(NAME[P3]);
    // The same neutral outcome for malformed refs.
    for (const bad of ["", 42, undefined, null, "x".repeat(500)]) expect(await getPartnerAnalyticsView(actorA, bad)).toEqual({ ok: false, code: "not_found", message: PARTNER_ANALYTICS_NEUTRAL_MESSAGE });
    // ...and the in-scope actor B can open its own Partner (knowing an id grants nothing; scope does).
    expect((await getPartnerAnalyticsView(actorB, P3)).ok).toBe(true);
  });

  it("scope is enforced BEFORE inclusion: the region-A actor never sees the Partner's records that live in region B", async () => {
    const scoped = await partnerView(await syntheticActor("a", REGION_A), P1);
    const json = JSON.stringify(scoped);
    for (const leak of [888002, 888003, 888004, 888005, 999003, 424242]) expect(jsonHasNumber(json, leak), `leaks ${leak}`).toBe(false);
    // The GLOBAL Super Admin's read of the SAME Partner includes them (7 content records: 5 + the two region-B ones).
    const admin = await partnerView(await seededActor("super_admin"), P1);
    expect(admin.kpis.publishedContent.total).toBe(7);
    expect(admin.kpis.publishedContent.total).toBeGreaterThan(scoped.kpis.publishedContent.total);
  });

  it("explicit grants only: Viewer (no explore action) and an unauthenticated caller are denied", async () => {
    const viewer = await seededActor("viewer");
    expect(await getPartnerAnalyticsView(viewer, P1)).toMatchObject({ ok: false, code: "unauthorized", reason: "action_denied" });
    expect(await getPartnerAnalyticsView(null, P1)).toMatchObject({ ok: false, code: "unauthorized", reason: "not_authenticated" });
  });

  it("Analyst, Partnership Manager, Partnership Head and Super Admin pass the gate and open a Partner inside their own scope; a Partner outside it is the neutral outcome (no rank logic)", async () => {
    for (const role of ["analyst", "partnership_manager", "partnership_head", "super_admin"]) {
      const actor = await seededActor(role);
      const inScope = await getPartnerAnalyticsView(actor, P_SEEDED);
      expect(inScope.ok, `${role} in-scope`).toBe(true);
      if (inScope.ok) {
        expect(inScope.data.partner.displayName).toBe(NAME[P_SEEDED]);
        expect(inScope.data.period.label).toBe("No source data yet"); // absence of rows: never zero performance
      }
      const outside = await getPartnerAnalyticsView(actor, P1); // region A: only the GLOBAL grant reaches it
      if (role === "super_admin") expect(outside.ok).toBe(true);
      else expect(outside, `${role} out-of-scope`).toEqual({ ok: false, code: "not_found", message: PARTNER_ANALYTICS_NEUTRAL_MESSAGE });
    }
  });

  it("the DTO exposes no restricted Partner profile field and no raw ref / uid / URL / caption / username", async () => {
    const dto = await partnerView(await syntheticActor("a", REGION_A), P1);
    const json = JSON.stringify(dto);
    for (const secret of [P1_LEGAL_NAME, P1_EMAIL, "+91 90000 00097", "RAW CAPTION", "RAW-URL-", "rawuser_", "rawchannel_", `${tag}-c-`, `${tag}-ch-`, BATCH_REF, ACC_IG1, ACC_YT1, CAMP_A, CAMP_B, "Tier 1"]) {
      // hrefs may embed the canonical partner / account ref; every other string may not carry any ref.
      const withoutHrefs = json.replace(/"[a-zA-Z]*[hH]ref":"[^"]*"/g, '"href":""');
      expect(withoutHrefs, `DTO leaks ${secret}`).not.toContain(secret);
    }
    expect(json).not.toContain("https://");
  });
});

// ---- Isolation ------------------------------------------------------------------------------------

describe("only this Partner's records - another Partner in the SAME scope never leaks", () => {
  it("Instagram and YouTube records belong only to the Partner (P2's same-region values and labels appear nowhere)", async () => {
    const actor = await syntheticActor("a", REGION_A);
    for (const platform of [undefined, "instagram", "youtube"]) {
      const dto = await partnerView(actor, P1, platform);
      const json = JSON.stringify(dto);
      for (const leak of [777001, 777002, 777003, 777004, 666001, 666002, 555001, 444001]) expect(jsonHasNumber(json, leak), `${platform ?? "all"} leaks ${leak}`).toBe(false);
      for (const name of [NAME[P2], NAME[P3], `P12E P2 Account ${runId}`]) expect(json, `${platform ?? "all"} leaks ${name}`).not.toContain(name);
    }
    // P2 really is visible to the same actor in its own view (so the exclusion above is the Partner filter's doing).
    const p2 = await partnerView(actor, P2);
    expect(p2.kpis.publishedContent.total).toBe(2);
    expect(p2.kpis.views.byPlatform.map((v) => v.total)).toEqual([777_001, 666_001]);
  });
});

// ---- Platform filter is real and server-backed -------------------------------------------------------------

describe("All / Instagram / YouTube - a real server-side filter", () => {
  it("counts and totals differ per selection, straight from the service", async () => {
    const actor = await syntheticActor("a", REGION_A);
    const all = await partnerView(actor, P1);
    const ig = await partnerView(actor, P1, "instagram");
    const yt = await partnerView(actor, P1, "youtube");

    expect([all.kpis.publishedContent.total, ig.kpis.publishedContent.total, yt.kpis.publishedContent.total]).toEqual([5, 3, 2]);
    // Views: NOT combined on All (per-platform only); each platform's own total on a single selection.
    expect(all.kpis.views).toMatchObject({ total: null, totalBasis: "not_combined" });
    expect(all.kpis.views.byPlatform.map((v) => [v.platform, v.total])).toEqual([["instagram", 1250], ["youtube", 10_579]]);
    expect(ig.kpis.views).toMatchObject({ total: 1250, totalBasis: "single_platform", recordsWithValue: 2, recordsTotal: 3 });
    expect(yt.kpis.views).toMatchObject({ total: 10_579, totalBasis: "single_platform", recordsWithValue: 2, recordsTotal: 2 });
    // Engagement is the source-reported field only (never likes + comments); Likes / Comments their own fields.
    expect(all.kpis.engagement).toMatchObject({ total: 556, totalBasis: "sum_across_platforms", recordsWithValue: 2, recordsTotal: 5 });
    expect(all.kpis.likes).toMatchObject({ total: 862, recordsWithValue: 3, recordsTotal: 5 });
    expect(all.kpis.comments).toMatchObject({ total: 114, recordsWithValue: 3, recordsTotal: 5 });
    expect(ig.kpis.engagement).toMatchObject({ total: 55 });
    expect(yt.kpis.likes).toMatchObject({ total: 712 });
    // Missing is never zero.
    expect(yt.kpis.engagement.byPlatform[0]).toMatchObject({ total: 501, recordsWithValue: 1, recordsTotal: 2 });

    // A single selection carries nothing of the other platform anywhere.
    for (const leak of [7123, 3456, 10579, 712, 9000]) expect(jsonHasNumber(JSON.stringify(ig), leak), `IG view leaks ${leak}`).toBe(false);
    for (const leak of [1000, 250, 1250, 5500, 300]) expect(jsonHasNumber(JSON.stringify(yt), leak), `YT view leaks ${leak}`).toBe(false);
    expect(ig.platformPerformance.map((c) => c.platform)).toEqual(["instagram"]);
    expect(yt.platformPerformance.map((c) => c.platform)).toEqual(["youtube"]);
    expect(all.platformPerformance.map((c) => c.platform)).toEqual(["instagram", "youtube"]);
  });

  it("the platform param is normalized (Instagram / ' YOUTUBE '); garbage and repeated params are All", async () => {
    const actor = await syntheticActor("a", REGION_A);
    expect((await partnerView(actor, P1, "Instagram")).selection).toBe("instagram");
    expect((await partnerView(actor, P1, " YOUTUBE ")).selection).toBe("youtube");
    for (const raw of ["tiktok", "insta", "", "all", ["instagram", "youtube"], undefined, 7]) expect((await partnerView(actor, P1, raw)).selection, String(raw)).toBe("all");
  });

  it("the platform AND the Partner are pushed to the accepted planner query - never fetched unfiltered and filtered in memory", async () => {
    const actor = await syntheticActor("a", REGION_A);
    const list = vi.mocked(explorerService.listAnalyticsSourceRecords);
    const calls = () => list.mock.calls.map(([, input]) => input as { recordKind: string; platform?: string; matchedPartnerRef?: string; limit?: number });

    list.mockClear();
    await partnerView(actor, P1, "instagram");
    expect(calls().length).toBeGreaterThanOrEqual(2);
    expect(calls().every((c) => c.platform === "instagram" && c.matchedPartnerRef === P1 && c.limit === 100)).toBe(true);
    expect(new Set(calls().map((c) => c.recordKind))).toEqual(new Set(["content", "channel"]));

    list.mockClear();
    await partnerView(actor, P1, "youtube");
    expect(calls().every((c) => c.platform === "youtube" && c.matchedPartnerRef === P1)).toBe(true);

    list.mockClear();
    await partnerView(actor, P1); // All: BOTH platforms, each its own filtered read, kept separate
    expect(new Set(calls().map((c) => `${c.recordKind}:${c.platform}`))).toEqual(new Set(["content:instagram", "content:youtube", "channel:instagram", "channel:youtube"]));
    expect(calls().every((c) => c.matchedPartnerRef === P1 && (c.platform === "instagram" || c.platform === "youtube"))).toBe(true);

    // A garbage platform param is All - it never reaches the planner as anything else.
    list.mockClear();
    await partnerView(actor, P1, "tiktok");
    expect(calls().every((c) => c.platform === "instagram" || c.platform === "youtube")).toBe(true);
  });

  it("cursor loop walks past page 1 (101 records) with no truncation; single-platform selections only count that platform", async () => {
    const actor = await syntheticActor("bulk", REGION_BULK);
    const ig = await partnerView(actor, P_BULK, "instagram");
    expect(ig.kpis.publishedContent.total).toBe(101);
    expect(ig.kpis.views).toMatchObject({ total: 101, recordsWithValue: 101, recordsTotal: 101 });
    expect(ig.coverage).toEqual({ contentTruncated: false, channelTruncated: false });
    expect(ig.publishedContent.total).toBe(101);
    expect(ig.publishedContent.rows).toHaveLength(10);
    expect((await partnerView(actor, P_BULK, "youtube")).kpis.publishedContent.total).toBe(2);
    expect((await partnerView(actor, P_BULK)).kpis.publishedContent.byPlatform).toEqual([{ platform: "instagram", count: 101 }, { platform: "youtube", count: 2 }]);
  });

  it("the window is honestly bounded: at most 10 pages x 100 records per kind and platform, and `truncated` is disclosed when a next cursor remains", async () => {
    const actor = await syntheticActor("a", REGION_A);
    const list = vi.mocked(explorerService.listAnalyticsSourceRecords);
    const actual = await vi.importActual<typeof import("./explorer-service")>("./explorer-service");
    list.mockClear();
    // Simulate a dataset that never ends: every page is empty but always offers a next cursor.
    list.mockImplementation(async (_actor, input) => {
      const kind = (input as { recordKind: "content" | "channel" }).recordKind;
      return { ok: true, data: { recordKind: kind, records: [], nextCursor: { main: { orderValue: "x", uid: "x" } } } } as never;
    });
    try {
      const dto = await partnerView(actor, P1, "instagram");
      expect(list.mock.calls).toHaveLength(20); // 10 pages x (content + channel) - never a true fetch-all
      expect(dto.coverage).toEqual({ contentTruncated: true, channelTruncated: true });
    } finally {
      list.mockImplementation(actual.listAnalyticsSourceRecords);
      list.mockClear();
    }
    // Restored: the real planner is back and an ordinary read is not truncated.
    expect((await partnerView(actor, P1, "instagram")).coverage).toEqual({ contentTruncated: false, channelTruncated: false });
  });
});

// ---- Platform Performance, period, accounts, content, top content, quality ------------------------------------

describe("Platform Performance and reporting period", () => {
  it("separate Instagram / YouTube series; gaps stay null; a platform with no data is an explicit no-data card", async () => {
    const actor = await syntheticActor("a", REGION_A);
    const all = await partnerView(actor, P1);
    const [ig, yt] = all.platformPerformance;
    expect(ig).toMatchObject({ platform: "instagram", hasData: true, recordCount: 3 });
    expect(ig!.trend.periods.map((p) => p.label)).toEqual(["2019-03-01 – 2019-03-31", "2019-04-01 – 2019-04-30", "Imported 2019-06"]);
    // Views: March 1000, April not reported (a GAP), the un-periodized record bucketed by its import month: 250.
    expect(ig!.trend.series.find((s) => s.metric === "views")!.values).toEqual([1000, null, 250]);
    expect(yt!.trend.series.find((s) => s.metric === "views")!.values).toEqual([7123, 3456]);

    const onlyIg = await partnerView(actor, P_ONLY_IG);
    expect(onlyIg.platformPerformance.map((c) => [c.platform, c.hasData])).toEqual([["instagram", true], ["youtube", false]]);
    expect(onlyIg.platformPerformance[1]!.trend).toEqual({ periods: [], series: [], omittedMetrics: [] });
  });

  it("the period is the span of the included records, disclosing records without one; empty is 'No source data yet'", async () => {
    const actor = await syntheticActor("a", REGION_A);
    const all = await partnerView(actor, P1);
    expect(all.period).toMatchObject({ start: "2019-03-01", end: "2019-04-30", recordsWithoutPeriod: 2 }); // ig-3 + the account-less channel record
    expect(all.period.label).toBe("All available imported periods: 2019-03-01 – 2019-04-30 · No reporting period on 2 records");
    expect((await partnerView(actor, P_ONLY_IG)).period.label).toBe("All available imported periods · No reporting period on 2 records");
    expect((await partnerView(await seededActor("analyst"), P_SEEDED)).period.label).toBe("No source data yet");
  });
});

describe("Partner Accounts - one row per canonical account, never summed", () => {
  it("two accounts on one platform stay distinct, each with its own latest snapshot; no follower total anywhere", async () => {
    const actor = await syntheticActor("a", REGION_A);
    const all = await partnerView(actor, P1);
    expect(all.partnerAccounts.totalAccounts).toBe(3);
    const ig = all.partnerAccounts.rows.filter((r) => r.platform === "instagram");
    expect(ig).toHaveLength(2);
    expect(ig.find((r) => r.accountLabel === `P12E IG One ${runId}`)).toMatchObject({ profileFollowers: 5500, snapshotCount: 2, contentRecords: 1, channelRecords: 2, reportingPeriod: { start: "2019-04-01", end: "2019-04-30" }, source: `${BATCH_FILENAME} · sheet Channels · row 3` });
    // Account 2 has no displayName - its handle is the label.
    expect(ig.find((r) => r.profileFollowers === 300)).toMatchObject({ accountLabel: `${tag}_ig2_handle`, contentRecords: 1, channelRecords: 1 });
    expect(all.partnerAccounts.rows.find((r) => r.platform === "youtube")).toMatchObject({ profileFollowers: 9000, accountLabel: `P12E YT One ${runId}` });

    const json = JSON.stringify(all);
    for (const fake of [5800, 14800, 14500, 9300, 14842]) expect(jsonHasNumber(json, fake), `fake follower total ${fake}`).toBe(false);
    expect(json).not.toMatch(/subscriber/i);
  });

  it("an Explorer link per account carries that account's own filter and platform", async () => {
    const all = await partnerView(await syntheticActor("a", REGION_A), P1);
    const yt = all.partnerAccounts.rows.find((r) => r.platform === "youtube")!;
    expect(yt.explorerHref).toBe(`/analytics/explorer?platform=youtube&recordKind=content&partnerAccountRef=${encodeURIComponent(ACC_YT1)}`);
  });

  it("a record that points at ANOTHER Partner's account never borrows that account's label", async () => {
    const dto = await partnerView(await syntheticActor("a", REGION_A), P_ONLY_IG);
    expect(dto.partnerAccounts.rows).toHaveLength(1);
    expect(dto.partnerAccounts.rows[0]).toMatchObject({ accountLabel: null, profileFollowers: null, snapshotAt: null, contentRecords: 1, channelRecords: 0 });
    expect(JSON.stringify(dto)).not.toContain(`P12E P2 Account ${runId}`);
  });
});

describe("Published Content, Top Content and Campaign labels", () => {
  it("published rows: newest first, platform-labelled, no Partner label, no raw ref, provenance like 12D", async () => {
    const dto = await partnerView(await syntheticActor("a", REGION_A), P1);
    expect(dto.publishedContent.total).toBe(5);
    expect(dto.publishedContent.rows.map((r) => [r.platform, r.views])).toEqual([["instagram", 250], ["youtube", 3456], ["instagram", null], ["youtube", 7123], ["instagram", 1000]]);
    const first = dto.publishedContent.rows.find((r) => r.views === 1000)!;
    expect(first).toMatchObject({ publishedAt: "2019-03-10T10:00:00.000Z", matchState: "MATCHED", accountLabel: `P12E IG One ${runId}`, likes: 100, comments: 10, engagement: 55, source: `${BATCH_FILENAME} · sheet Posts · row 2` });
    // A metric the source did not report is null (Unavailable), never 0.
    expect(dto.publishedContent.rows.find((r) => r.likes === 50)).toMatchObject({ views: null, comments: null, engagement: null });
    for (const row of dto.publishedContent.rows) expect(Object.keys(row)).not.toContain("partnerLabel");
    expect(dto.links.explorerContentHref).toBe(`/analytics/explorer?recordKind=content&partnerRef=${encodeURIComponent(P1)}`);
  });

  it("Campaign label present with Campaign scope, neutral (no name, no ref) without - the Analytics fact stays visible", async () => {
    const scoped = await partnerView(await syntheticActor("a", REGION_A), P1);
    // ig-1 -> Campaign A (region A: in scope). yt-1 -> Campaign B (region B: NOT in the region-A actor's Campaign scope).
    expect(scoped.publishedContent.rows.find((r) => r.views === 1000)!.campaignLabel).toBe(CAMP_A_NAME);
    const outOfScopeRow = scoped.publishedContent.rows.find((r) => r.views === 7123)!;
    expect(outOfScopeRow.campaignLabel).toBeNull();
    expect(outOfScopeRow).toMatchObject({ matchState: "MATCHED", likes: 712, comments: 71, engagement: 501 });
    expect(JSON.stringify(scoped)).not.toContain(CAMP_B_NAME);
    expect(JSON.stringify(scoped)).not.toContain(CAMP_B);

    // The same records, but this actor's grants now also name Campaign B (the dedicated CAMPAIGN grant type).
    const withGrant = await partnerView(await syntheticActor("a-camp", REGION_A, [{ type: "CAMPAIGN", campaignId: CAMP_B }]), P1);
    expect(withGrant.publishedContent.rows.find((r) => r.views === 7123)!.campaignLabel).toBe(CAMP_B_NAME);
    // Top Content rows follow the same redaction.
    expect(JSON.stringify(scoped.topContent)).not.toContain(CAMP_B_NAME);
    expect(JSON.stringify(withGrant.topContent)).toContain(CAMP_B_NAME);
  });

  it("Top Content ranks by Views WITHIN each platform on All (never across platforms), with an explicit basis note", async () => {
    const dto = await partnerView(await syntheticActor("a", REGION_A), P1);
    expect(dto.topContent.basis).toBe("views");
    expect(dto.topContent.note).toMatch(/^Ranked by Views, within each platform/);
    expect(dto.topContent.groups.map((g) => [g.platform, g.rows.map((r) => [r.rank, r.views])])).toEqual([
      ["instagram", [[1, 1000], [2, 250]]], // the record with no Views (likes only) is not ranked
      ["youtube", [[1, 7123], [2, 3456]]],
    ]);
    const single = await partnerView(await syntheticActor("a", REGION_A), P1, "youtube");
    expect(single.topContent.groups.map((g) => g.platform)).toEqual(["youtube"]);
    expect(single.topContent.note).toBe("Ranked by Views (top 5)");
  });

  it("falls back to Engagement ONLY when no record has Views (labelled), and to neutral when neither exists - never blended", async () => {
    const actor = await syntheticActor("a", REGION_A);
    const eng = await partnerView(actor, P_ENG);
    expect(eng.topContent.basis).toBe("engagement");
    expect(eng.topContent.note).toContain("Ranked by Engagement (no Views reported)");
    const rows = eng.topContent.groups.find((g) => g.platform === "instagram")!.rows;
    expect(rows.map((r) => r.engagement)).toEqual([99, 10]); // likes (999010) never substitutes for Engagement
    const none = await partnerView(actor, P_NONE);
    expect(none.topContent).toEqual({ basis: "none", note: "No content with reported Views or Engagement", groups: [] });
  });
});

describe("Data Quality / Freshness - Partner-scoped, platform-filtered", () => {
  it("linkage, records without a Partner Account, per-metric coverage, freshest import and account coverage", async () => {
    const actor = await syntheticActor("a", REGION_A);
    const ig = (await partnerView(actor, P1, "instagram")).sourceQuality;
    expect(ig.content).toEqual({ total: 3, linked: 3, unlinked: 0, ambiguous: 0, withoutAccount: 1 });
    expect(ig.channel).toEqual({ total: 4, linked: 4, unlinked: 0, ambiguous: 0, withoutAccount: 1 });
    const missing = (metric: string) => ig.missingMetrics.find((m) => m.metric === metric)!;
    expect(missing("views")).toMatchObject({ kind: "content", missing: 1, total: 3 });
    expect(missing("engagement")).toMatchObject({ missing: 2, total: 3 });
    expect(missing("profileFollowers")).toMatchObject({ kind: "channel", missing: 0, total: 4 });
    expect(ig.freshness.latestContentAt).toBe("2019-06-01T00:00:00.000Z");
    expect(ig.freshness.latestChannelAt).toBe("2019-05-03T00:00:00.000Z");
    expect(ig.accountCoverage).toEqual({ accountsTotal: 2, accountsWithSnapshots: 2, recordsWithoutAccount: 2 });

    const all = (await partnerView(actor, P1)).sourceQuality;
    expect(all.content.total).toBe(5);
    expect(all.channel.total).toBe(5);
    expect(all.accountCoverage.accountsTotal).toBe(3);
  });
});

// ---- Contextual links ---------------------------------------------------------------------------------

describe("Contextual Partner links - only where the actor may open the Partner Analytics page", () => {
  // A P3 (region B, out of the region-A actor's Partner scope) record that nevertheless sits in region A (inside its Analytics scope).
  const CROSS_REF = "cross";
  let crossSeeded = false;
  async function ensureCrossRecord() {
    if (crossSeeded) return;
    crossSeeded = true;
    await put(analyticsContentSourceRecordsCollection(), contentDoc({ ref: CROSS_REF, platform: "instagram", region: REGION_A, views: 31_337, posted: "2020-01-01T00:00:00.000Z", period: null, partnerRef: P3, createdAt: "2020-01-02T00:00:00.000Z" }));
  }

  it("Instagram / YouTube page rows carry partnerAnalyticsHref only for Partners the actor may open; others stay plain text", async () => {
    await ensureCrossRecord();
    const actor = await syntheticActor("a", REGION_A);
    const result = await getPlatformAnalyticsView(actor, "instagram");
    if (!result.ok) throw new Error("expected ok");
    const rows = result.data.publishedContent.rows;

    const p1Row = rows.find((r) => r.views === 1000)!;
    expect(p1Row.partnerLabel).toBe(NAME[P1]);
    expect(p1Row.partnerAnalyticsHref).toBe(`/analytics/partner/${encodeURIComponent(P1)}?platform=instagram`);
    // The record is in the actor's Analytics scope and shows the Partner's name (accepted 12D behaviour) - but the Partner itself is out of Partner scope: no link.
    const crossRow = rows.find((r) => r.views === 31_337)!;
    expect(crossRow.partnerLabel).toBe(NAME[P3]);
    expect(crossRow.partnerAnalyticsHref).toBeNull();
    // Partner Account rows follow the same rule.
    for (const row of result.data.partnerAccounts.rows) {
      if (row.partnerLabel === NAME[P1]) expect(row.partnerAnalyticsHref).toBe(`/analytics/partner/${encodeURIComponent(P1)}?platform=instagram`);
    }
    expect(result.data.partnerAccounts.rows.some((r) => r.partnerAnalyticsHref !== null)).toBe(true);

    const yt = await getPlatformAnalyticsView(actor, "youtube");
    if (!yt.ok) throw new Error("expected ok");
    expect(yt.data.publishedContent.rows.find((r) => r.views === 7123)!.partnerAnalyticsHref).toBe(`/analytics/partner/${encodeURIComponent(P1)}?platform=youtube`);
    // A GLOBAL actor may open every Partner.
    const global = await getPlatformAnalyticsView(await seededActor("super_admin"), "instagram");
    if (!global.ok) throw new Error("expected ok");
    expect(global.data.publishedContent.rows.every((r) => r.partnerLabel === null || r.partnerAnalyticsHref !== null)).toBe(true);
  });

  it("the link, once followed, really opens for exactly the actors that received it", async () => {
    await ensureCrossRecord();
    const actor = await syntheticActor("a", REGION_A);
    expect((await getPartnerAnalyticsView(actor, P1)).ok).toBe(true); // linked
    expect((await getPartnerAnalyticsView(actor, P3)).ok).toBe(false); // not linked
  });

  it("Data Explorer label resolution returns links only for Partners the actor may open (labels themselves are unchanged)", async () => {
    const actor = await syntheticActor("a", REGION_A);
    const result = await resolveAnalyticsLabels(actor, { partnerRefs: [P1, P3, UNKNOWN_PARTNER] });
    if (!result.ok) throw new Error("expected ok");
    expect(result.data.partners[P1]).toBe(NAME[P1]);
    expect(result.data.partners[P3]).toBe(NAME[P3]); // existing behaviour, unchanged
    expect(result.data.partnerAnalyticsLinks).toEqual({ [P1]: `/analytics/partner/${encodeURIComponent(P1)}` });

    const admin = await resolveAnalyticsLabels(await seededActor("super_admin"), { partnerRefs: [P1, P3, UNKNOWN_PARTNER] });
    if (!admin.ok) throw new Error("expected ok");
    expect(Object.keys(admin.data.partnerAnalyticsLinks ?? {}).sort()).toEqual([P1, P3].sort());

    const none = await resolveAnalyticsLabels(actor, { partnerRefs: [] });
    if (!none.ok) throw new Error("expected ok");
    expect(none.data.partnerAnalyticsLinks).toEqual({});
    // No Analytics explore access -> no labels, no links.
    expect(await resolveAnalyticsLabels(await seededActor("viewer"), { partnerRefs: [P1] })).toMatchObject({ ok: false, code: "unauthorized" });
  });
});

// ---- Explorer: real, scoped, paginated Partner / Partner Account filter -----------------------------------------------

describe("Data Explorer Partner / Partner Account filter - real, scoped and cursor-paginated", () => {
  it("matchedPartnerRef filters server-side and paginates with a cursor (no duplicates, no other Partner)", async () => {
    const actor = await syntheticActor("a", REGION_A);
    const seen: string[] = [];
    let cursor: Record<string, unknown> | undefined;
    let pages = 0;
    for (let guard = 0; guard < 10; guard++) {
      const result = await listAnalyticsSourceRecords(actor, { recordKind: "content", matchedPartnerRef: P1, limit: 2, cursor });
      if (!result.ok || result.data.recordKind !== "content") throw new Error("expected ok content page");
      pages++;
      for (const record of result.data.records) {
        expect(record.matchedPartnerRef).toBe(P1);
        seen.push(record.sourceRef);
      }
      if (!result.data.nextCursor) break;
      cursor = result.data.nextCursor as Record<string, unknown>;
    }
    expect(pages).toBe(3); // 5 in-scope P1 content records at 2 per page: 2 + 2 + 1
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
  });

  it("matchedPartnerAccountRef filters to exactly that account; channel records too", async () => {
    const actor = await syntheticActor("a", REGION_A);
    const content = await listAnalyticsSourceRecords(actor, { recordKind: "content", matchedPartnerAccountRef: ACC_YT1, limit: 100 });
    if (!content.ok) throw new Error("expected ok");
    expect(content.data.records.map((r) => r.matchedPartnerAccountRef)).toEqual([ACC_YT1, ACC_YT1]);
    const channel = await listAnalyticsSourceRecords(actor, { recordKind: "channel", matchedPartnerAccountRef: ACC_IG1, limit: 100 });
    if (!channel.ok) throw new Error("expected ok");
    expect(channel.data.records).toHaveLength(2);
    expect(channel.data.records.every((r) => r.matchedPartnerAccountRef === ACC_IG1)).toBe(true);
  });

  it("a ref the actor cannot see yields NO rows - the planner scopes before retrieval, nothing leaks", async () => {
    // Actor B (region B) filtering by P2 / P2's account: P2's records live only in region A.
    const actorB = await syntheticActor("b", REGION_B);
    for (const input of [{ matchedPartnerRef: P2 }, { matchedPartnerAccountRef: ACC_P2_IG }]) {
      const content = await listAnalyticsSourceRecords(actorB, { recordKind: "content", limit: 100, ...input });
      const channel = await listAnalyticsSourceRecords(actorB, { recordKind: "channel", limit: 100, ...input });
      expect(content.ok && content.data.records).toEqual([]);
      expect(channel.ok && channel.data.records).toEqual([]);
    }
    // And no access at all -> denied, not empty.
    expect(await listAnalyticsSourceRecords(await seededActor("viewer"), { recordKind: "content", matchedPartnerRef: P1 })).toMatchObject({ ok: false, code: "unauthorized" });
  });
});

// ---- No Finance write / coupling ------------------------------------------------------------------------------

describe("Partner Analytics is read-only and finance-free", () => {
  it("viewing it writes nothing: no Finance-shaped collection appears and Analytics documents are unchanged", async () => {
    const db = getAdminFirestore();
    const probe = async () => (await db.listCollections()).map((c) => c.id).filter((id) => /finance|payout|invoice|agreement/i.test(id) && !/^finance(Agreements|AgreementClaims|ContractArtifacts|AgreementRestrictedExtractions)$/.test(id)); // (the Step 14A Agreement roots are created concurrently by other files)
    const before = await probe();
    const actor = await syntheticActor("a", REGION_A);
    await partnerView(actor, P1);
    await partnerView(actor, P1, "instagram");
    const after = await probe();
    expect(after).toEqual(before);
    const record = await analyticsContentSourceRecordsCollection().doc(`${tag}-c-p1-ig-1`).get();
    expect(record.data()).toMatchObject({ views: 1000, matchedPartnerRef: P1, correctionRevision: 1 });
  });
});
