import { randomUUID } from "node:crypto";

import { z } from "zod";

import type { ActorContext } from "@/server/authz/types";
import { requireContentInScope } from "@/server/content/content-gate";
import { getContentDocByRef } from "@/server/content/firestore";
import { getAdminFirestore } from "@/server/firebase/admin";
import { getPartnerAccountDocByRef, getPartnerDocByRef } from "@/server/partners/firestore";
import { requirePartnerInScope } from "@/server/partners/partners-gate";

import { requireAnalyticsManageAccess } from "./analytics-gate";
import {
  analyticsChannelSourceRecordCorrectionsCollection,
  analyticsChannelSourceRecordsCollection,
  analyticsContentSourceRecordCorrectionsCollection,
  analyticsContentSourceRecordsCollection,
  getAnalyticsChannelSourceRecordByRef,
  getAnalyticsContentSourceRecordByRef,
} from "./firestore";
import {
  analyticsChannelSourceRecordDocSchema,
  analyticsContentSourceRecordDocSchema,
  analyticsInvalidInputResult,
  analyticsNotFoundResult,
  analyticsSourceRecordCorrectionDocSchema,
  analyticsUnauthorizedResult,
  type AnalyticsChannelSourceRecordDoc,
  type AnalyticsContentSourceRecordDoc,
  type AnalyticsMatchEvidence,
  type AnalyticsServiceResult,
  type AnalyticsSourceRecordCorrectionDoc,
} from "./types";

// Step 12A section 13: the trusted, no-UI match correction/resolution
// contract. Never edits Content/Assignment/Partner/Partner Account -
// only ever reads them (to validate the new target and its scope), and
// only ever writes to the Analytics source record's own fields/
// subcollection. Preconditions, in order: feature+action access, target
// exists, target is platform-compatible with the record, target is
// within the actor's own scope, the caller's expectedRevision matches
// the record's own current correctionRevision (an optimistic-
// concurrency-equivalent precondition, since these are otherwise
// immutable records with no ordinary `version` field), and a real reason
// is captured. Previous match evidence/history is preserved via the
// append-only `corrections` subcollection - never overwritten in place;
// the record's own top-level matchState/matchedXRef fields DO get
// updated to the new CURRENT resolution, since ordinary readers need the
// current state without also reading correction history.
const resolveInputSchema = z.object({
  recordKind: z.enum(["content", "channel"]),
  sourceRef: z.string().min(1),
  // null explicitly clears the match (manually marks UNMATCHED).
  targetRef: z.string().min(1).nullable(),
  expectedRevision: z.number().int().min(1),
  reason: z.string().min(1).max(1000),
});
export type ResolveAnalyticsSourceRecordMatchInput = z.input<typeof resolveInputSchema>;

export type ResolveAnalyticsSourceRecordMatchResult = { sourceRef: string; matchState: string; correctionRevision: number };

export async function resolveAnalyticsSourceRecordMatch(
  actor: ActorContext | null,
  rawInput: unknown,
  requestId: string,
): Promise<AnalyticsServiceResult<ResolveAnalyticsSourceRecordMatchResult>> {
  const gate = await requireAnalyticsManageAccess(actor);
  if (!gate.ok) return analyticsUnauthorizedResult(gate.reason);

  const parsed = resolveInputSchema.safeParse(rawInput);
  if (!parsed.success) return analyticsInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));
  const input = parsed.data;

  if (input.recordKind === "content") return resolveContentMatch(actor!, input, requestId);
  return resolveChannelMatch(actor!, input, requestId);
}

async function resolveContentMatch(
  actor: ActorContext,
  input: ResolveAnalyticsSourceRecordMatchInput,
  requestId: string,
): Promise<AnalyticsServiceResult<ResolveAnalyticsSourceRecordMatchResult>> {
  const record = await getAnalyticsContentSourceRecordByRef(input.sourceRef);
  if (!record) return analyticsNotFoundResult("Analytics content source record not found.");
  if (record.correctionRevision !== input.expectedRevision) return { ok: false, code: "stale_write", message: "This record has already been corrected by someone else - reload and retry." };

  let newMatchEvidence: AnalyticsMatchEvidence;
  let newMatchedContentRef: string | null = null;
  let newMatchedAssignmentRef: string | null = null;
  let newMatchedCampaignRef: string | null = null;
  let newMatchedPartnerRef: string | null = null;
  let newMatchState: "MATCHED" | "UNMATCHED";
  let newOwnerUid: string | null = null;
  let newRegionIds: string[] = [];
  let newTeamIds: string[] = [];

  if (input.targetRef === null) {
    newMatchState = "UNMATCHED";
    newMatchEvidence = { tier: "none", value: null, reasonCode: "MANUAL_CORRECTION_CLEARED", candidateCount: 0 };
  } else {
    const content = await getContentDocByRef(input.targetRef);
    if (!content) return analyticsInvalidInputResult(`Content "${input.targetRef}" not found.`);
    if (!content.currentLinks.some((link) => link.platform === record.platform)) {
      return analyticsInvalidInputResult(`Content "${input.targetRef}" has no current link on platform "${record.platform}" - not platform-compatible with this source record.`);
    }
    const scopeCheck = await requireContentInScope(actor, content);
    if (!scopeCheck.ok) return analyticsUnauthorizedResult(scopeCheck.reason);

    newMatchState = "MATCHED";
    newMatchEvidence = { tier: "published_url", value: record.normalizedUrl, reasonCode: "MANUAL_CORRECTION", candidateCount: 1 };
    newMatchedContentRef = content.contentRef;
    newMatchedAssignmentRef = content.assignmentRef;
    newMatchedCampaignRef = content.campaignRef;
    newMatchedPartnerRef = content.partnerRef;
    newOwnerUid = content.ownerUid;
    newRegionIds = content.regionIds;
    newTeamIds = content.teamIds;
  }

  const db = getAdminFirestore();
  const docRef = analyticsContentSourceRecordsCollection().doc(record.uid);

  const result = await db.runTransaction<{ ok: true; correctionRevision: number } | { ok: false }>(async (tx) => {
    const snap = await tx.get(docRef);
    if (!snap.exists) return { ok: false };
    const current = analyticsContentSourceRecordDocSchema.parse(snap.data());
    if (current.correctionRevision !== input.expectedRevision) return { ok: false };

    const nextRevision = current.correctionRevision + 1;
    const now = new Date().toISOString();

    const correction: AnalyticsSourceRecordCorrectionDoc = analyticsSourceRecordCorrectionDocSchema.parse({
      uid: analyticsContentSourceRecordCorrectionsCollection(record.uid).doc().id,
      recordKind: "content",
      previousMatchState: current.matchState,
      previousMatchEvidence: current.matchEvidence,
      previousMatchedRefs: {
        matchedContentRef: current.matchedContentRef,
        matchedAssignmentRef: current.matchedAssignmentRef,
        matchedCampaignRef: current.matchedCampaignRef,
        matchedPartnerRef: current.matchedPartnerRef,
        matchedPartnerAccountRef: current.matchedPartnerAccountRef,
      },
      newMatchState,
      newMatchEvidence,
      newMatchedRefs: {
        matchedContentRef: newMatchedContentRef,
        matchedAssignmentRef: newMatchedAssignmentRef,
        matchedCampaignRef: newMatchedCampaignRef,
        matchedPartnerRef: newMatchedPartnerRef,
        matchedPartnerAccountRef: current.matchedPartnerAccountRef,
      },
      reason: input.reason,
      actorUserRef: actor.userRef,
      requestId,
      correctionRevision: nextRevision,
      createdAt: now,
    });

    const next: AnalyticsContentSourceRecordDoc = {
      ...current,
      matchState: newMatchState,
      matchEvidence: newMatchEvidence,
      matchedContentRef: newMatchedContentRef,
      matchedAssignmentRef: newMatchedAssignmentRef,
      matchedCampaignRef: newMatchedCampaignRef,
      matchedPartnerRef: newMatchedPartnerRef,
      ownerUid: newOwnerUid,
      regionIds: newRegionIds,
      teamIds: newTeamIds,
      correctionRevision: nextRevision,
    };

    tx.set(docRef, next);
    tx.set(analyticsContentSourceRecordCorrectionsCollection(record.uid).doc(correction.uid), correction);
    return { ok: true, correctionRevision: nextRevision };
  });

  if (!result.ok) return { ok: false, code: "stale_write", message: "This record has already been corrected by someone else - reload and retry." };
  return { ok: true, data: { sourceRef: record.sourceRef, matchState: newMatchState, correctionRevision: result.correctionRevision } };
}

async function resolveChannelMatch(
  actor: ActorContext,
  input: ResolveAnalyticsSourceRecordMatchInput,
  requestId: string,
): Promise<AnalyticsServiceResult<ResolveAnalyticsSourceRecordMatchResult>> {
  const record = await getAnalyticsChannelSourceRecordByRef(input.sourceRef);
  if (!record) return analyticsNotFoundResult("Analytics channel source record not found.");
  if (record.correctionRevision !== input.expectedRevision) return { ok: false, code: "stale_write", message: "This record has already been corrected by someone else - reload and retry." };

  let newMatchEvidence: AnalyticsMatchEvidence;
  let newMatchedPartnerRef: string | null = null;
  let newMatchedPartnerAccountRef: string | null = null;
  let newMatchState: "MATCHED" | "UNMATCHED";
  let newOwnerUid: string | null = null;
  let newRegionIds: string[] = [];
  let newTeamIds: string[] = [];

  if (input.targetRef === null) {
    newMatchState = "UNMATCHED";
    newMatchEvidence = { tier: "none", value: null, reasonCode: "MANUAL_CORRECTION_CLEARED", candidateCount: 0 };
  } else {
    const account = await getPartnerAccountDocByRef(input.targetRef);
    if (!account) return analyticsInvalidInputResult(`Partner Account "${input.targetRef}" not found.`);
    if (account.platform !== record.platform) {
      return analyticsInvalidInputResult(`Partner Account "${input.targetRef}" is on platform "${account.platform}", not platform-compatible with this source record's "${record.platform}".`);
    }
    const partner = await getPartnerDocByRef(account.partnerRef);
    if (!partner) return analyticsInvalidInputResult(`Partner Account "${input.targetRef}" has no owning Partner.`);
    const scopeCheck = await requirePartnerInScope(actor, partner);
    // requirePartnerInScope only ever fails with "scope_denied" - Partners'
    // own broader PartnersDenialReason union (which also carries
    // "sensitive_denied", not a valid AnalyticsDenialReason) is narrowed
    // explicitly here rather than passed through.
    if (!scopeCheck.ok) return analyticsUnauthorizedResult("scope_denied");

    newMatchState = "MATCHED";
    newMatchEvidence = { tier: "identity_claim", value: account.normalizedIdentity, reasonCode: "MANUAL_CORRECTION", candidateCount: 1 };
    newMatchedPartnerRef = account.partnerRef;
    newMatchedPartnerAccountRef = account.partnerAccountRef;
    newOwnerUid = partner.ownerUid;
    newRegionIds = partner.regionIds;
    newTeamIds = partner.teamIds;
  }

  const db = getAdminFirestore();
  const docRef = analyticsChannelSourceRecordsCollection().doc(record.uid);

  const result = await db.runTransaction<{ ok: true; correctionRevision: number } | { ok: false }>(async (tx) => {
    const snap = await tx.get(docRef);
    if (!snap.exists) return { ok: false };
    const current = analyticsChannelSourceRecordDocSchema.parse(snap.data());
    if (current.correctionRevision !== input.expectedRevision) return { ok: false };

    const nextRevision = current.correctionRevision + 1;
    const now = new Date().toISOString();

    const correction: AnalyticsSourceRecordCorrectionDoc = analyticsSourceRecordCorrectionDocSchema.parse({
      uid: analyticsChannelSourceRecordCorrectionsCollection(record.uid).doc().id,
      recordKind: "channel",
      previousMatchState: current.matchState,
      previousMatchEvidence: current.matchEvidence,
      previousMatchedRefs: { matchedPartnerRef: current.matchedPartnerRef, matchedPartnerAccountRef: current.matchedPartnerAccountRef },
      newMatchState,
      newMatchEvidence,
      newMatchedRefs: { matchedPartnerRef: newMatchedPartnerRef, matchedPartnerAccountRef: newMatchedPartnerAccountRef },
      reason: input.reason,
      actorUserRef: actor.userRef,
      requestId,
      correctionRevision: nextRevision,
      createdAt: now,
    });

    const next: AnalyticsChannelSourceRecordDoc = {
      ...current,
      matchState: newMatchState,
      matchEvidence: newMatchEvidence,
      matchedPartnerRef: newMatchedPartnerRef,
      matchedPartnerAccountRef: newMatchedPartnerAccountRef,
      ownerUid: newOwnerUid,
      regionIds: newRegionIds,
      teamIds: newTeamIds,
      correctionRevision: nextRevision,
    };

    tx.set(docRef, next);
    tx.set(analyticsChannelSourceRecordCorrectionsCollection(record.uid).doc(correction.uid), correction);
    return { ok: true, correctionRevision: nextRevision };
  });

  if (!result.ok) return { ok: false, code: "stale_write", message: "This record has already been corrected by someone else - reload and retry." };
  return { ok: true, data: { sourceRef: record.sourceRef, matchState: newMatchState, correctionRevision: result.correctionRevision } };
}

// requestId is threaded through for audit parity with every other
// trusted mutation in this codebase, even though this module has no
// separate append-only "events" collection of its own - the corrections
// subcollection already serves that role for this domain.
export function newCorrectionRequestId(): string {
  return randomUUID();
}
