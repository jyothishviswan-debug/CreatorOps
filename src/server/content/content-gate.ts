import type { ActionId } from "@/server/authz/actions";
import { canAccessFeature, canPerformAction } from "@/server/authz/capabilities";
import { getActorScopeGrants, hasGlobalScope, isExplicitRecordInScope, isRegionInScope, isSelfInScope, isTeamInScope } from "@/server/authz/scope";
import type { ActorContext, ScopeGrant } from "@/server/authz/types";
import type { ContentDenialReason } from "./types";

export type ContentAccessResult = { ok: true } | { ok: false; reason: ContentDenialReason };

// Same shape as Assignments' requireAssignmentsAccess: Feature + Action
// access gates whether the actor may use Content at all. Content is a
// record-scoped domain, not a system-wide one - per-record scope
// (requireContentInScope) is checked separately by each service against
// the specific record/operation involved.
export async function requireContentAccess(actor: ActorContext | null, action: ActionId): Promise<ContentAccessResult> {
  if (!actor) return { ok: false, reason: "not_authenticated" };

  const hasFeature = await canAccessFeature(actor, "content");
  if (!hasFeature) return { ok: false, reason: "feature_denied" };

  const hasAction = await canPerformAction(actor, "content", action);
  if (!hasAction) return { ok: false, reason: "action_denied" };

  return { ok: true };
}

// Feature-only gate for read operations (list/get/history) - "can this
// actor see Content data at all", independent of any specific mutation
// action.
export async function requireContentFeatureAccess(actor: ActorContext | null): Promise<ContentAccessResult> {
  if (!actor) return { ok: false, reason: "not_authenticated" };
  const hasFeature = await canAccessFeature(actor, "content");
  return hasFeature ? { ok: true } : { ok: false, reason: "feature_denied" };
}

// Record Scope, applied to one already-loaded Content record. GLOBAL,
// SELF (via ownerUid), REGION/TEAM (via the Content's own dimensions -
// both snapshotted from the owning Assignment at creation, never
// live-looked-up - see types.ts), or an EXPLICIT_RECORD grant naming it
// (resourceType "content" - already precedented in
// seed-access-data.ts/scope.test.ts).
// Pure, in-memory form of the Record Scope decision below - the ONE place
// the rule lives. requireContentInScope delegates to it; bulk callers that
// already hold the actor's grants (Partner Reviews' source-context
// redaction) call it directly instead of re-reading the grants per record.
export function isContentDocInScope(grants: ScopeGrant[], actorUid: string, content: { uid: string; ownerUid: string | null; regionIds: string[]; teamIds: string[] }): boolean {
  return (
    hasGlobalScope(grants) ||
    isSelfInScope(grants, actorUid, content.ownerUid ?? undefined) ||
    content.regionIds.some((region) => isRegionInScope(grants, region)) ||
    content.teamIds.some((teamId) => isTeamInScope(grants, teamId)) ||
    isExplicitRecordInScope(grants, "content", content.uid)
  );
}

export async function requireContentInScope(
  actor: ActorContext,
  content: { uid: string; ownerUid: string | null; regionIds: string[]; teamIds: string[] },
): Promise<ContentAccessResult> {
  const grants = await getActorScopeGrants(actor);
  return isContentDocInScope(grants, actor.uid, content) ? { ok: true } : { ok: false, reason: "scope_denied" };
}
