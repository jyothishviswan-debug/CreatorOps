import type { ActionId } from "@/server/authz/actions";
import { canAccessFeature, canPerformAction } from "@/server/authz/capabilities";
import { getActorScopeGrants, hasGlobalScope, isCampaignInScope, isExplicitRecordInScope, isRegionInScope, isSelfInScope, isTeamInScope } from "@/server/authz/scope";
import type { ActorContext, ScopeGrant } from "@/server/authz/types";
import type { CampaignsDenialReason } from "./types";

export type CampaignsAccessResult = { ok: true } | { ok: false; reason: CampaignsDenialReason };

// Same shape as Vendors' requireVendorsAccess: Feature + Action access
// gates whether the actor may use Campaigns at all. Campaigns is a
// record-scoped domain, not a system-wide one - per-record scope
// (requireCampaignInScope) is checked separately by each service against
// the specific record/operation involved.
export async function requireCampaignsAccess(actor: ActorContext | null, action: ActionId): Promise<CampaignsAccessResult> {
  if (!actor) return { ok: false, reason: "not_authenticated" };

  const hasFeature = await canAccessFeature(actor, "campaigns");
  if (!hasFeature) return { ok: false, reason: "feature_denied" };

  const hasAction = await canPerformAction(actor, "campaigns", action);
  if (!hasAction) return { ok: false, reason: "action_denied" };

  return { ok: true };
}

// Feature-only gate for read operations (list/get/readiness) - "can this
// actor see Campaigns data at all", independent of any specific mutation
// action.
export async function requireCampaignsFeatureAccess(actor: ActorContext | null): Promise<CampaignsAccessResult> {
  if (!actor) return { ok: false, reason: "not_authenticated" };
  const hasFeature = await canAccessFeature(actor, "campaigns");
  return hasFeature ? { ok: true } : { ok: false, reason: "feature_denied" };
}

// Record Scope, applied to one already-loaded Campaign. GLOBAL, SELF (via
// ownerUid), REGION/TEAM (via the Campaign's own dimensions), the
// dedicated CAMPAIGN grant type (naming this Campaign specifically - see
// @/server/authz/scope.ts's isCampaignInScope), or an EXPLICIT_RECORD
// grant naming it. Deliberately built WITHOUT any "does this Campaign's
// targeting criteria mention a region/category I can see" check -
// Campaign business criteria describe who the programme is intended for,
// never authorization scope (Step 9A section 4/9's explicit rule).
// Pure, in-memory form of the Record Scope decision below - the ONE place
// the rule lives. requireCampaignInScope delegates to it; bulk callers that
// already hold the actor's grants (e.g. Partner Reviews' source-context
// redaction, which must evaluate up to ~200 Campaigns without re-reading
// the grants once per record) call it directly. Behavior-identical.
export function isCampaignDocInScope(grants: ScopeGrant[], actorUid: string, campaign: { uid: string; ownerUid: string | null; regionIds: string[]; teamIds: string[] }): boolean {
  return (
    hasGlobalScope(grants) ||
    isSelfInScope(grants, actorUid, campaign.ownerUid ?? undefined) ||
    campaign.regionIds.some((region) => isRegionInScope(grants, region)) ||
    campaign.teamIds.some((teamId) => isTeamInScope(grants, teamId)) ||
    isCampaignInScope(grants, campaign.uid) ||
    isExplicitRecordInScope(grants, "campaign", campaign.uid)
  );
}

export async function requireCampaignInScope(
  actor: ActorContext,
  campaign: { uid: string; ownerUid: string | null; regionIds: string[]; teamIds: string[] },
): Promise<CampaignsAccessResult> {
  const grants = await getActorScopeGrants(actor);
  return isCampaignDocInScope(grants, actor.uid, campaign) ? { ok: true } : { ok: false, reason: "scope_denied" };
}
