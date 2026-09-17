import type { ActionId } from "@/server/authz/actions";
import { canAccessFeature, canPerformAction } from "@/server/authz/capabilities";
import { canAccessSensitive } from "@/server/authz/sensitive";
import { getActorScopeGrants, hasGlobalScope, isPartnerInScope, isRegionInScope, isSelfInScope, isTeamInScope, isExplicitRecordInScope } from "@/server/authz/scope";
import type { ActorContext } from "@/server/authz/types";
import type { PartnersDenialReason } from "./types";

export type PartnersAccessResult = { ok: true } | { ok: false; reason: PartnersDenialReason };

// Same shape as Discovery's requireDiscoveryAccess: Feature + Action
// access gates whether the actor may use Partners at all. Partners is a
// record-scoped domain, not a system-wide one - there is deliberately NO
// unconditional GLOBAL scope requirement here; per-record scope
// (requirePartnerInScope) and, for restricted identity, Sensitive
// Access, are checked separately by each service against the specific
// record/operation involved.
export async function requirePartnersAccess(actor: ActorContext | null, action: ActionId): Promise<PartnersAccessResult> {
  if (!actor) return { ok: false, reason: "not_authenticated" };

  const hasFeature = await canAccessFeature(actor, "partners");
  if (!hasFeature) return { ok: false, reason: "feature_denied" };

  const hasAction = await canPerformAction(actor, "partners", action);
  if (!hasAction) return { ok: false, reason: "action_denied" };

  return { ok: true };
}

// Feature-only gate for read operations (list/get/duplicate-check) - "can
// this actor see Partners data at all", independent of any specific
// mutation action. Every read is still scope-filtered/scope-checked
// separately (see requirePartnerInScope and firestore.ts's
// listPartnerDocs).
export async function requirePartnersFeatureAccess(actor: ActorContext | null): Promise<PartnersAccessResult> {
  if (!actor) return { ok: false, reason: "not_authenticated" };
  const hasFeature = await canAccessFeature(actor, "partners");
  return hasFeature ? { ok: true } : { ok: false, reason: "feature_denied" };
}

// Record Scope, applied to one already-loaded Partner. Built entirely out
// of the existing Step 4C primitives (isResourceInScope) - the Partner's
// own ownerUid/regionIds/teamIds double as its scope dimensions, and both
// a PARTNER-type grant (partnerId == this Partner's own uid) and an
// EXPLICIT_RECORD grant (resourceType "partner" + this Partner's own uid)
// are honored, giving Administration two equivalent ways to grant access
// to one specific Partner.
export async function requirePartnerInScope(
  actor: ActorContext,
  partner: { uid: string; ownerUid: string | null; regionIds: string[]; teamIds: string[] },
): Promise<PartnersAccessResult> {
  const grants = await getActorScopeGrants(actor);

  const inScope =
    hasGlobalScope(grants) ||
    isSelfInScope(grants, actor.uid, partner.ownerUid ?? undefined) ||
    partner.regionIds.some((region) => isRegionInScope(grants, region)) ||
    partner.teamIds.some((teamId) => isTeamInScope(grants, teamId)) ||
    isPartnerInScope(grants, partner.uid) ||
    isExplicitRecordInScope(grants, "partner", partner.uid);

  return inScope ? { ok: true } : { ok: false, reason: "scope_denied" };
}

// Sensitive Access gate for the restricted financial identity package -
// distinct from the manage_partner_restricted_identity action: a role can
// be granted the action (allowed to operate the restricted-identity
// workflow) without being granted the "payment_details" sensitive
// category (allowed to see the actual restricted values), mirroring
// Discovery's discovery_kyc / Finance's finance_amounts pattern. Reuses
// the existing "payment_details" category rather than inventing a new
// one - its catalog description ("Bank/payout account details on file")
// already matches this exactly.
export async function requirePartnerRestrictedIdentitySensitiveAccess(actor: ActorContext): Promise<PartnersAccessResult> {
  const allowed = await canAccessSensitive(actor, "payment_details");
  return allowed ? { ok: true } : { ok: false, reason: "sensitive_denied" };
}
