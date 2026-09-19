import type { ActionId } from "@/server/authz/actions";
import { canAccessFeature, canPerformAction } from "@/server/authz/capabilities";
import { getActorScopeGrants, hasGlobalScope, isExplicitRecordInScope, isRegionInScope, isSelfInScope, isTeamInScope } from "@/server/authz/scope";
import type { ActorContext, ScopeGrant } from "@/server/authz/types";
import type { AssignmentsDenialReason } from "./types";

export type AssignmentsAccessResult = { ok: true } | { ok: false; reason: AssignmentsDenialReason };

// Same shape as Campaigns' requireCampaignsAccess: Feature + Action access
// gates whether the actor may use Assignments at all. Assignments is a
// record-scoped domain, not a system-wide one - per-record scope
// (requireAssignmentInScope) is checked separately by each service against
// the specific record/operation involved.
export async function requireAssignmentsAccess(actor: ActorContext | null, action: ActionId): Promise<AssignmentsAccessResult> {
  if (!actor) return { ok: false, reason: "not_authenticated" };

  const hasFeature = await canAccessFeature(actor, "assignments");
  if (!hasFeature) return { ok: false, reason: "feature_denied" };

  const hasAction = await canPerformAction(actor, "assignments", action);
  if (!hasAction) return { ok: false, reason: "action_denied" };

  return { ok: true };
}

// Feature-only gate for read operations (list/get/history) - "can this
// actor see Assignments data at all", independent of any specific
// mutation action.
export async function requireAssignmentsFeatureAccess(actor: ActorContext | null): Promise<AssignmentsAccessResult> {
  if (!actor) return { ok: false, reason: "not_authenticated" };
  const hasFeature = await canAccessFeature(actor, "assignments");
  return hasFeature ? { ok: true } : { ok: false, reason: "feature_denied" };
}

// Record Scope, applied to one already-loaded Assignment. GLOBAL, SELF
// (via ownerUid), REGION/TEAM (via the Assignment's own dimensions - both
// snapshotted from the owning Campaign at creation, never live-looked-up
// - see types.ts), or an EXPLICIT_RECORD grant naming it. Deliberately no
// dedicated ASSIGNMENT scope-grant type (judgment call #4) and
// deliberately NO check against the linked Vendor's own scope anywhere -
// "Vendor context must never broaden Assignment access" (Step 10A section
// 6's own rule), matching Vendors'/Partners' own precedent of never
// bridging a linked record's scope into this one.
// Step 12C.2: the Partner's own Record Scope (requirePartnerInScope) is now
// REQUIRED to CREATE an Assignment for that Partner (see
// assignment-service.ts) - but it is a create-time gate only. It never
// appears here: Partner visibility still never broadens Assignment READ
// access.
// Pure, in-memory form of the Record Scope decision below - the ONE place
// the rule lives. requireAssignmentInScope delegates to it; bulk callers
// that already hold the actor's grants (Partner Reviews' source-context
// redaction) call it directly instead of re-reading the grants per record.
export function isAssignmentDocInScope(grants: ScopeGrant[], actorUid: string, assignment: { uid: string; ownerUid: string | null; regionIds: string[]; teamIds: string[] }): boolean {
  return (
    hasGlobalScope(grants) ||
    isSelfInScope(grants, actorUid, assignment.ownerUid ?? undefined) ||
    assignment.regionIds.some((region) => isRegionInScope(grants, region)) ||
    assignment.teamIds.some((teamId) => isTeamInScope(grants, teamId)) ||
    isExplicitRecordInScope(grants, "assignment", assignment.uid)
  );
}

export async function requireAssignmentInScope(
  actor: ActorContext,
  assignment: { uid: string; ownerUid: string | null; regionIds: string[]; teamIds: string[] },
): Promise<AssignmentsAccessResult> {
  const grants = await getActorScopeGrants(actor);
  return isAssignmentDocInScope(grants, actor.uid, assignment) ? { ok: true } : { ok: false, reason: "scope_denied" };
}
