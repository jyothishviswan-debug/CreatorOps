// Step 12D - real reads/writes against the running Firestore/Auth emulator (no
// mocks): the separate Instagram / YouTube Analytics views and the Data
// Explorer's normalized platform filter. Run with `pnpm test:emulator` against
// a running `pnpm firebase:emulators`.
//
// Hermetic by construction (same idiom as partner-reviews.emulator.test.ts):
// every fixture doc is written schema-valid via the Admin SDK with a private
// region / unique refs, and every fixture doc is deleted afterwards. Exact
// assertions are made through SYNTHETIC scoped actors whose only scope grant
// is one private region, so they see precisely their own fixtures no matter
// what other files have seeded; the seeded actors (Viewer/Analyst/Manager/
// Head/Super Admin) are used for the explicit-grant behavior, and only
// relational assertions (never exact totals) are made through the GLOBAL
// Super Admin, whose reads other files' data can legitimately inflate.
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

import { requireAnalyticsExploreAccess, requireImportsModuleAccess } from "./analytics-gate";
import { listAnalyticsSourceRecords } from "./explorer-service";
import { analyticsChannelSourceRecordsCollection, analyticsContentSourceRecordsCollection, analyticsImportBatchesCollection } from "./firestore";
import { getPlatformAnalyticsView } from "./platform-view-service";
import { analyticsChannelSourceRecordDocSchema, analyticsContentSourceRecordDocSchema, analyticsImportBatchDocSchema } from "./types";

vi.setConfig({ testTimeout: 60_000 });

const uidByRole = new Map<string, string>();
const runId = Date.now();
const tag = `p12d-${runId}`;
const REGION_A = `${tag}-region-a`;
const REGION_B = `${tag}-region-b`;
const REGION_PAGES = `${tag}-region-pages`;
const REGION_BULK = `${tag}-region-bulk`;
const BATCH_REF = `${tag}-batch`;
const BATCH_FILENAME = `${tag}-export.xlsx`;
const now = new Date().toISOString();

// Numeric "must not appear" sentinels are matched as JSON NUMBER values (right
// after `:` `,` or `[`, right before `,` `}` or `]`), never as a raw substring:
// the serialized DTO also carries labels built from `Date.now()` (`tag`), whose
// digits can legitimately contain any short number (a plain `toContain("3456")`
// failed ~1 run in 8 for exactly that reason).
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
}, 60_000);

afterAll(async () => {
  // Batched deletes (a few hundred fixture docs at most).
  const db = getAdminFirestore();
  for (let i = 0; i < cleanup.length; i += 400) {
    const batch = db.batch();
    for (const ref of cleanup.slice(i, i + 400)) batch.delete(ref);
    await batch.commit();
  }
}, 60_000);

async function seededActor(role: string): Promise<ActorContext> {
  const uid = uidByRole.get(role);
  if (!uid) throw new Error(`No seeded uid for role ${role}`);
  const actor = await resolveActor(uid);
  if (!actor) throw new Error(`resolveActor returned null for seeded role ${role}`);
  return actor;
}

// A synthetic actor: the Analyst ROLE baseline (analytics explore + partners/
// campaigns features - all from the seeded accessGrants/analyst document) with
// a private-region scope grant (plus any extra grant a test names). It has no users/ document; every authz path
// this test exercises reads only the role grant, the (absent) override doc and
// the scopeAssignments grants written below.
async function syntheticActor(label: string, region: string, extraGrants: ScopeGrantInput[] = []): Promise<ActorContext> {
  const uid = `${tag}-actor-${label}`;
  for (const input of [{ type: "REGION", region } as ScopeGrantInput, ...extraGrants]) {
    const ref = getAdminFirestore().collection(COLLECTIONS.scopeAssignments).doc(scopeGrantDocId(uid, input));
    await ref.set({ ...input, uid, grantedAt: now, grantedBy: "system:test" });
    cleanup.push(ref);
  }
  return { uid, email: `${uid}@p12d.test`, role: "analyst", displayName: `P12D ${label}`, userRef: uid };
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
  matchState?: "MATCHED" | "UNMATCHED" | "AMBIGUOUS";
  partnerRef?: string | null;
  accountRef?: string | null;
  campaignRef?: string | null;
};

function contentDoc(o: ContentOver) {
  const matched = (o.matchState ?? "UNMATCHED") === "MATCHED";
  return analyticsContentSourceRecordDocSchema.parse({
    uid: `${tag}-c-${o.ref}`,
    sourceRef: `${tag}-c-${o.ref}`,
    batchRef: BATCH_REF,
    sheetName: "Posts",
    sourceRowNumber: 2,
    platform: o.platform,
    rowIdentityKey: `${tag}:c:${o.ref}`,
    rawPostId: null,
    rawPostUrl: `https://${o.platform}.example/raw-url-${o.ref}`,
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
    matchState: o.matchState ?? "UNMATCHED",
    matchEvidence: { tier: matched ? "published_url" : "none", value: null, reasonCode: null, candidateCount: matched ? 1 : 0 },
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
  matchState?: "MATCHED" | "UNMATCHED" | "AMBIGUOUS";
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
    matchState: o.matchState ?? "UNMATCHED",
    matchEvidence: { tier: "none", value: null, reasonCode: null, candidateCount: 0 },
    matchedPartnerRef: o.partnerRef ?? null,
    matchedPartnerAccountRef: o.accountRef ?? null,
    ownerUid: null,
    regionIds: [o.region],
    teamIds: [],
    createdAt: o.createdAt ?? now,
  });
}

const PARTNER_REF = `${tag}-partner`;
const ACCOUNT_IG = `${tag}-acct-ig`;
const ACCOUNT_IG2 = `${tag}-acct-ig2`;
const ACCOUNT_YT = `${tag}-acct-yt`;
const CAMPAIGN_A_REF = `${tag}-camp-a`;
const CAMPAIGN_B_REF = `${tag}-camp-b`;
const PARTNER_NAME = `P12D Partner ${runId}`;
const CAMPAIGN_A_NAME = `P12D Campaign In Scope ${runId}`;
const CAMPAIGN_B_NAME = `P12D Campaign Out Of Scope ${runId}`;

async function seedFixtures(): Promise<void> {
  // Import batch (provenance label).
  const batch = analyticsImportBatchDocSchema.parse({
    uid: BATCH_REF,
    batchRef: BATCH_REF,
    targetKind: "campaign_content",
    sourceFilename: BATCH_FILENAME,
    sourceMimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    sourceExtension: "xlsx",
    sourceHash: `${tag}-hash`,
    supersedesBatchRef: null,
    reportingPeriod: null,
    actorUserRef: "p12d",
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
  });
  await put(analyticsImportBatchesCollection(), batch);

  // Partner + Partner Accounts (labels).
  const partner = partnerDocSchema.parse({
    uid: PARTNER_REF,
    partnerRef: PARTNER_REF,
    version: 1,
    displayName: PARTNER_NAME,
    displayNameLower: PARTNER_NAME.toLowerCase(),
    legalName: null,
    status: "ACTIVE",
    previousStatus: null,
    statusReason: null,
    regionIds: [REGION_A],
    languageIds: [],
    categoryIds: [],
    tier: null,
    priority: null,
    targetAudience: [],
    email: `${tag}@example-partner.test`,
    phone: "+91 90000 00098",
    ownerUid: null,
    teamIds: [],
    originLeadRefs: [],
    sourceDiscovery: null,
    pendingPartnerAccountSetup: false,
    sequenceNumber: null,
    createdAt: now,
    createdByUserRef: "p12d",
    updatedAt: now,
    updatedByUserRef: "p12d",
  });
  await put(partnersCollection(), partner);

  const account = (uid: string, platform: string, handle: string, displayName: string | null) =>
    partnerAccountDocSchema.parse({
      uid,
      partnerAccountRef: uid,
      version: 1,
      partnerRef: PARTNER_REF,
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
      createdByUserRef: "p12d",
      updatedAt: now,
      updatedByUserRef: "p12d",
    });
  await put(partnerAccountsCollection(), account(ACCOUNT_IG, "instagram", `${tag}_ig_handle`, `P12D IG Account ${runId}`));
  await put(partnerAccountsCollection(), account(ACCOUNT_IG2, "instagram", `${tag}_ig2_handle`, null));
  await put(partnerAccountsCollection(), account(ACCOUNT_YT, "youtube", `${tag}_yt_handle`, `P12D YT Channel ${runId}`));

  // Campaigns: A in region A (in scope for the region-A actor), B in region B (out of scope for it).
  const campaign = (ref: string, name: string, region: string) => {
    const uid = ref;
    return campaignDocSchema.parse({
      uid,
      campaignRef: ref,
      version: 1,
      name,
      nameLower: name.toLowerCase(),
      objective: "Step 12D scope fixture",
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
      createdByUserRef: "p12d",
      updatedAt: now,
      updatedByUserRef: "p12d",
    });
  };
  await put(campaignsCollection(), campaign(CAMPAIGN_A_REF, CAMPAIGN_A_NAME, REGION_A));
  await put(campaignsCollection(), campaign(CAMPAIGN_B_REF, CAMPAIGN_B_NAME, REGION_B));

  const march = { start: "2019-03-01", end: "2019-03-31" };
  const april = { start: "2019-04-01", end: "2019-04-30" };
  const contents = [
    // ---- region A ----
    contentDoc({ ref: "ig-a1", platform: "instagram", region: REGION_A, views: 1000, likes: 100, comments: 10, engagement: 55, posted: "2019-03-10T10:00:00.000Z", period: march, matchState: "MATCHED", partnerRef: PARTNER_REF, accountRef: ACCOUNT_IG, campaignRef: CAMPAIGN_A_REF, createdAt: "2019-04-01T00:00:00.000Z" }),
    contentDoc({ ref: "ig-a2", platform: "instagram", region: REGION_A, views: null, likes: 50, comments: null, engagement: null, posted: "2019-04-10T10:00:00.000Z", period: april, matchState: "UNMATCHED", createdAt: "2019-05-01T00:00:00.000Z" }),
    contentDoc({ ref: "yt-a1", platform: "youtube", region: REGION_A, views: 7123, likes: 712, comments: 71, engagement: 501, posted: "2019-03-12T10:00:00.000Z", period: march, matchState: "MATCHED", partnerRef: PARTNER_REF, accountRef: ACCOUNT_YT, campaignRef: CAMPAIGN_B_REF, createdAt: "2019-04-02T00:00:00.000Z" }),
    contentDoc({ ref: "yt-a2", platform: "youtube", region: REGION_A, views: 3456, likes: null, comments: 33, engagement: null, posted: "2019-04-12T10:00:00.000Z", period: april, matchState: "UNMATCHED", createdAt: "2019-05-02T00:00:00.000Z" }),
    // ---- region B (out of scope for the region-A actor; distinctive magnitudes) ----
    contentDoc({ ref: "ig-b1", platform: "instagram", region: REGION_B, views: 999_999, likes: 888_888, comments: 777_777, engagement: 666_666, posted: "2019-06-01T00:00:00.000Z", period: march, matchState: "UNMATCHED" }),
    contentDoc({ ref: "yt-b1", platform: "youtube", region: REGION_B, views: 555_555, posted: "2019-06-02T00:00:00.000Z", period: march, matchState: "UNMATCHED" }),
  ];
  const channels = [
    // ---- region A ----
    channelDoc({ ref: "ig-a1-old", platform: "instagram", region: REGION_A, followers: 5000, period: march, matchState: "MATCHED", partnerRef: PARTNER_REF, accountRef: ACCOUNT_IG, createdAt: "2019-04-01T00:00:00.000Z" }),
    channelDoc({ ref: "ig-a1-new", platform: "instagram", region: REGION_A, followers: 5500, period: april, matchState: "MATCHED", partnerRef: PARTNER_REF, accountRef: ACCOUNT_IG, createdAt: "2019-05-01T00:00:00.000Z" }),
    channelDoc({ ref: "ig-a2", platform: "instagram", region: REGION_A, followers: 300, period: april, matchState: "MATCHED", partnerRef: PARTNER_REF, accountRef: ACCOUNT_IG2, createdAt: "2019-05-01T00:00:00.000Z" }),
    channelDoc({ ref: "ig-a3-unmatched", platform: "instagram", region: REGION_A, followers: 42, matchState: "UNMATCHED" }),
    channelDoc({ ref: "ig-a4-ambiguous", platform: "instagram", region: REGION_A, followers: null, matchState: "AMBIGUOUS" }),
    channelDoc({ ref: "yt-a1", platform: "youtube", region: REGION_A, followers: 9000, period: april, matchState: "MATCHED", partnerRef: PARTNER_REF, accountRef: ACCOUNT_YT, createdAt: "2019-05-01T00:00:00.000Z" }),
    // ---- region B ----
    channelDoc({ ref: "ig-b1", platform: "instagram", region: REGION_B, followers: 424_242, matchState: "UNMATCHED" }),
  ];

  // ---- pagination fixtures: 12 instagram + 12 youtube content records interleaved in createdAt ----
  const pageContents: ReturnType<typeof contentDoc>[] = [];
  for (let i = 0; i < 12; i++) {
    const stamp = (n: number) => `2019-07-${String(n).padStart(2, "0")}T00:00:00.000Z`;
    pageContents.push(contentDoc({ ref: `pg-ig-${i}`, platform: "instagram", region: REGION_PAGES, views: 1, createdAt: stamp(i * 2 + 1) }));
    pageContents.push(contentDoc({ ref: `pg-yt-${i}`, platform: "youtube", region: REGION_PAGES, views: 1, createdAt: stamp(i * 2 + 2) }));
  }
  const pageChannels = [channelDoc({ ref: "pg-ch-ig", platform: "instagram", region: REGION_PAGES, followers: 1 }), channelDoc({ ref: "pg-ch-yt", platform: "youtube", region: REGION_PAGES, followers: 1 })];

  // ---- bulk fixtures: 101 instagram content records (forces the service's cursor loop past page 1) ----
  const bulk = Array.from({ length: 101 }, (_, i) => contentDoc({ ref: `bulk-${i}`, platform: "instagram", region: REGION_BULK, views: 1, createdAt: new Date(Date.UTC(2019, 8, 1, 0, 0, i)).toISOString() }));

  const db = getAdminFirestore();
  const all: { collection: FirebaseFirestore.CollectionReference; doc: { uid: string } }[] = [
    ...contents.map((doc) => ({ collection: analyticsContentSourceRecordsCollection(), doc })),
    ...channels.map((doc) => ({ collection: analyticsChannelSourceRecordsCollection(), doc })),
    ...pageContents.map((doc) => ({ collection: analyticsContentSourceRecordsCollection(), doc })),
    ...pageChannels.map((doc) => ({ collection: analyticsChannelSourceRecordsCollection(), doc })),
    ...bulk.map((doc) => ({ collection: analyticsContentSourceRecordsCollection(), doc })),
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

// ---- Instagram vs YouTube isolation, scope before inclusion ------------------------------------

describe("platform views - only the requested platform, only in-scope records", () => {
  it("Instagram view (region-A actor): only Instagram records, platform-specific counts, out-of-scope records never leak", async () => {
    const actor = await syntheticActor("a", REGION_A);
    const result = await getPlatformAnalyticsView(actor, "instagram");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const dto = result.data;

    expect(dto.platform).toBe("instagram");
    expect(dto.coverage).toEqual({ contentTruncated: false, channelTruncated: false });
    // Published Content: exactly the 2 Instagram region-A records - not the 2 YouTube ones, not region B's.
    expect(dto.kpis.publishedContent).toBe(2);
    expect(dto.publishedContent.total).toBe(2);
    expect(dto.publishedContent.rows).toHaveLength(2);
    // Views = views ONLY (one of two records reported it); Engagement = source-reported ONLY (never likes + comments).
    expect(dto.kpis.views).toEqual({ total: 1000, recordsWithValue: 1, recordsTotal: 2 });
    expect(dto.kpis.engagement).toEqual({ total: 55, recordsWithValue: 1, recordsTotal: 2 });
    expect(dto.kpis.likes).toEqual({ total: 150, recordsWithValue: 2, recordsTotal: 2 });
    expect(dto.kpis.comments).toEqual({ total: 10, recordsWithValue: 1, recordsTotal: 2 });

    // Nothing from YouTube or from the out-of-scope region B appears anywhere in the DTO.
    const json = JSON.stringify(dto);
    for (const leak of ["7123", "3456", "10579", "999999", "888888", "777777", "666666", "555555", "424242"]) expect(jsonHasNumber(json, leak), `leaks ${leak}`).toBe(false);
    expect(json, `leaks ${CAMPAIGN_B_NAME}`).not.toContain(CAMPAIGN_B_NAME);
  });

  it("YouTube view (region-A actor): only YouTube records", async () => {
    const actor = await syntheticActor("a", REGION_A);
    const result = await getPlatformAnalyticsView(actor, "youtube");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const dto = result.data;
    expect(dto.platform).toBe("youtube");
    expect(dto.kpis.publishedContent).toBe(2);
    expect(dto.kpis.views).toEqual({ total: 10_579, recordsWithValue: 2, recordsTotal: 2 });
    expect(dto.kpis.engagement).toEqual({ total: 501, recordsWithValue: 1, recordsTotal: 2 });
    expect(dto.kpis.likes).toEqual({ total: 712, recordsWithValue: 1, recordsTotal: 2 });
    expect(dto.kpis.comments).toEqual({ total: 104, recordsWithValue: 2, recordsTotal: 2 });
    // Instagram's values (1000 views / 100 likes / 5000+ followers) never appear.
    const json = JSON.stringify(dto);
    for (const leak of ["5500", "999999", "888888", "424242"]) expect(jsonHasNumber(json, leak), `leaks ${leak}`).toBe(false);
  });

  it("a region-B actor sees only region-B records (scope enforced before inclusion)", async () => {
    const actor = await syntheticActor("b", REGION_B);
    const result = await getPlatformAnalyticsView(actor, "instagram");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.kpis.publishedContent).toBe(1);
    expect(result.data.kpis.views.total).toBe(999_999);
    const json = JSON.stringify(result.data);
    expect(json).not.toContain(PARTNER_NAME);
  });

  it("the GLOBAL actor sees the same platform in strictly larger scope", async () => {
    const admin = await seededActor("super_admin");
    const a = await syntheticActor("a", REGION_A);
    const b = await syntheticActor("b", REGION_B);
    const [global, scopedA, scopedB] = await Promise.all([getPlatformAnalyticsView(admin, "instagram"), getPlatformAnalyticsView(a, "instagram"), getPlatformAnalyticsView(b, "instagram")]);
    expect(global.ok && scopedA.ok && scopedB.ok).toBe(true);
    if (!global.ok || !scopedA.ok || !scopedB.ok) return;
    expect(global.data.kpis.publishedContent).toBeGreaterThanOrEqual(scopedA.data.kpis.publishedContent + scopedB.data.kpis.publishedContent);
    expect(global.data.kpis.views.total!).toBeGreaterThanOrEqual(1000 + 999_999);
    expect(global.data.sourceQuality.content.total).toBeGreaterThan(scopedA.data.sourceQuality.content.total);
  });
});

// ---- Published Content rows ---------------------------------------------------------------------

describe("Published Content rows - safe context, newest first", () => {
  it("newest posted first, with Partner / Account / authorized Campaign labels, provenance and no raw refs", async () => {
    const actor = await syntheticActor("a", REGION_A);
    const result = await getPlatformAnalyticsView(actor, "instagram");
    if (!result.ok) throw new Error("expected ok");
    const [newest, older] = result.data.publishedContent.rows;

    // ig-a2 (posted 2019-04-10, unmatched) is newer than ig-a1 (2019-03-10, matched).
    expect(newest).toMatchObject({ publishedAt: "2019-04-10T10:00:00.000Z", matchState: "UNMATCHED", partnerLabel: null, accountLabel: null, campaignLabel: null, views: null, likes: 50, comments: null, engagement: null });
    expect(older).toMatchObject({
      publishedAt: "2019-03-10T10:00:00.000Z",
      matchState: "MATCHED",
      partnerLabel: PARTNER_NAME,
      accountLabel: `P12D IG Account ${runId}`,
      // Campaign A (region A) is inside this actor's Campaign Record Scope.
      campaignLabel: CAMPAIGN_A_NAME,
      views: 1000,
      likes: 100,
      comments: 10,
      engagement: 55,
      source: `${BATCH_FILENAME} · sheet Posts · row 2`,
    });

    const json = JSON.stringify(result.data);
    for (const secret of [`${tag}-c-`, `${tag}-ch-`, PARTNER_REF, ACCOUNT_IG, CAMPAIGN_A_REF, BATCH_REF, "RAW CAPTION", "rawuser_", "rawchannel_"]) expect(json, `DTO leaks ${secret}`).not.toContain(secret);
  });

  it("Campaign label is ABSENT when the Campaign is outside the actor's Campaign Record Scope, present once a CAMPAIGN grant names it", async () => {
    // yt-a1 (region A: in scope) is matched to Campaign B (region B: NOT in the region-A actor's scope).
    const scoped = await getPlatformAnalyticsView(await syntheticActor("a", REGION_A), "youtube");
    if (!scoped.ok) throw new Error("expected ok");
    const scopedRow = scoped.data.publishedContent.rows.find((r) => r.views === 7123)!;
    expect(scopedRow).toBeDefined();
    expect(scopedRow.matchState).toBe("MATCHED");
    expect(scopedRow.partnerLabel).toBe(PARTNER_NAME); // the record and Partner are visible...
    expect(scopedRow.campaignLabel).toBeNull(); // ...the out-of-scope Campaign's name is not
    expect(JSON.stringify(scoped.data)).not.toContain(CAMPAIGN_B_NAME);

    // The SAME records, but this actor's grants now also name Campaign B (the dedicated CAMPAIGN grant type).
    const withGrant = await getPlatformAnalyticsView(await syntheticActor("a-camp", REGION_A, [{ type: "CAMPAIGN", campaignId: CAMPAIGN_B_REF }]), "youtube");
    if (!withGrant.ok) throw new Error("expected ok");
    expect(withGrant.data.publishedContent.rows.find((r) => r.views === 7123)!.campaignLabel).toBe(CAMPAIGN_B_NAME);
  });

  it("is bounded to a small fixed page with the true platform total disclosed", async () => {
    const actor = await syntheticActor("bulk", REGION_BULK);
    const result = await getPlatformAnalyticsView(actor, "instagram");
    if (!result.ok) throw new Error("expected ok");
    // 101 records need TWO 100-record pages of the bounded cursor loop - all are counted...
    expect(result.data.kpis.publishedContent).toBe(101);
    expect(result.data.kpis.views).toEqual({ total: 101, recordsWithValue: 101, recordsTotal: 101 });
    expect(result.data.coverage.contentTruncated).toBe(false);
    // ...but only a fixed page of rows is returned.
    expect(result.data.publishedContent.total).toBe(101);
    expect(result.data.publishedContent.rows).toHaveLength(10);
  });
});

// ---- Partner Accounts ------------------------------------------------------------------------------

describe("Partner Accounts - latest snapshot per account, never summed", () => {
  it("one row per matched account with its own latest snapshot; unmatched/ambiguous are counted in Source Quality only", async () => {
    const actor = await syntheticActor("a", REGION_A);
    const result = await getPlatformAnalyticsView(actor, "instagram");
    if (!result.ok) throw new Error("expected ok");
    const { partnerAccounts, sourceQuality } = result.data;

    expect(partnerAccounts.totalAccounts).toBe(2);
    expect(partnerAccounts.rows).toHaveLength(2);
    const main = partnerAccounts.rows.find((r) => r.accountLabel === `P12D IG Account ${runId}`)!;
    expect(main).toMatchObject({ profileFollowers: 5500, partnerLabel: PARTNER_NAME, snapshotCount: 2, reportingPeriod: { start: "2019-04-01", end: "2019-04-30" }, source: `${BATCH_FILENAME} · sheet Channels · row 3` });
    // Account 2 has no displayName - its handle is the label.
    expect(partnerAccounts.rows.find((r) => r.profileFollowers === 300)!.accountLabel).toBe(`${tag}_ig2_handle`);

    // No platform-wide follower figure exists anywhere: 5500 + 300 (= 5800), 5000 + 5500 + 300 (= 10800) etc.
    const json = JSON.stringify(result.data);
    for (const fake of ["5800", "10800", "5342", "5842"]) expect(jsonHasNumber(json, fake), `fake follower total ${fake}`).toBe(false);

    // Unlinked (1) + ambiguous (1) channel records are counted, not shown with invented names.
    expect(sourceQuality.channel).toEqual({ total: 5, linked: 3, unlinked: 1, ambiguous: 1 });
    expect(partnerAccounts.rows.every((r) => r.accountLabel !== null)).toBe(true);
  });

  it("YouTube shows its own channel snapshot as PROFILE followers (not relabelled), Instagram accounts never appear", async () => {
    const actor = await syntheticActor("a", REGION_A);
    const result = await getPlatformAnalyticsView(actor, "youtube");
    if (!result.ok) throw new Error("expected ok");
    expect(result.data.partnerAccounts.rows).toHaveLength(1);
    expect(result.data.partnerAccounts.rows[0]).toMatchObject({ profileFollowers: 9000, accountLabel: `P12D YT Channel ${runId}` });
    expect(JSON.stringify(result.data)).not.toMatch(/subscriber/i);
  });
});

// ---- Source Quality / trend ------------------------------------------------------------------------

describe("Source Quality and Native Metric Trend", () => {
  it("reports linked / unlinked / ambiguous, per-metric missing counts and freshness for the platform only", async () => {
    const result = await getPlatformAnalyticsView(await syntheticActor("a", REGION_A), "instagram");
    if (!result.ok) throw new Error("expected ok");
    const { sourceQuality } = result.data;
    expect(sourceQuality.content).toEqual({ total: 2, linked: 1, unlinked: 1, ambiguous: 0 });
    const missing = (metric: string) => sourceQuality.missingMetrics.find((m) => m.metric === metric)!;
    expect(missing("views")).toMatchObject({ kind: "content", missing: 1, total: 2 });
    expect(missing("engagement")).toMatchObject({ missing: 1, total: 2 });
    expect(missing("likes")).toMatchObject({ missing: 0, total: 2 });
    expect(missing("profileFollowers")).toMatchObject({ kind: "channel", missing: 1, total: 5 });
    expect(sourceQuality.freshness.latestContentAt).toBe("2019-05-01T00:00:00.000Z");
  });

  it("trend gaps stay null (never zero) and a metric reported in one period is not plotted", async () => {
    const result = await getPlatformAnalyticsView(await syntheticActor("a", REGION_A), "youtube");
    if (!result.ok) throw new Error("expected ok");
    const { trend } = result.data;
    expect(trend.periods.map((p) => p.label)).toEqual(["2019-03-01 – 2019-03-31", "2019-04-01 – 2019-04-30"]);
    // Views 7123 (March) -> 3456 (April); Comments 71 -> 33. Likes only in March, Engagement only in March: omitted.
    expect(trend.series.find((s) => s.metric === "views")!.values).toEqual([7123, 3456]);
    expect(trend.series.find((s) => s.metric === "comments")!.values).toEqual([71, 33]);
    expect(trend.series.map((s) => s.metric)).toEqual(["views", "comments"]);
    expect(trend.omittedMetrics).toEqual(["engagement", "likes"]);
    for (const s of trend.series) expect(s.values.every((v) => v === null || v > 0)).toBe(true);
  });
});

// ---- Explicit grants / access ------------------------------------------------------------------------

describe("Analytics read access is exactly the Overview/Explorer gate - explicit grants, no rank logic, no Import Center access", () => {
  it("Viewer (no explore action) is denied; an unauthenticated caller is denied", async () => {
    const viewer = await seededActor("viewer");
    expect(await requireAnalyticsExploreAccess(viewer)).toEqual({ ok: false, reason: "action_denied" });
    const denied = await getPlatformAnalyticsView(viewer, "instagram");
    expect(denied).toMatchObject({ ok: false, code: "unauthorized", reason: "action_denied" });
    const anonymous = await getPlatformAnalyticsView(null, "instagram");
    expect(anonymous).toMatchObject({ ok: false, code: "unauthorized", reason: "not_authenticated" });
  });

  it("Analyst, Partnership Manager, Partnership Head and Super Admin can read the platform views (each per its own scope)", async () => {
    for (const role of ["analyst", "partnership_manager", "partnership_head", "super_admin"]) {
      const actor = await seededActor(role);
      for (const platform of ["instagram", "youtube"] as const) {
        const result = await getPlatformAnalyticsView(actor, platform);
        expect(result.ok, `${role} ${platform}`).toBe(true);
        if (result.ok) expect(result.data.platform).toBe(platform);
      }
    }
  });

  it("no seeded scoped actor sees another scope's private fixtures (only the GLOBAL Super Admin's scope includes them)", async () => {
    for (const role of ["analyst", "partnership_manager", "partnership_head"]) {
      const result = await getPlatformAnalyticsView(await seededActor(role), "instagram");
      if (!result.ok) throw new Error("expected ok");
      const json = JSON.stringify(result.data);
      expect(json, role).not.toContain(PARTNER_NAME);
      expect(json, role).not.toContain(BATCH_FILENAME);
      expect(jsonHasNumber(json, 999999), role).toBe(false);
    }
  });

  it("platform views do NOT grant Import Center access: a Manager reads them yet holds no Import Center module access", async () => {
    const manager = await seededActor("partnership_manager");
    const result = await getPlatformAnalyticsView(manager, "instagram");
    expect(result.ok).toBe(true);
    expect(await requireImportsModuleAccess(manager)).toEqual({ ok: false, reason: "feature_denied" });
    if (result.ok) expect(JSON.stringify(Object.keys(result.data))).not.toMatch(/import/i);
  });
});

// ---- Platform input validation ---------------------------------------------------------------------------

describe("platform input - normalized with the shared contract, closed to instagram/youtube", () => {
  it("accepts casing/whitespace variants (normalized) and rejects other platforms and near-misses", async () => {
    const admin = await seededActor("super_admin");
    const variants = await Promise.all([getPlatformAnalyticsView(admin, "Instagram"), getPlatformAnalyticsView(admin, " YOUTUBE ")]);
    expect(variants.map((r) => r.ok && r.data.platform)).toEqual(["instagram", "youtube"]);
    for (const bad of ["tiktok", "insta", "", "   ", "facebook", undefined, 42]) {
      const result = await getPlatformAnalyticsView(admin, bad);
      expect(result, String(bad)).toMatchObject({ ok: false, code: "not_found" });
    }
  });
});

// ---- Data Explorer: real, normalized, cursor-paginated platform filter ------------------------------------------

describe("Data Explorer platform filter - real, normalized and cursor-paginated", () => {
  it("filters server-side on the normalized id (Instagram / ' YOUTUBE ' / instagram), never silently matching nothing", async () => {
    const actor = await syntheticActor("pages", REGION_PAGES);
    for (const [raw, expected] of [
      ["Instagram", "instagram"],
      ["instagram", "instagram"],
      [" YOUTUBE ", "youtube"],
      ["YouTube", "youtube"],
    ] as const) {
      const result = await listAnalyticsSourceRecords(actor, { recordKind: "content", platform: raw, limit: 100 });
      expect(result.ok, raw).toBe(true);
      if (!result.ok || result.data.recordKind !== "content") continue;
      expect(result.data.records, raw).toHaveLength(12);
      expect(result.data.records.every((r) => r.platform === expected), raw).toBe(true);
    }
    // The same normalization applies to channel records.
    const channel = await listAnalyticsSourceRecords(actor, { recordKind: "channel", platform: " Instagram ", limit: 100 });
    expect(channel.ok && channel.data.records.map((r) => r.platform)).toEqual(["instagram"]);
    // Unfiltered really is mixed - proving the filter above did the work.
    const unfiltered = await listAnalyticsSourceRecords(actor, { recordKind: "content", limit: 100 });
    if (!unfiltered.ok) throw new Error("expected ok");
    expect(new Set(unfiltered.data.records.map((r) => r.platform))).toEqual(new Set(["instagram", "youtube"]));
    expect(unfiltered.data.records).toHaveLength(24);
  });

  it("stays filtered across cursor pages: >1 page of mixed-platform data, page 2+ via cursor, no duplicates, no other platform", async () => {
    const actor = await syntheticActor("pages", REGION_PAGES);
    const seen: string[] = [];
    let cursor: Record<string, unknown> | undefined;
    let pageCount = 0;
    for (let guard = 0; guard < 10; guard++) {
      const result = await listAnalyticsSourceRecords(actor, { recordKind: "content", platform: " YOUTUBE ", limit: 5, cursor });
      if (!result.ok || result.data.recordKind !== "content") throw new Error("expected ok content page");
      pageCount++;
      expect(result.data.records.length).toBeLessThanOrEqual(5);
      for (const record of result.data.records) {
        expect(record.platform).toBe("youtube");
        seen.push(record.sourceRef);
      }
      if (!result.data.nextCursor) break;
      cursor = result.data.nextCursor as Record<string, unknown>;
    }
    expect(pageCount).toBe(3); // 12 youtube records at 5 per page: 5 + 5 + 2 - a real multi-page walk
    expect(seen).toHaveLength(12);
    expect(new Set(seen).size).toBe(12);
    expect(seen.every((ref) => ref.includes("pg-yt-"))).toBe(true);
  });

  it("changing the filter restarts from the first page (a cursor is only meaningful with its own filter set)", async () => {
    const actor = await syntheticActor("pages", REGION_PAGES);
    const first = await listAnalyticsSourceRecords(actor, { recordKind: "content", platform: "youtube", limit: 5 });
    const second = await listAnalyticsSourceRecords(actor, { recordKind: "content", platform: "instagram", limit: 5 });
    if (!first.ok || !second.ok) throw new Error("expected ok");
    expect(first.data.records.every((r) => r.platform === "youtube")).toBe(true);
    expect(second.data.records.every((r) => r.platform === "instagram")).toBe(true);
  });

  it("rejects a whitespace-only platform as invalid input instead of quietly matching nothing", async () => {
    const actor = await syntheticActor("pages", REGION_PAGES);
    const result = await listAnalyticsSourceRecords(actor, { recordKind: "content", platform: "   " });
    expect(result).toMatchObject({ ok: false, code: "invalid_input" });
  });
});
