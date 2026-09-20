import { randomUUID } from "node:crypto";

import type { Page } from "@playwright/test";

import { analyticsContentSourceRecordsCollection } from "@/server/analytics/firestore";
import { analyticsContentSourceRecordDocSchema } from "@/server/analytics/types";
import { assignmentsCollection } from "@/server/assignments/firestore";
import { assignmentBriefSchema, assignmentDocSchema } from "@/server/assignments/types";
import { EMULATOR_TEST_USERS } from "@/server/auth/seed-users";
import { resolveActor } from "@/server/authz/actor";
import { COLLECTIONS } from "@/server/authz/firestore";
import { scopeGrantDocId } from "@/server/authz/scope";
import type { ActorContext, ScopeGrant } from "@/server/authz/types";
import { campaignsCollection } from "@/server/campaigns/firestore";
import { campaignDocSchema } from "@/server/campaigns/types";
import { contentCollection } from "@/server/content/firestore";
import { contentDocSchema } from "@/server/content/types";
import { getAdminAuth, getAdminFirestore } from "@/server/firebase/admin";
import { partnersCollection } from "@/server/partners/firestore";
import { partnerDocSchema, type PartnerDoc } from "@/server/partners/types";
import type { GoverningCommercialPolicy } from "@/server/partner-reviews/commercial-policy";
import { buildEvidence } from "@/server/partner-reviews/evidence-builder";
import { PARTNER_REVIEWS_COLLECTIONS, partnerReviewsCollection, partnerReviewVersionsCollection } from "@/server/partner-reviews/firestore";
import { createPartnerReviewRevision, finalizePartnerReview, submitPartnerReviewForReview } from "@/server/partner-reviews/partner-review-lifecycle-service";
import { generatePartnerReviewDraft } from "@/server/partner-reviews/partner-review-service";
import { derivePeriod, reviewRefFor } from "@/server/partner-reviews/period";
import { buildHeadDisplay, computeReviewListSummary } from "@/server/partner-reviews/review-list-summary";
import { partnerReviewHeadDocSchema, partnerReviewVersionDocSchema } from "@/server/partner-reviews/types";

// Shared Admin-SDK fixtures for the Partner Reviews e2e specs (same idiom as analytics-partner-view.spec.ts):
// schema-valid documents written under a PRIVATE per-spec region that ONLY the fixture's own scope grants can
// reach (so no other spec's Partner / Assignment / Analytics list can ever see them), reviews created through the
// TRUSTED services (never hand-rolled business truth), review months in the PAST and distinct per spec, and
// everything removed again in cleanup().

export const PASSWORD = process.env.EMULATOR_TEST_USER_PASSWORD!;

export function emailFor(name: string): string {
  return EMULATOR_TEST_USERS.find((user) => user.email.startsWith(`${name}@`))!.email;
}

export async function signInAs(page: Page, name: "admin" | "manager" | "head" | "viewer" | "analyst") {
  await page.context().clearCookies();
  await page.goto("/sign-in");
  await page.getByPlaceholder("you@company.com").fill(emailFor(name));
  await page.getByPlaceholder("Enter your password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/dashboard$/);
}

const OLD = "2010-01-01T00:00:00.000Z";

export const VIEWPORTS = [1440, 1200, 1050, 760, 390, 375] as const;

export function createFixtures(tag: string) {
  const region = `${tag}-region`;
  const hiddenRegion = `${tag}-hidden`;
  const cleanup: FirebaseFirestore.DocumentReference[] = [];
  const reviewRefs = new Set<string>();
  const grantIds: string[] = [];
  let counter = 0;
  const now = () => new Date().toISOString();

  async function actorOf(name: "admin" | "manager" | "head" | "viewer" | "analyst"): Promise<ActorContext> {
    const user = await getAdminAuth().getUserByEmail(emailFor(name));
    const actor = await resolveActor(user.uid);
    if (!actor) throw new Error(`no actor for ${name}`);
    return actor;
  }

  // Lets the seeded non-global identities reach the fixture region (the ONLY thing that makes a private-region Partner visible to them).
  async function grantFixtureRegion(names: Array<"manager" | "head" | "viewer" | "analyst"> = ["manager", "head", "viewer", "analyst"]) {
    for (const name of names) {
      const user = await getAdminAuth().getUserByEmail(emailFor(name));
      const input = { type: "REGION" as const, region };
      const id = scopeGrantDocId(user.uid, input);
      await getAdminFirestore()
        .collection(COLLECTIONS.scopeAssignments)
        .doc(id)
        .set({ ...input, uid: user.uid, grantedAt: now(), grantedBy: `e2e:${tag}` } as ScopeGrant);
      grantIds.push(id);
    }
  }

  async function seedPartner(over: { displayName?: string; regionIds?: string[] } = {}): Promise<PartnerDoc> {
    counter += 1;
    const uid = `${tag}-partner-${counter}-${randomUUID().slice(0, 6)}`;
    const displayName = over.displayName ?? `E2E ${tag} Partner ${counter}`;
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
      regionIds: over.regionIds ?? [region],
      languageIds: [],
      categoryIds: [],
      tier: null,
      priority: null,
      targetAudience: [],
      email: null,
      phone: null,
      ownerUid: null,
      teamIds: [],
      originLeadRefs: [],
      sourceDiscovery: null,
      pendingPartnerAccountSetup: false,
      sequenceNumber: null,
      // Long past: Partner / Campaign lists order newest-first, and these fixtures (visible to the GLOBAL Super Admin
      // and to the seeded identities that hold the fixture-region grant) must never push another spec's own
      // records off the first page of a list.
      createdAt: OLD,
      createdByUserRef: "e2e",
      updatedAt: OLD,
      updatedByUserRef: "e2e",
    });
    const ref = partnersCollection().doc(uid);
    await ref.set(partner);
    cleanup.push(ref);
    return partner;
  }

  async function seedCampaign(name: string, regionIds: string[]) {
    const uid = campaignsCollection().doc().id;
    const campaign = campaignDocSchema.parse({
      uid,
      campaignRef: `${tag}-camp-${uid}`,
      version: 1,
      name,
      nameLower: name.toLowerCase(),
      objective: "Step 13B e2e fixture",
      status: "ACTIVE",
      statusReason: null,
      platforms: [],
      startDate: "2010-01-01",
      endDate: "2016-12-31",
      regionIds,
      ownerUid: null,
      teamIds: [],
      criteria: { targetAudience: [], regionIds: [], languageIds: [], categoryIds: [], platforms: [] },
      resources: [],
      defaultReviewPolicy: "REVIEW_REQUIRED",
      createdAt: OLD,
      createdByUserRef: "e2e",
      updatedAt: OLD,
      updatedByUserRef: "e2e",
    });
    const ref = campaignsCollection().doc(uid);
    await ref.set(campaign);
    cleanup.push(ref);
    return campaign;
  }

  async function seedAssignment(partnerRef: string, over: { dueAt?: string; status?: string; regionIds?: string[]; campaignRef?: string; campaignName?: string } = {}) {
    const uid = assignmentsCollection().doc().id;
    const assignment = assignmentDocSchema.parse({
      uid,
      assignmentRef: `${tag}-as-${uid}`,
      version: 1,
      campaignRef: over.campaignRef ?? `${tag}-camp`,
      partnerRef,
      partnerAccountRefs: [],
      status: over.status ?? "IN_PROGRESS",
      statusReason: null,
      brief: assignmentBriefSchema.parse({ dueAt: over.dueAt ?? "2015-04-10", requiredCount: 2, formats: ["reel"], platforms: ["instagram"], reviewPolicy: "REVIEW_REQUIRED", campaignName: over.campaignName ?? `${tag} Campaign` }),
      ownerUid: null,
      regionIds: over.regionIds ?? [region],
      teamIds: [],
      createdAt: "2010-01-05T08:00:00.000Z",
      createdByUserRef: "e2e",
      updatedAt: now(),
      updatedByUserRef: "e2e",
    });
    const ref = assignmentsCollection().doc(uid);
    await ref.set(assignment);
    cleanup.push(ref);
    return assignment;
  }

  async function seedThread(assignment: { assignmentRef: string; campaignRef: string; partnerRef: string }, over: { status?: string; regionIds?: string[]; approvedAt?: string | null; url?: string; month?: string } = {}) {
    const uid = contentCollection().doc().id;
    const month = over.month ?? "2015-04";
    const thread = contentDocSchema.parse({
      uid,
      contentRef: `${tag}-ct-${uid}`,
      version: 3,
      assignmentRef: assignment.assignmentRef,
      campaignRef: assignment.campaignRef,
      partnerRef: assignment.partnerRef,
      status: over.status ?? "UNDER_REVIEW",
      statusReason: null,
      currentRevisionNumber: 1,
      reviewedRevisionNumber: 1,
      currentLinks: [{ platform: "instagram", originalUrl: over.url ?? `https://instagram.com/p/E2E${uid}`, normalizedUrl: over.url ?? `https://instagram.com/p/e2e${uid.toLowerCase()}`, recordedAt: `${month}-08T10:00:00.000Z` }],
      qualifyingFulfillment: null,
      dueAt: null,
      openedAt: `${month}-01T00:00:00.000Z`,
      firstSubmittedAt: `${month}-08T10:00:00.000Z`,
      lastSubmittedAt: `${month}-08T10:00:00.000Z`,
      approvedAt: over.approvedAt ?? null,
      cancelledAt: null,
      ownerUid: null,
      regionIds: over.regionIds ?? [region],
      teamIds: [],
      createdAt: `${month}-01T00:00:00.000Z`,
      createdByUserRef: "e2e",
      updatedAt: `${month}-08T10:00:00.000Z`,
      updatedByUserRef: "e2e",
    });
    const ref = contentCollection().doc(uid);
    await ref.set(thread);
    cleanup.push(ref);
    return thread;
  }

  async function seedAnalytics(partnerRef: string, over: { contentRef?: string | null; platform?: "instagram" | "youtube"; likes?: number | null; views?: number | null; month?: string; regionIds?: string[]; postUrl?: string } = {}) {
    const uid = `${tag}-an-${randomUUID()}`;
    const month = over.month ?? "2015-04";
    const record = analyticsContentSourceRecordDocSchema.parse({
      uid,
      sourceRef: uid,
      batchRef: `${tag}-batch`,
      sheetName: "Posts",
      sourceRowNumber: 2,
      platform: over.platform ?? "instagram",
      rowIdentityKey: `${tag}:${uid}`,
      rawPostId: null,
      rawPostUrl: "https://instagram.com/p/raw-secret-caption-source",
      rawPostType: null,
      rawPostDateTime: null,
      rawMediaUrl: null,
      rawCaption: "RAW CAPTION MUST NEVER LEAK",
      rawComments: null,
      rawLikes: null,
      rawViews: null,
      rawFollowers: null,
      rawUsername: "rawusername",
      rawEngagement: null,
      rawAccountOrChannelName: null,
      normalizedUrl: over.postUrl ?? `https://instagram.com/p/${uid}`,
      postDateTimeIso: `${month}-09T10:00:00.000Z`,
      comments: null,
      likes: over.likes === undefined ? 120 : over.likes,
      views: over.views === undefined ? null : over.views,
      profileFollowers: null,
      engagement: null,
      reportingPeriod: { start: `${month}-01`, end: `${month}-28` },
      matchState: "MATCHED",
      matchEvidence: { tier: "published_url", value: null, reasonCode: null, candidateCount: 1 },
      matchedContentRef: over.contentRef ?? null,
      matchedAssignmentRef: null,
      matchedCampaignRef: null,
      matchedPartnerRef: partnerRef,
      matchedPartnerAccountRef: null,
      ownerUid: null,
      regionIds: over.regionIds ?? [region],
      teamIds: [],
      createdAt: "2015-05-02T00:00:00.000Z",
    });
    const ref = analyticsContentSourceRecordsCollection().doc(uid);
    await ref.set(record);
    cleanup.push(ref);
    return record;
  }

  // A Partner with one in-period Assignment, its Content thread and one matched Analytics record.
  async function seedRich(over: { month?: string; displayName?: string; threadStatus?: string; likes?: number; views?: number | null; regionIds?: string[] } = {}) {
    const month = over.month ?? "2015-04";
    const partner = await seedPartner({ displayName: over.displayName, regionIds: over.regionIds });
    const assignment = await seedAssignment(partner.partnerRef, { dueAt: `${month}-10`, regionIds: over.regionIds });
    const thread = await seedThread(assignment, { month, status: over.threadStatus, regionIds: over.regionIds, approvedAt: over.threadStatus === "APPROVED" ? `${month}-09T00:00:00.000Z` : null });
    const record = await seedAnalytics(partner.partnerRef, { contentRef: thread.contentRef, likes: over.likes, views: over.views, month, regionIds: over.regionIds });
    return { partner, assignment, thread, record };
  }

  // ---- Reviews through the TRUSTED services ------------------------------------------------------------------------------
  async function generate(partnerRef: string, periodKey: string, as: "admin" | "manager" | "head" = "manager") {
    const result = await generatePartnerReviewDraft(await actorOf(as), { partnerRef, periodKey }, `req-${randomUUID().slice(0, 8)}`);
    if (!result.ok) throw new Error(`generate failed: ${result.code} ${result.message}`);
    reviewRefs.add(result.data.review.head.reviewRef);
    return result.data.review;
  }

  async function submit(reviewRef: string, docVersion: number) {
    const result = await submitPartnerReviewForReview(await actorOf("manager"), reviewRef, { expectedDocVersion: docVersion }, "req-submit");
    if (!result.ok) throw new Error(`submit failed: ${result.message}`);
    return result.data;
  }

  async function finalize(reviewRef: string, docVersion: number) {
    const result = await finalizePartnerReview(await actorOf("head"), reviewRef, { expectedDocVersion: docVersion }, "req-finalize");
    if (!result.ok) throw new Error(`finalize failed: ${result.message}`);
    return result.data;
  }

  async function revise(reviewRef: string, headDocVersion: number) {
    const result = await createPartnerReviewRevision(await actorOf("manager"), reviewRef, { expectedDocVersion: headDocVersion }, "req-revision");
    if (!result.ok) throw new Error(`revision failed: ${result.message}`);
    return result.data;
  }

  async function generateInReview(partnerRef: string, periodKey: string) {
    const draft = await generate(partnerRef, periodKey);
    return { reviewRef: draft.head.reviewRef, review: await submit(draft.head.reviewRef, draft.selectedVersion!.docVersion) };
  }

  async function generateFinalized(partnerRef: string, periodKey: string) {
    const { reviewRef, review } = await generateInReview(partnerRef, periodKey);
    return { reviewRef, review: await finalize(reviewRef, review.selectedVersion!.docVersion) };
  }

  // A review head + version written DIRECTLY (schema-valid, with its display projection): a cheap way to build many
  // reviews / a long month history without one evidence collection per review. `policy` builds the snapshot's
  // commercial section through the accepted pure builder (an Agreement-governed month).
  async function seedDirectReview(partner: PartnerDoc, periodKey: string, over: { status?: "DRAFT" | "IN_REVIEW" | "FINALIZED"; policy?: GoverningCommercialPolicy; latestVersion?: number; hint?: "refresh_available" | "revision_available" | "current" } = {}) {
    const period = derivePeriod(periodKey)!;
    const built = buildEvidence({ partnerRef: partner.partnerRef, period, evidenceCutoff: "2017-01-01T00:00:00.000Z", assignments: [], assignmentScanTruncated: false, assignmentsScanned: 0, threads: [], analyticsRecords: [], analyticsScanTruncated: false, analyticsRecordsScanned: 0, commercialPolicy: over.policy ?? null });
    const reviewRef = reviewRefFor(partner.partnerRef, periodKey);
    const status = over.status ?? "DRAFT";
    const stamp = "2017-01-02T00:00:00.000Z";
    const latestVersion = over.latestVersion ?? 1;
    const version = partnerReviewVersionDocSchema.parse({
      reviewRef,
      version: latestVersion,
      status,
      docVersion: 1,
      snapshot: built.snapshot,
      evidenceCutoff: built.snapshot.evidenceCutoff,
      sourceFingerprint: built.sourceFingerprint,
      sourceRefs: built.sourceRefs,
      generatedAt: stamp,
      generatedByUserRef: "e2e",
      finalizedAt: status === "FINALIZED" ? stamp : null,
      finalizedByUserRef: status === "FINALIZED" ? "e2e" : null,
      createdAt: stamp,
      createdByUserRef: "e2e",
      summary: computeReviewListSummary(built.snapshot),
    });
    const head = partnerReviewHeadDocSchema.parse({
      reviewRef,
      partnerRef: partner.partnerRef,
      partnerUid: partner.uid,
      periodKey,
      periodStart: period.periodStart,
      periodEnd: period.periodEnd,
      latestVersion,
      latestStatus: status,
      currentFinalizedVersion: status === "FINALIZED" ? latestVersion : null,
      openVersion: status === "FINALIZED" ? null : latestVersion,
      docVersion: 1,
      ownerUid: partner.ownerUid,
      regionIds: partner.regionIds,
      teamIds: partner.teamIds,
      createdAt: stamp,
      createdByUserRef: "e2e",
      updatedAt: stamp,
      updatedByUserRef: "e2e",
      display: buildHeadDisplay({ version, latestVersion, event: { kind: status === "FINALIZED" ? "finalized" : "generated", at: stamp }, finalized: status === "FINALIZED" ? { version: latestVersion, at: stamp } : null }),
      ...(over.hint ? { freshnessHint: { state: over.hint, checkedAt: "2017-01-03T00:00:00.000Z" } } : {}),
    });
    await partnerReviewsCollection().doc(reviewRef).set(head);
    await partnerReviewVersionsCollection(reviewRef).doc(String(latestVersion)).set(version);
    reviewRefs.add(reviewRef);
    return { reviewRef, head, version };
  }

  async function cleanupAll() {
    await Promise.all(cleanup.splice(0).map((ref) => ref.delete()));
    for (const reviewRef of reviewRefs) {
      const head = partnerReviewsCollection().doc(reviewRef);
      for (const sub of [PARTNER_REVIEWS_COLLECTIONS.versions, PARTNER_REVIEWS_COLLECTIONS.events]) {
        const docs = await head.collection(sub).get();
        await Promise.all(docs.docs.map((d) => d.ref.delete()));
      }
      await head.delete();
    }
    reviewRefs.clear();
    await Promise.all(grantIds.splice(0).map((id) => getAdminFirestore().collection(COLLECTIONS.scopeAssignments).doc(id).delete()));
  }

  return { tag, region, hiddenRegion, actorOf, grantFixtureRegion, seedPartner, seedCampaign, seedAssignment, seedThread, seedAnalytics, seedRich, generate, submit, finalize, revise, generateInReview, generateFinalized, seedDirectReview, cleanupAll };
}

export type Fixtures = ReturnType<typeof createFixtures>;

// document-level horizontal overflow (the documented responsive contract of this module)
export async function noDocumentOverflow(page: Page): Promise<{ scrollWidth: number; innerWidth: number }> {
  return page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
}
