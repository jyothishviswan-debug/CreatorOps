// Step 12F - real reads/writes against the running Firestore/Auth emulator (no
// mocks of Firestore): the Partners Analytics workspace (partners-workspace-
// service.ts) - its Partner search, its live scoped selection, the latest-month
// default, the month membership rule, coverage, the platform filter, the
// comparison and matrices, Campaign label redaction, explicit grants and the
// search route's gating. Run with `pnpm test:emulator` against a running
// `pnpm firebase:emulators` (or a private emulator on alternate ports).
//
// Hermetic by construction (same idiom as partner-view.emulator.test.ts): every
// fixture doc is written schema-valid via the Admin SDK under private regions /
// unique refs / a unique name prefix, fixture records are dated years in the
// PAST (2019), and everything is deleted afterwards. Exact assertions are made
// through SYNTHETIC scoped actors whose only scope grant is one private region,
// so they see precisely their own fixtures no matter what other files have
// seeded; whole-collection sizes are never asserted, and numbers are matched as
// JSON NUMBER values (labels embed Date.now() digits).
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
import { partnersCollection } from "@/server/partners/firestore";
import { partnerDocSchema } from "@/server/partners/types";

import * as explorerService from "./explorer-service";
import { analyticsChannelSourceRecordsCollection, analyticsContentSourceRecordsCollection, analyticsImportBatchesCollection } from "./firestore";
import { getPartnersWorkspace, searchWorkspacePartners } from "./partners-workspace-service";
import { analyticsChannelSourceRecordDocSchema, analyticsContentSourceRecordDocSchema, analyticsImportBatchDocSchema } from "./types";
import type { WorkspaceParamsInput } from "./partners-workspace-params";

vi.setConfig({ testTimeout: 60_000 });

// The REAL listAnalyticsSourceRecords (accepted, scoped planner - nothing is stubbed by default), wrapped in a spy so tests can
// assert exactly what the workspace passes to the planner and (bounded-window test only) simulate an endless cursor without
// writing hundreds of fixture documents.
vi.mock("./explorer-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./explorer-service")>();
  return { ...actual, listAnalyticsSourceRecords: vi.fn(actual.listAnalyticsSourceRecords) };
});

// The search route resolves its actor from the request cookie; the route-gating test drives it with synthetic actors.
vi.mock("@/server/analytics/http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/analytics/http")>();
  return { ...actual, resolveRequestActor: vi.fn(actual.resolveRequestActor) };
});

const uidByRole = new Map<string, string>();
const runId = Date.now();
const tag = `p12f-${runId}`;
const NAME_PREFIX = `p12f${runId}`; // every fixture Partner's display name starts with this (lower-cased for the prefix search)
const REGION_A = `${tag}-region-a`;
const REGION_B = `${tag}-region-b`;
const REGION_EMPTY = `${tag}-region-empty`;
const REGION_SEEDED_ROLES = "Lakshadweep"; // reachable (per the accepted seeds) by Analyst / Manager / Head / Super Admin
const BATCH_REF = `${tag}-batch`;
const now = new Date().toISOString();

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

// A synthetic actor: the Analyst ROLE baseline (analytics explore + partners/campaigns features from the seeded
// accessGrants/analyst document) with a private-region scope grant (plus any extra grant a test names).
async function syntheticActor(label: string, region: string, extraGrants: ScopeGrantInput[] = []): Promise<ActorContext> {
  const uid = `${tag}-actor-${label}`;
  for (const input of [{ type: "REGION", region } as ScopeGrantInput, ...extraGrants]) {
    const ref = getAdminFirestore().collection(COLLECTIONS.scopeAssignments).doc(scopeGrantDocId(uid, input));
    await ref.set({ ...input, uid, grantedAt: now, grantedBy: "system:test" });
    cleanup.push(ref);
  }
  return { uid, email: `${uid}@p12f.test`, role: "analyst", displayName: `P12F ${label}`, userRef: uid };
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
  period?: { start: string; end: string } | null;
  createdAt?: string;
  partnerRef: string;
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
    postDateTimeIso: "2019-03-10T10:00:00.000Z",
    comments: o.comments ?? null,
    likes: o.likes ?? null,
    views: o.views ?? null,
    profileFollowers: null,
    engagement: o.engagement ?? null,
    reportingPeriod: o.period ?? null,
    matchState: "MATCHED",
    matchEvidence: { tier: "published_url", value: null, reasonCode: null, candidateCount: 1 },
    matchedContentRef: null,
    matchedAssignmentRef: null,
    matchedCampaignRef: o.campaignRef ?? null,
    matchedPartnerRef: o.partnerRef,
    matchedPartnerAccountRef: null,
    ownerUid: null,
    regionIds: [o.region],
    teamIds: [],
    createdAt: o.createdAt ?? "2019-04-01T00:00:00.000Z",
  });
}

function channelDoc(o: { ref: string; platform: "instagram" | "youtube"; region: string; followers: number; period: { start: string; end: string } | null; createdAt: string; partnerRef: string }) {
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
    profileFollowers: o.followers,
    reportingPeriod: o.period,
    matchState: "MATCHED",
    matchEvidence: { tier: "none", value: null, reasonCode: null, candidateCount: 0 },
    matchedPartnerRef: o.partnerRef,
    matchedPartnerAccountRef: null,
    ownerUid: null,
    regionIds: [o.region],
    teamIds: [],
    createdAt: o.createdAt,
  });
}

// ---- Fixture identities -----------------------------------------------------------------

const PA1 = `${tag}-pa1`; // Aurora   - region A, India 1 + India 2 - the data-rich Partner
const PA2 = `${tag}-pa2`; // Borealis - region A, India 1
const PA3 = `${tag}-pa3`; // Cascade  - region A, India 3 - only February data
const PA4 = `${tag}-pa4`; // Delta    - region A, no Target Audience - NO Analytics data at all
const PB1 = `${tag}-pb1`; // Ember    - region B (out of the region-A actor's scope), India 1
const PSEED = `${tag}-pseed`; // Seeded - Lakshadweep, India Alpha
const UNKNOWN = `${tag}-does-not-exist`;

const NAME: Record<string, string> = {
  [PA1]: `${NAME_PREFIX} Aurora`,
  [PA2]: `${NAME_PREFIX} Borealis`,
  [PA3]: `${NAME_PREFIX} Cascade`,
  [PA4]: `${NAME_PREFIX} Delta`,
  [PB1]: `${NAME_PREFIX} Ember`,
  [PSEED]: `${NAME_PREFIX} Seeded`,
};
const CAMP_A = `${tag}-camp-a`;
const CAMP_B = `${tag}-camp-b`;
const CAMP_A_NAME = `P12F Campaign In Scope ${runId}`;
const CAMP_B_NAME = `P12F Campaign Out Of Scope ${runId}`;
const P1_LEGAL_NAME = `SECRET LEGAL NAME ${runId}`;
const P1_EMAIL = `secret-${runId}@restricted-partner.test`;

const FEB = { start: "2019-02-01", end: "2019-02-28" };
const MAR = { start: "2019-03-01", end: "2019-03-31" };
const APR = { start: "2019-04-01", end: "2019-04-30" };

async function seedFixtures(): Promise<void> {
  await put(
    analyticsImportBatchesCollection(),
    analyticsImportBatchDocSchema.parse({
      uid: BATCH_REF,
      batchRef: BATCH_REF,
      targetKind: "campaign_content",
      sourceFilename: `${tag}-export.xlsx`,
      sourceMimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      sourceExtension: "xlsx",
      sourceHash: `${tag}-hash`,
      supersedesBatchRef: null,
      reportingPeriod: null,
      actorUserRef: "p12f",
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

  const partner = (ref: string, regions: string[], targetAudience: string[], extra: Partial<{ legalName: string; email: string; phone: string }> = {}) =>
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
      targetAudience,
      email: extra.email ?? null,
      phone: extra.phone ?? null,
      ownerUid: null,
      teamIds: [],
      originLeadRefs: [],
      sourceDiscovery: null,
      pendingPartnerAccountSetup: false,
      sequenceNumber: null,
      createdAt: now,
      createdByUserRef: "p12f",
      updatedAt: now,
      updatedByUserRef: "p12f",
    });
  await put(partnersCollection(), partner(PA1, [REGION_A], ["India 1", "India 2"], { legalName: P1_LEGAL_NAME, email: P1_EMAIL, phone: "+91 90000 00097" }));
  await put(partnersCollection(), partner(PA2, [REGION_A], ["India 1"]));
  await put(partnersCollection(), partner(PA3, [REGION_A], ["India 3"]));
  await put(partnersCollection(), partner(PA4, [REGION_A], []));
  await put(partnersCollection(), partner(PB1, [REGION_B], ["India 1"]));
  await put(partnersCollection(), partner(PSEED, [REGION_SEEDED_ROLES], ["India Alpha"]));

  const campaign = (ref: string, name: string, region: string) =>
    campaignDocSchema.parse({
      uid: ref,
      campaignRef: ref,
      version: 1,
      name,
      nameLower: name.toLowerCase(),
      objective: "Step 12F scope fixture",
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
      createdByUserRef: "p12f",
      updatedAt: now,
      updatedByUserRef: "p12f",
    });
  await put(campaignsCollection(), campaign(CAMP_A, CAMP_A_NAME, REGION_A));
  await put(campaignsCollection(), campaign(CAMP_B, CAMP_B_NAME, REGION_B));

  const contents = [
    // ---- PA1 (Aurora), region A ----
    contentDoc({ ref: "a1-ig-mar", platform: "instagram", region: REGION_A, views: 1000, likes: 100, comments: 10, engagement: 55, period: MAR, partnerRef: PA1, campaignRef: CAMP_A, createdAt: "2019-04-01T00:00:00.000Z" }),
    contentDoc({ ref: "a1-ig-apr", platform: "instagram", region: REGION_A, views: 2000, likes: 200, comments: null, engagement: null, period: APR, partnerRef: PA1, createdAt: "2019-05-01T00:00:00.000Z" }),
    contentDoc({ ref: "a1-yt-mar", platform: "youtube", region: REGION_A, views: 7000, likes: 700, comments: 70, engagement: 500, period: MAR, partnerRef: PA1, campaignRef: CAMP_B, createdAt: "2019-04-02T00:00:00.000Z" }),
    // never forced into a month: no period / a period spanning March-April
    contentDoc({ ref: "a1-ig-noperiod", platform: "instagram", region: REGION_A, views: 55555, period: null, partnerRef: PA1, createdAt: "2019-05-03T00:00:00.000Z" }),
    contentDoc({ ref: "a1-ig-span", platform: "instagram", region: REGION_A, views: 44444, period: { start: "2019-03-15", end: "2019-04-15" }, partnerRef: PA1, createdAt: "2019-05-04T00:00:00.000Z" }),
    // PA1's record that lives in region B (NOT in the region-A actor's Analytics scope)
    contentDoc({ ref: "a1-ig-b", platform: "instagram", region: REGION_B, views: 888002, period: MAR, partnerRef: PA1 }),
    // ---- PA2 (Borealis): Instagram March, Engagement NOT reported (likes / comments ARE) ----
    contentDoc({ ref: "a2-ig-mar", platform: "instagram", region: REGION_A, views: 500, likes: 50, comments: 5, engagement: null, period: MAR, partnerRef: PA2, createdAt: "2019-04-03T00:00:00.000Z" }),
    // ---- PA3 (Cascade): YouTube February only ----
    contentDoc({ ref: "a3-yt-feb", platform: "youtube", region: REGION_A, views: 3000, likes: 30, comments: null, engagement: null, period: FEB, partnerRef: PA3, createdAt: "2019-03-05T00:00:00.000Z" }),
    // ---- PB1 (Ember), region B ----
    contentDoc({ ref: "b1-ig-mar", platform: "instagram", region: REGION_B, views: 333001, period: MAR, partnerRef: PB1 }),
  ];
  const channels = [
    channelDoc({ ref: "a1-ig-mar", platform: "instagram", region: REGION_A, followers: 5000, period: MAR, partnerRef: PA1, createdAt: "2019-04-05T00:00:00.000Z" }),
    channelDoc({ ref: "a1-ig-apr", platform: "instagram", region: REGION_A, followers: 5500, period: APR, partnerRef: PA1, createdAt: "2019-05-05T00:00:00.000Z" }),
    channelDoc({ ref: "a1-yt-apr", platform: "youtube", region: REGION_A, followers: 9000, period: APR, partnerRef: PA1, createdAt: "2019-05-06T00:00:00.000Z" }),
    channelDoc({ ref: "a1-noperiod", platform: "instagram", region: REGION_A, followers: 42, period: null, partnerRef: PA1, createdAt: "2019-05-07T00:00:00.000Z" }),
    channelDoc({ ref: "b1-ig", platform: "instagram", region: REGION_B, followers: 424242, period: MAR, partnerRef: PB1, createdAt: "2019-04-05T00:00:00.000Z" }),
  ];

  const db = getAdminFirestore();
  const all = [...contents.map((doc) => ({ collection: analyticsContentSourceRecordsCollection(), doc })), ...channels.map((doc) => ({ collection: analyticsChannelSourceRecordsCollection(), doc }))];
  const writeBatch = db.batch();
  for (const { collection, doc } of all) {
    const ref = collection.doc(doc.uid);
    writeBatch.set(ref, doc);
    cleanup.push(ref);
  }
  await writeBatch.commit();
}

async function workspace(actor: ActorContext | null, params: WorkspaceParamsInput) {
  const result = await getPartnersWorkspace(actor, params);
  if (!result.ok) throw new Error(`expected ok, got ${result.code}: ${result.message}`);
  return result.data;
}

async function search(actor: ActorContext | null, input: Record<string, unknown>) {
  const result = await searchWorkspacePartners(actor, input);
  if (!result.ok) throw new Error(`expected ok, got ${result.code}: ${result.message}`);
  return result.data;
}

const names = (partners: { displayName: string }[]) => partners.map((p) => p.displayName);

// ---- Partner search: authorized only, filters only narrow --------------------------------------------

describe("Partner search - scoped before retrieval, bounded, safe identity only", () => {
  it("returns only the Partners inside the actor's scope; an out-of-scope Partner never appears (name order is deterministic)", async () => {
    const actorA = await syntheticActor("a", REGION_A);
    const found = await search(actorA, { q: NAME_PREFIX });
    expect(names(found.partners)).toEqual([NAME[PA1], NAME[PA2], NAME[PA3], NAME[PA4]]);
    expect(names(found.partners)).not.toContain(NAME[PB1]);
    const actorB = await syntheticActor("b", REGION_B);
    expect(names((await search(actorB, { q: NAME_PREFIX })).partners)).toEqual([NAME[PB1]]);
  });

  it("the prefix search is case-insensitive and narrows by name", async () => {
    const actorA = await syntheticActor("a", REGION_A);
    expect(names((await search(actorA, { q: `${NAME_PREFIX.toUpperCase()} AUR` })).partners)).toEqual([NAME[PA1]]);
    expect(names((await search(actorA, { q: `${NAME_PREFIX} zzz` })).partners)).toEqual([]);
  });

  it("results are SAFE display identity only - no email, phone, legal name, tier, status, owner or uid", async () => {
    const actorA = await syntheticActor("a", REGION_A);
    const found = await search(actorA, { q: `${NAME_PREFIX} Aurora` });
    expect(found.partners).toEqual([{ ref: PA1, displayName: NAME[PA1], regions: [REGION_A], targetAudience: ["India 1", "India 2"] }]);
    const json = JSON.stringify(found);
    for (const secret of [P1_LEGAL_NAME, P1_EMAIL, "+91 90000 00097", "Tier 1", "ACTIVE", "ownerUid", "legalName"]) expect(json, secret).not.toContain(secret);
  });

  it("Target Audience narrows the list but NEVER adds an out-of-scope Partner", async () => {
    const actorA = await syntheticActor("a", REGION_A);
    // Ember (region B) also carries India 1 - it must not appear for the region-A actor.
    expect(names((await search(actorA, { q: NAME_PREFIX, targetAudience: ["India 1"] })).partners)).toEqual([NAME[PA1], NAME[PA2]]);
    expect(names((await search(actorA, { q: NAME_PREFIX, targetAudience: ["India 3"] })).partners)).toEqual([NAME[PA3]]);
    expect(names((await search(actorA, { q: NAME_PREFIX, targetAudience: ["India 1", "India 3"] })).partners)).toEqual([NAME[PA1], NAME[PA2], NAME[PA3]]);
    expect((await search(actorA, { q: NAME_PREFIX, targetAudience: ["India 4"] })).partners).toEqual([]);
    // Without a name prefix too (browse mode): still only in-scope Partners with that audience.
    const browse = await search(actorA, { targetAudience: ["India 1"] });
    expect(names(browse.partners)).toEqual(expect.arrayContaining([NAME[PA1], NAME[PA2]]));
    expect(names(browse.partners)).not.toContain(NAME[PB1]);
  });

  it("Target Audience is canonical-only: an unknown / Tier-like value is ignored, never used as a filter", async () => {
    const actorA = await syntheticActor("a", REGION_A);
    expect(names((await search(actorA, { q: NAME_PREFIX, targetAudience: ["Tier 1"] })).partners)).toEqual([NAME[PA1], NAME[PA2], NAME[PA3], NAME[PA4]]);
    expect(names((await search(actorA, { q: NAME_PREFIX, targetAudience: ["india 1"] })).partners)).toEqual([NAME[PA1], NAME[PA2], NAME[PA3], NAME[PA4]]);
  });

  it("the region filter narrows but cannot reach outside scope", async () => {
    const actorA = await syntheticActor("a", REGION_A);
    expect(names((await search(actorA, { q: NAME_PREFIX, region: [REGION_A] })).partners)).toEqual([NAME[PA1], NAME[PA2], NAME[PA3], NAME[PA4]]);
    expect((await search(actorA, { q: NAME_PREFIX, region: [REGION_B] })).partners).toEqual([]);
    expect(names((await search(actorA, { q: NAME_PREFIX, region: [REGION_A], targetAudience: ["India 3"] })).partners)).toEqual([NAME[PA3]]);
  });

  it("is bounded: the limit is honored, clamped to 20, and `hasMore` says more exist", async () => {
    const actorA = await syntheticActor("a", REGION_A);
    const two = await search(actorA, { q: NAME_PREFIX, limit: 2 });
    expect(two.partners).toHaveLength(2);
    expect(two.hasMore).toBe(true);
    const many = await search(actorA, { q: NAME_PREFIX, limit: 500 });
    expect(many.partners.length).toBeLessThanOrEqual(20);
    expect((await search(actorA, { q: NAME_PREFIX })).partners.length).toBeLessThanOrEqual(10);
    expect(await searchWorkspacePartners(actorA, { limit: "abc" })).toMatchObject({ ok: false, code: "invalid_input" });
    expect(await searchWorkspacePartners(actorA, { q: "x".repeat(101) })).toMatchObject({ ok: false, code: "invalid_input" });
  });

  it("the GLOBAL Super Admin's search reaches every scope; Viewer and an unauthenticated caller are denied", async () => {
    const admin = await search(await seededActor("super_admin"), { q: NAME_PREFIX, limit: 20 });
    expect(names(admin.partners)).toEqual(expect.arrayContaining([NAME[PA1], NAME[PB1], NAME[PSEED]]));
    expect(await searchWorkspacePartners(await seededActor("viewer"), { q: NAME_PREFIX })).toMatchObject({ ok: false, code: "unauthorized", reason: "action_denied" });
    expect(await searchWorkspacePartners(null, { q: NAME_PREFIX })).toMatchObject({ ok: false, code: "unauthorized", reason: "not_authenticated" });
  });
});

// ---- Selection: live, scoped, neutral ------------------------------------------------------------------

describe("Selection - resolved LIVE with the accepted Partner Record Scope; anything else is dropped neutrally", () => {
  it("an injected out-of-scope or unknown ref is dropped with ONE neutral notice and never yields data, labels or a name", async () => {
    const actorA = await syntheticActor("a", REGION_A);
    const dto = await workspace(actorA, { partners: `${PA1},${PB1},${UNKNOWN}` });
    expect(dto.selector.selected.map((p) => p.displayName)).toEqual([NAME[PA1]]);
    expect(dto.notices).toEqual(["2 selected Partners are not available"]);
    const json = JSON.stringify(dto);
    for (const leak of [NAME[PB1], PB1, UNKNOWN, CAMP_B_NAME]) expect(json, leak).not.toContain(leak);
    for (const leak of [333001, 424242, 888002]) expect(jsonHasNumber(json, leak), `leaks ${leak}`).toBe(false);
    expect(dto.mode).toBe("single");
  });

  it("an out-of-scope ref and an unknown ref are INDISTINGUISHABLE (no existence signal)", async () => {
    const actorA = await syntheticActor("a", REGION_A);
    const outOfScope = await workspace(actorA, { partners: PB1 });
    const unknown = await workspace(actorA, { partners: UNKNOWN });
    const malformed = await workspace(actorA, { partners: "x".repeat(300) });
    expect(outOfScope).toEqual(unknown);
    expect(malformed).toEqual(unknown);
    expect(unknown.selector.selected).toEqual([]);
    expect(unknown.notices).toEqual(["1 selected Partner is not available"]);
    expect(unknown.mode).toBe("empty");
    // ...and the region-B actor CAN open its own Partner (knowing an id grants nothing; scope does).
    const actorB = await syntheticActor("b", REGION_B);
    expect((await workspace(actorB, { partners: PB1 })).selector.selected.map((p) => p.displayName)).toEqual([NAME[PB1]]);
  });

  it("the selection limit is enforced server-side: at most 10 refs are considered and the rest are disclosed as ignored", async () => {
    const actorA = await syntheticActor("a", REGION_A);
    const fakes = Array.from({ length: 8 }, (_, i) => `${tag}-fake-${i}`);
    const dto = await workspace(actorA, { partners: [PA1, PA2, PA3, PA4, ...fakes].join(",") });
    expect(dto.selector.selected).toHaveLength(4);
    expect(dto.notices).toEqual(["6 selected Partners are not available", "Only the first 10 selected Partners are shown; 2 more were ignored"]);
  });

  it("single and multi selection keep the caller's order; the display name is the only identity shown", async () => {
    const actorA = await syntheticActor("a", REGION_A);
    const single = await workspace(actorA, { partners: PA1 });
    expect(single.mode).toBe("single");
    expect(single.single!.partner).toEqual({ displayName: NAME[PA1] });
    const multi = await workspace(actorA, { partners: `${PA3},${PA1},${PA2}` });
    expect(multi.mode).toBe("comparison");
    expect(multi.comparison!.table.rows.map((r) => r.displayName)).toEqual([NAME[PA3], NAME[PA1], NAME[PA2]]);
    expect(multi.single).toBeNull();
    const empty = await workspace(actorA, {});
    expect(empty.mode).toBe("empty");
  });

  it("the analysis DTO exposes no restricted Partner field and no raw uid / source ref / URL / caption / username / batch ref", async () => {
    const actorA = await syntheticActor("a", REGION_A);
    const dto = await workspace(actorA, { partners: `${PA1},${PA2}`, month: "2019-03" });
    const single = await workspace(actorA, { partners: PA1, month: "2019-03" });
    for (const value of [dto, single]) {
      const { selector: _selector, ...analysis } = value;
      void _selector;
      const json = JSON.stringify(analysis).replace(/"[a-zA-Z]*[hH]ref":"[^"]*"/g, '"href":""');
      for (const secret of [P1_LEGAL_NAME, P1_EMAIL, "+91 90000 00097", "RAW CAPTION", "RAW-URL-", "rawuser_", "rawchannel_", `${tag}-c-`, `${tag}-ch-`, BATCH_REF, CAMP_A, CAMP_B, "Tier 1", PA1, PA2]) expect(json, `DTO leaks ${secret}`).not.toContain(secret);
      expect(json).not.toContain("https://");
    }
  });
});

// ---- Month: from imported data, follows context, explicit is never changed ------------------------------

describe("Reporting month - defaults to the latest month WITH DATA in the current context, never the calendar", () => {
  it("defaults to the latest imported reporting month (2019-04), not the current calendar month, and lists the months with data", async () => {
    const actorA = await syntheticActor("a", REGION_A);
    const dto = await workspace(actorA, { partners: PA1 });
    expect(dto.month).toMatchObject({ resolved: "2019-04", label: "April 2019", source: "latest_default", sourceLabel: "Latest reporting month with data" });
    expect(dto.month.options.map((o) => [o.month, o.hasData])).toEqual([["2019-04", true], ["2019-03", true]]);
    expect(dto.month.resolved).not.toBe(new Date().toISOString().slice(0, 7));
  });

  it("the default follows the selection context until the user chooses", async () => {
    const actorA = await syntheticActor("a", REGION_A);
    expect((await workspace(actorA, { partners: PA3 })).month).toMatchObject({ resolved: "2019-02", source: "latest_default" });
    expect((await workspace(actorA, { partners: `${PA3},${PA1}` })).month).toMatchObject({ resolved: "2019-04", source: "latest_default" });
    expect((await workspace(actorA, { partners: PA2 })).month).toMatchObject({ resolved: "2019-03", source: "latest_default" });
  });

  it("with nothing selected the default comes from the actor's whole authorized Partner-linked data (bounded scan)", async () => {
    const actorA = await syntheticActor("a", REGION_A);
    const dto = await workspace(actorA, {});
    expect(dto.mode).toBe("empty");
    expect(dto.month.options.map((o) => o.month)).toEqual(["2019-04", "2019-03", "2019-02"]);
    expect(dto.month).toMatchObject({ resolved: "2019-04", source: "latest_default" });
    // Region-B data never enters region A's context, and vice versa.
    const actorB = await syntheticActor("b", REGION_B);
    expect((await workspace(actorB, {})).month.options.map((o) => o.month)).toEqual(["2019-03"]);
  });

  it("an actor whose scope holds no Analytics data gets 'No reporting month with data yet' (never a made-up month)", async () => {
    const empty = await syntheticActor("empty", REGION_EMPTY);
    const dto = await workspace(empty, {});
    expect(dto.month).toMatchObject({ resolved: null, label: null, source: "none", sourceLabel: "No reporting month with data yet", options: [] });
    expect(dto.coverage.text).toBeNull();
  });

  it("an explicit month persists exactly - even one with NO data - and is never replaced by the default", async () => {
    const actorA = await syntheticActor("a", REGION_A);
    const march = await workspace(actorA, { partners: PA1, month: "2019-03" });
    expect(march.month).toMatchObject({ resolved: "2019-03", source: "explicit", sourceLabel: "Selected month" });
    expect(march.single!.kpis.publishedContent.total).toBe(2); // Instagram + YouTube March
    const nodata = await workspace(actorA, { partners: PA1, month: "2030-01" });
    expect(nodata.month).toMatchObject({ resolved: "2030-01", source: "explicit" });
    expect(nodata.month.options.find((o) => o.month === "2030-01")).toMatchObject({ hasData: false, selected: true });
    expect(nodata.single!.kpis.publishedContent.total).toBe(0);
    expect(nodata.single!.kpis.views.byPlatform.every((entry) => entry.total === null)).toBe(true); // Unavailable, never 0
    // The explicit month survives a platform switch and a Partner change in the built links.
    expect(march.links.platformSwitch.every((item) => item.href.includes("month=2019-03"))).toBe(true);
    expect((await workspace(actorA, { partners: `${PA1},${PA3}`, month: "2019-03" })).month).toMatchObject({ resolved: "2019-03", source: "explicit" });
  });

  it("an invalid month is treated as absent with a neutral notice (the default applies, nothing is guessed)", async () => {
    const actorA = await syntheticActor("a", REGION_A);
    for (const month of ["2019-13", "garbage", ["2019-03", "2019-04"]]) {
      const dto = await workspace(actorA, { partners: PA1, month });
      expect(dto.month).toMatchObject({ resolved: "2019-04", source: "latest_default" });
      expect(dto.notices).toEqual(["The month in the link is not a valid reporting month, so the latest reporting month with data is shown instead"]);
    }
  });

  it("records with no period, an unreadable one or one SPANNING months are never forced into a month and are disclosed by reason", async () => {
    const actorA = await syntheticActor("a", REGION_A);
    for (const month of ["2019-03", "2019-04"]) {
      const dto = await workspace(actorA, { partners: PA1, month });
      const json = JSON.stringify(dto);
      for (const forced of [55555, 44444, 42]) expect(jsonHasNumber(json, forced), `${forced} forced into ${month}`).toBe(false);
      // content: 1 no-period + 1 spanning; channel: 1 no-period
      expect(dto.coverage.exclusions).toEqual({ noPeriod: 2, unparseable: 0, spans: 1 });
      expect(dto.coverage.exclusionNote).toContain("3 source records could not be placed in a single reporting month");
      expect(dto.single!.month).toMatchObject({ month, excluded: { noPeriod: 2, unparseable: 0, spans: 1 } });
    }
  });
});

// ---- Coverage --------------------------------------------------------------------------------------------

describe("Coverage - truthful x of y, a Partner without data stays visible as Unavailable", () => {
  it("counts the selected Partners with data in the month (content or channel); nobody is dropped", async () => {
    const actorA = await syntheticActor("a", REGION_A);
    const dto = await workspace(actorA, { partners: `${PA1},${PA4},${PA2}`, month: "2019-03" });
    expect(dto.coverage).toMatchObject({ selectedCount: 3, withDataCount: 2, text: "2 of 3 selected Partners have Analytics data for March 2019" });
    expect(dto.comparison!.table.rows.map((r) => [r.displayName, r.coverage.state])).toEqual([
      [NAME[PA1], "content_and_channel"],
      [NAME[PA4], "no_data"],
      [NAME[PA2], "content_only"],
    ]);
    const delta = dto.comparison!.table.rows[1]!;
    expect(delta).toMatchObject({ publishedContent: null, instagramViews: { total: null }, youtubeViews: { total: null }, engagement: { total: null }, likes: { total: null }, comments: { total: null }, latestSnapshot: null });
  });

  it("is per month: PA2 has no April data, so April reads 1 of 2", async () => {
    const actorA = await syntheticActor("a", REGION_A);
    const dto = await workspace(actorA, { partners: `${PA1},${PA2}` });
    expect(dto.month.resolved).toBe("2019-04");
    expect(dto.coverage.text).toBe("1 of 2 selected Partners has Analytics data for April 2019");
    expect(dto.comparison!.table.rows.find((r) => r.displayName === NAME[PA2])!.coverage.state).toBe("no_data");
  });

  it("follows the platform filter (Instagram-only coverage for a YouTube-only Partner is 0)", async () => {
    const actorA = await syntheticActor("a", REGION_A);
    const dto = await workspace(actorA, { partners: `${PA3},${PA1}`, month: "2019-02", platform: "instagram" });
    expect(dto.coverage.text).toBe("0 of 2 selected Partners have Instagram Analytics data for February 2019");
  });
});

// ---- Platform filter: applied by the server / planner ----------------------------------------------------

describe("Platform filter - applied server-side, platform-native separation preserved", () => {
  it("the Partner AND the platform are pushed to the accepted planner - never fetched unfiltered and filtered in memory", async () => {
    const actorA = await syntheticActor("a", REGION_A);
    const list = vi.mocked(explorerService.listAnalyticsSourceRecords);
    const calls = () => list.mock.calls.map(([, input]) => input as { recordKind: string; platform?: string; matchedPartnerRef?: string; limit?: number });

    list.mockClear();
    await workspace(actorA, { partners: `${PA1},${PA2}`, platform: "instagram" });
    expect(calls().length).toBeGreaterThanOrEqual(4);
    expect(calls().every((c) => c.platform === "instagram" && (c.matchedPartnerRef === PA1 || c.matchedPartnerRef === PA2) && c.limit === 100)).toBe(true);
    expect(new Set(calls().map((c) => c.recordKind))).toEqual(new Set(["content", "channel"]));

    list.mockClear();
    await workspace(actorA, { partners: PA1 }); // All: both platforms, each its own filtered read
    expect(new Set(calls().map((c) => `${c.recordKind}:${c.platform}`))).toEqual(new Set(["content:instagram", "content:youtube", "channel:instagram", "channel:youtube"]));
    expect(calls().every((c) => c.matchedPartnerRef === PA1)).toBe(true);

    list.mockClear();
    await workspace(actorA, { partners: PA1, platform: "tiktok" }); // garbage = All, never anything else
    expect(calls().every((c) => c.platform === "instagram" || c.platform === "youtube")).toBe(true);
  });

  it("an out-of-selection platform's record never reaches the DTO (single and comparison)", async () => {
    const actorA = await syntheticActor("a", REGION_A);
    const ig = await workspace(actorA, { partners: PA1, month: "2019-03", platform: "instagram" });
    expect(ig.single!.kpis.publishedContent.byPlatform).toEqual([{ platform: "instagram", count: 1 }]);
    expect(jsonHasNumber(JSON.stringify(ig), 7000)).toBe(false); // the YouTube record
    const yt = await workspace(actorA, { partners: PA1, month: "2019-03", platform: "youtube" });
    expect(yt.single!.kpis.publishedContent.byPlatform).toEqual([{ platform: "youtube", count: 1 }]);
    expect(jsonHasNumber(JSON.stringify(yt), 1000)).toBe(false);
    const cmp = await workspace(actorA, { partners: `${PA1},${PA2}`, month: "2019-03", platform: "instagram" });
    expect(cmp.comparison!.table.viewsPlatforms).toEqual(["instagram"]);
    expect(cmp.comparison!.table.rows.every((r) => r.youtubeViews === null)).toBe(true);
    expect(jsonHasNumber(JSON.stringify(cmp), 7000)).toBe(false);
  });

  it("the switch links preserve selection, filters and an explicit month", async () => {
    const actorA = await syntheticActor("a", REGION_A);
    const dto = await workspace(actorA, { partners: `${PA1},${PA2}`, month: "2019-03", targetAudience: ["India 1"], region: REGION_A });
    const yt = dto.links.platformSwitch.find((i) => i.selection === "youtube")!;
    const url = new URL(yt.href, "http://x");
    expect(url.pathname).toBe("/analytics/partners");
    expect(url.searchParams.get("partners")).toBe(`${PA1},${PA2}`);
    expect(url.searchParams.get("month")).toBe("2019-03");
    expect(url.searchParams.get("platform")).toBe("youtube");
    expect(url.searchParams.getAll("targetAudience")).toEqual(["India 1"]);
    expect(url.searchParams.getAll("region")).toEqual([REGION_A]);
  });
});

// ---- Metrics ----------------------------------------------------------------------------------------------

describe("Metrics - source-reported only, platform-native, per Partner, never blended", () => {
  it("single Partner, month view: accepted 12E semantics for that month (Views not combined on All; Engagement source-only)", async () => {
    const actorA = await syntheticActor("a", REGION_A);
    const dto = (await workspace(actorA, { partners: PA1, month: "2019-03" })).single!;
    expect(dto.month).toMatchObject({ month: "2019-03", label: "March 2019" });
    expect(dto.kpis.publishedContent).toEqual({ total: 2, byPlatform: [{ platform: "instagram", count: 1 }, { platform: "youtube", count: 1 }] });
    expect(dto.kpis.views.totalBasis).toBe("not_combined");
    expect(dto.kpis.views.total).toBeNull();
    expect(dto.kpis.views.byPlatform).toEqual([
      { platform: "instagram", total: 1000, recordsWithValue: 1, recordsTotal: 1 },
      { platform: "youtube", total: 7000, recordsWithValue: 1, recordsTotal: 1 },
    ]);
    expect(dto.kpis.engagement).toMatchObject({ total: 555, recordsWithValue: 2, recordsTotal: 2 });
    expect(jsonHasNumber(JSON.stringify(dto), 8000)).toBe(false); // 1000 + 7000 never exists
    expect(dto.links.allPeriodsHref).toBe(`/analytics/partner/${encodeURIComponent(PA1)}`);
  });

  it("the single view's Platform cards are MONTHLY, per platform, on one axis - the trend reads all months while the KPIs read one", async () => {
    const actorA = await syntheticActor("a", REGION_A);
    const dto = (await workspace(actorA, { partners: PA1, month: "2019-03" })).single!;
    expect(dto.platformPerformance.map((c) => [c.platform, c.trendBasis, c.recordCount])).toEqual([["instagram", "month", 4], ["youtube", "month", 1]]);
    const ig = dto.platformPerformance[0]!.trend;
    expect(ig.periods.map((p) => p.label)).toEqual(["Mar 2019", "Apr 2019"]);
    expect(ig.series.find((s) => s.metric === "views")!.values).toEqual([1000, 2000]);
    // Engagement was reported in March only for Instagram: fewer than two months -> not plotted, disclosed.
    expect(ig.omittedMetrics).toContain("engagement");
    // YouTube has a single month: nothing plottable, and nothing is merged into the Instagram series.
    expect(dto.platformPerformance[1]!.trend.series).toEqual([]);
  });

  it("comparison: each Partner from its OWN records; Instagram / YouTube Views are separate columns; missing is null, never 0", async () => {
    const actorA = await syntheticActor("a", REGION_A);
    const dto = await workspace(actorA, { partners: `${PA1},${PA2}`, month: "2019-03" });
    const [aurora, borealis] = dto.comparison!.table.rows;
    expect(dto.comparison!.table.viewsPlatforms).toEqual(["instagram", "youtube"]);
    expect(aurora).toMatchObject({
      displayName: NAME[PA1],
      publishedContent: 2,
      instagramViews: { total: 1000, recordsWithValue: 1, recordsTotal: 1 },
      youtubeViews: { total: 7000, recordsWithValue: 1, recordsTotal: 1 },
      engagement: { total: 555, recordsWithValue: 2, recordsTotal: 2 },
      likes: { total: 800, recordsWithValue: 2, recordsTotal: 2 },
      comments: { total: 80, recordsWithValue: 2, recordsTotal: 2 },
    });
    // Borealis: Engagement was NOT reported (likes / comments were) - it stays Unavailable, never likes + comments.
    expect(borealis).toMatchObject({
      displayName: NAME[PA2],
      publishedContent: 1,
      instagramViews: { total: 500, recordsWithValue: 1, recordsTotal: 1 },
      youtubeViews: { total: null, recordsWithValue: 0, recordsTotal: 0 },
      engagement: { total: null, recordsWithValue: 0, recordsTotal: 1 },
      likes: { total: 50 },
      comments: { total: 5 },
    });
    const json = JSON.stringify(dto.comparison);
    for (const blended of [8000, 8500, 1500]) expect(jsonHasNumber(json, blended), `blended ${blended}`).toBe(false);
    // Partner independence: adding a third Partner changes neither row.
    const three = await workspace(actorA, { partners: `${PA1},${PA2},${PA3}`, month: "2019-03" });
    expect(three.comparison!.table.rows.slice(0, 2)).toEqual(dto.comparison!.table.rows);
  });

  it("follower snapshots are freshness only: never summed, never shown as a total", async () => {
    const actorA = await syntheticActor("a", REGION_A);
    const dto = await workspace(actorA, { partners: `${PA1},${PA2}`, month: "2019-03" });
    const aurora = dto.comparison!.table.rows[0]!;
    expect(aurora.latestSnapshot).toEqual({ importedAt: "2019-05-07T00:00:00.000Z", reportingPeriod: null });
    expect(dto.comparison!.table.rows[1]!.latestSnapshot).toBeNull(); // Borealis has no channel snapshot
    const json = JSON.stringify(dto.comparison);
    for (const followers of [5000, 5500, 9000, 42, 10500, 14500, 14000, 19500, 14542]) expect(jsonHasNumber(json, followers), `follower value ${followers}`).toBe(false);
  });

  it("the month x Partner matrices: one metric at a time, Views as two SEPARATE matrices, gaps are dashes (null)", async () => {
    const actorA = await syntheticActor("a", REGION_A);
    const views = await workspace(actorA, { partners: `${PA1},${PA2}`, metric: "views" });
    expect(views.comparison!.matrices.map((m) => m.title)).toEqual(["Instagram Views", "YouTube Views"]);
    const [ig, yt] = views.comparison!.matrices;
    expect(ig!.months.map((m) => m.month)).toEqual(["2019-03", "2019-04"]);
    expect(ig!.partners.map((p) => p.displayName)).toEqual([NAME[PA1], NAME[PA2]]);
    expect(ig!.cells).toEqual([[1000, 500], [2000, null]]);
    expect(yt!.cells).toEqual([[7000, null], [null, null]]);
    const engagement = await workspace(actorA, { partners: `${PA1},${PA2}` });
    expect(engagement.comparison!.metric).toBe("engagement"); // the labelled default
    expect(engagement.comparison!.matrices).toHaveLength(1);
    expect(engagement.comparison!.matrices[0]!.cells).toEqual([[555, null], [null, null]]);
  });
});

// ---- Campaign label redaction (single view) ----------------------------------------------------------------

describe("Campaign labels in the single view need the Campaign Record Scope", () => {
  it("present with scope, neutral (no name, no ref) without - the Analytics fact stays visible", async () => {
    const scoped = (await workspace(await syntheticActor("a", REGION_A), { partners: PA1, month: "2019-03" })).single!;
    expect(scoped.publishedContent.rows.find((r) => r.views === 1000)!.campaignLabel).toBe(CAMP_A_NAME);
    const outOfScope = scoped.publishedContent.rows.find((r) => r.views === 7000)!;
    expect(outOfScope.campaignLabel).toBeNull();
    expect(outOfScope).toMatchObject({ matchState: "MATCHED", likes: 700, comments: 70, engagement: 500 });
    expect(JSON.stringify(scoped)).not.toContain(CAMP_B_NAME);
    expect(JSON.stringify(scoped)).not.toContain(CAMP_B);
    const withGrant = (await workspace(await syntheticActor("a-camp", REGION_A, [{ type: "CAMPAIGN", campaignId: CAMP_B }]), { partners: PA1, month: "2019-03" })).single!;
    expect(withGrant.publishedContent.rows.find((r) => r.views === 7000)!.campaignLabel).toBe(CAMP_B_NAME);
  });
});

// ---- Bounded reads ---------------------------------------------------------------------------------------------

describe("Bounded reads - honest windows, truncation disclosed", () => {
  it("a comparison reads at most 3 pages per Partner / kind / platform; a single Partner up to 10; the no-selection scan at most 3", async () => {
    const actorA = await syntheticActor("a", REGION_A);
    const list = vi.mocked(explorerService.listAnalyticsSourceRecords);
    const actual = await vi.importActual<typeof import("./explorer-service")>("./explorer-service");
    const endless = async (_actor: unknown, input: unknown) => {
      const kind = (input as { recordKind: "content" | "channel" }).recordKind;
      return { ok: true, data: { recordKind: kind, records: [], nextCursor: { main: { orderValue: "x", uid: "x" } } } } as never;
    };
    try {
      list.mockClear();
      list.mockImplementation(endless);
      const many = await workspace(actorA, { partners: `${PA1},${PA2}` });
      expect(list.mock.calls).toHaveLength(2 * 2 * 2 * 3); // Partners x platforms x kinds x pages
      expect(many.comparison!.table.rows.every((r) => r.coverage.truncated)).toBe(true);
      expect(many.coverage.truncatedNote).toContain("bounded window");

      list.mockClear();
      const one = await workspace(actorA, { partners: PA1 });
      expect(list.mock.calls).toHaveLength(2 * 2 * 10);
      expect(one.single!.coverage).toEqual({ contentTruncated: true, channelTruncated: true });

      list.mockClear();
      const none = await workspace(actorA, {});
      expect(list.mock.calls).toHaveLength(2 * 2 * 3);
      expect(none.coverage.truncatedNote).toContain("bounded window");
    } finally {
      list.mockImplementation(actual.listAnalyticsSourceRecords);
      list.mockClear();
    }
    // Restored: an ordinary read is not truncated.
    expect((await workspace(actorA, { partners: `${PA1},${PA2}` })).coverage.truncatedNote).toBeNull();
  });
});

// ---- Explicit grants, no rank logic --------------------------------------------------------------------------------

describe("Authorization - explicit grants only", () => {
  it("Viewer (no explore action) and an unauthenticated caller are denied at the Analytics gate", async () => {
    expect(await getPartnersWorkspace(await seededActor("viewer"), { partners: PA1 })).toMatchObject({ ok: false, code: "unauthorized", reason: "action_denied" });
    expect(await getPartnersWorkspace(null, { partners: PA1 })).toMatchObject({ ok: false, code: "unauthorized", reason: "not_authenticated" });
  });

  it("Analyst, Partnership Manager, Partnership Head and Super Admin pass the gate; a Partner outside their own scope is dropped neutrally (no rank logic)", async () => {
    for (const role of ["analyst", "partnership_manager", "partnership_head", "super_admin"]) {
      const actor = await seededActor(role);
      const seeded = await workspace(actor, { partners: PSEED });
      expect(seeded.selector.selected.map((p) => p.displayName), `${role} in-scope`).toEqual([NAME[PSEED]]);
      const searched = await search(actor, { q: NAME[PSEED], region: [REGION_SEEDED_ROLES] });
      expect(names(searched.partners), `${role} search`).toEqual([NAME[PSEED]]);
      const outside = await workspace(actor, { partners: PA1 }); // region A: only the GLOBAL grant reaches it
      if (role === "super_admin") expect(outside.selector.selected.map((p) => p.displayName)).toEqual([NAME[PA1]]);
      else {
        expect(outside.selector.selected, `${role} out-of-scope`).toEqual([]);
        expect(outside.notices).toEqual(["1 selected Partner is not available"]);
      }
    }
  });

  it("Target Audience filtering can never widen a non-global actor's scope (Ember carries India 1 too)", async () => {
    const analyst = await seededActor("analyst");
    expect(names((await search(analyst, { q: NAME_PREFIX, targetAudience: ["India 1", "India 2", "India 3", "India Alpha", "India 4"] })).partners)).not.toContain(NAME[PB1]);
    expect(names((await search(analyst, { q: NAME_PREFIX, targetAudience: ["India 1"] })).partners)).not.toContain(NAME[PA1]);
  });
});

// ---- The search route: 401 / 403 / 200 -----------------------------------------------------------------------------

describe("GET /api/analytics/partners/search - route gating", () => {
  async function callRoute(actor: ActorContext | null, query: string) {
    const http = await import("@/server/analytics/http");
    vi.mocked(http.resolveRequestActor).mockResolvedValueOnce(actor);
    const { GET } = await import("@/app/api/analytics/partners/search/route");
    return GET(new Request(`http://localhost/api/analytics/partners/search${query}`));
  }

  it("unauthenticated -> 401, Viewer (no explore grant) -> 403, neither reveals anything", async () => {
    const unauthenticated = await callRoute(null, `?q=${NAME_PREFIX}`);
    expect(unauthenticated.status).toBe(401);
    expect(await unauthenticated.json()).toEqual({ error: "Forbidden." });
    const viewer = await callRoute(await seededActor("viewer"), `?q=${NAME_PREFIX}`);
    expect(viewer.status).toBe(403);
    expect(await viewer.json()).toEqual({ error: "Forbidden." });
  });

  it("an authorized actor gets 200 with scoped, safe results; repeated targetAudience / region params are honored; a bad limit is 400", async () => {
    const actorA = await syntheticActor("a", REGION_A);
    const ok = await callRoute(actorA, `?q=${NAME_PREFIX}&targetAudience=India%201&targetAudience=India%203&region=${encodeURIComponent(REGION_A)}`);
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { partners: { displayName: string }[]; hasMore: boolean };
    expect(names(body.partners)).toEqual([NAME[PA1], NAME[PA2], NAME[PA3]]);
    expect(JSON.stringify(body)).not.toContain(NAME[PB1]);
    expect((await callRoute(actorA, `?q=${NAME_PREFIX}&limit=nope`)).status).toBe(400);
  });
});
