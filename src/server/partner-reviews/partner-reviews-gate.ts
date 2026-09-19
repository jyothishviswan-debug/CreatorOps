import type { ActionId } from "@/server/authz/actions";
import { canAccessFeature, canPerformAction } from "@/server/authz/capabilities";
import type { ActorContext } from "@/server/authz/types";
import { getPartnerDocByRef } from "@/server/partners/firestore";
import { requirePartnerInScope } from "@/server/partners/partners-gate";
import type { PartnerDoc } from "@/server/partners/types";
import { partnerReviewsUnauthorizedResult, type PartnerReviewsDenialReason, type PartnerReviewsErrorResult } from "./types";

export type PartnerReviewsAccessResult = { ok: true } | { ok: false; reason: PartnerReviewsDenialReason };

// Same shape as Assignments' requireAssignmentsAccess: Feature + Action
// access gates whether the actor may perform this workflow step at all.
// Explicit grants only - no rank inheritance, no wildcard, no
// minimumRole. Record Scope is checked separately (below) against the
// underlying Partner.
export async function requirePartnerReviewsAccess(actor: ActorContext | null, action: ActionId): Promise<PartnerReviewsAccessResult> {
  if (!actor) return { ok: false, reason: "not_authenticated" };

  const hasFeature = await canAccessFeature(actor, "partner_reviews");
  if (!hasFeature) return { ok: false, reason: "feature_denied" };

  const hasAction = await canPerformAction(actor, "partner_reviews", action);
  if (!hasAction) return { ok: false, reason: "action_denied" };

  return { ok: true };
}

// Feature-only gate for reads (list/get/freshness/needs-review) - "can this
// actor see Partner Reviews at all", independent of any mutation action.
export async function requirePartnerReviewsFeatureAccess(actor: ActorContext | null): Promise<PartnerReviewsAccessResult> {
  if (!actor) return { ok: false, reason: "not_authenticated" };
  const hasFeature = await canAccessFeature(actor, "partner_reviews");
  return hasFeature ? { ok: true } : { ok: false, reason: "feature_denied" };
}

// Record Scope for a review IS the underlying Partner's Record Scope. The
// LIVE Partner is loaded and the accepted requirePartnerInScope check is
// applied as-is on every detail/mutation/derive path. A review's own
// stored scope fields are never consulted here (they exist only to serve
// bounded scoped list queries), and knowing a reviewRef never grants
// access. A missing Partner and an out-of-scope Partner produce distinct
// outcomes only where the caller chooses to (see loadAuthorizedPartner).
export async function loadAuthorizedPartner(
  actor: ActorContext,
  partnerRef: string,
): Promise<{ ok: true; partner: PartnerDoc } | { ok: false; kind: "missing" } | { ok: false; kind: "denied"; error: PartnerReviewsErrorResult }> {
  const partner = await getPartnerDocByRef(partnerRef);
  if (!partner) return { ok: false, kind: "missing" };

  const scopeCheck = await requirePartnerInScope(actor, partner);
  if (!scopeCheck.ok) return { ok: false, kind: "denied", error: partnerReviewsUnauthorizedResult("scope_denied") };

  return { ok: true, partner };
}
