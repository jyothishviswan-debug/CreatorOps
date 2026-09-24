import { getUserDocByRef } from "@/server/authz/firestore";
import type { ActorContext } from "@/server/authz/types";
import { listPartnerReviewHeads } from "@/server/partner-reviews/partner-review-list-service";

import { buildApprovalItemRef } from "../../ids";
import type { ApprovalItemDto } from "../types";

// Step 18A section 6: the Partner Reviews adapter. A Review "awaiting finalization" is exactly the
// IN_REVIEW status (see src/server/partner-reviews/types.ts's PARTNER_REVIEW_STATUSES /
// PARTNER_REVIEW_LIFECYCLE_TRANSITIONS: FINALIZED is reachable only from IN_REVIEW).
//
// READ-ONLY in this step (see approval-queue-service.ts's own top comment for why): finalizing a
// review is `finalize_approve`, gated by partner-reviews-gate.ts's own feature/action/scope chain
// AND by freshness/evidence preconditions this module never re-implements. The ONLY call this
// adapter ever makes into Partner Reviews is listPartnerReviewHeads - a published, actor-gated,
// bounded, already-safe-DTO read. No Partner Reviews Firestore collection, gate, or write function
// is imported anywhere in this module (proved by operations-static.test.ts).
export const PARTNER_REVIEWS_APPROVAL_SCAN_LIMIT = 50;

export async function listPendingPartnerReviewApprovals(actor: ActorContext | null): Promise<{ items: ApprovalItemDto[]; scanned: number }> {
  const result = await listPartnerReviewHeads(actor, { status: "IN_REVIEW", limit: PARTNER_REVIEWS_APPROVAL_SCAN_LIMIT });
  if (!result.ok) return { items: [], scanned: 0 };

  // A safe display-name resolution for `requestedBy` only (never a second copy of any review data) -
  // the same users/{uid} displayName lookup every module's own ownerDisplayName/partnerDisplayName
  // field already resolves. Deduped so two reviews updated by the same actor cost one lookup.
  const uniqueUpdaters = [...new Set(result.data.heads.map((head) => head.updatedByUserRef))];
  const displayNames = new Map(await Promise.all(uniqueUpdaters.map(async (userRef): Promise<[string, string | null]> => [userRef, (await getUserDocByRef(userRef))?.displayName ?? null])));

  const items: ApprovalItemDto[] = result.data.heads.map((head) => ({
    approvalItemRef: buildApprovalItemRef({ sourceModule: "partner_reviews", sourceType: "PARTNER_REVIEW", sourceRef: head.reviewRef, sourceVersion: head.latestVersion, actionType: "FINALIZE_PARTNER_REVIEW" }),
    sourceModule: "partner_reviews",
    sourceType: "PARTNER_REVIEW",
    sourceRef: head.reviewRef,
    sourceVersion: head.latestVersion,
    actionType: "FINALIZE_PARTNER_REVIEW",
    title: `Finalize review - ${head.partnerDisplayName ?? "Partner"} (${head.periodKey})`,
    summary: `In review since it was last updated on ${head.updatedAt}. Partner: ${head.partnerDisplayName ?? "unknown"}. Period: ${head.periodKey}.`,
    requestedBy: head.updatedByUserRef,
    requestedByDisplayName: displayNames.get(head.updatedByUserRef) ?? null,
    requestedAt: head.updatedAt,
    currentSourceStatus: head.latestStatus,
    allowedActions: [],
    safeDisplayData: { partnerDisplayName: head.partnerDisplayName, periodKey: head.periodKey, latestVersion: head.latestVersion },
  }));
  return { items, scanned: result.data.heads.length };
}
