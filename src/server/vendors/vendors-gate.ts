import type { ActionId } from "@/server/authz/actions";
import { canAccessFeature, canPerformAction } from "@/server/authz/capabilities";
import { canAccessSensitive } from "@/server/authz/sensitive";
import { getActorScopeGrants, hasGlobalScope, isExplicitRecordInScope, isRegionInScope, isSelfInScope, isTeamInScope } from "@/server/authz/scope";
import type { ActorContext, ScopeGrant } from "@/server/authz/types";
import type { VendorsDenialReason } from "./types";

export type VendorsAccessResult = { ok: true } | { ok: false; reason: VendorsDenialReason };

// Same shape as Partners' requirePartnersAccess: Feature + Action access
// gates whether the actor may use Vendors at all. Vendors is a record-
// scoped domain, not a system-wide one - no unconditional GLOBAL scope
// requirement here; per-record scope (requireVendorInScope) and, for
// restricted identity, Sensitive Access, are checked separately by each
// service against the specific record/operation involved.
export async function requireVendorsAccess(actor: ActorContext | null, action: ActionId): Promise<VendorsAccessResult> {
  if (!actor) return { ok: false, reason: "not_authenticated" };

  const hasFeature = await canAccessFeature(actor, "vendors");
  if (!hasFeature) return { ok: false, reason: "feature_denied" };

  const hasAction = await canPerformAction(actor, "vendors", action);
  if (!hasAction) return { ok: false, reason: "action_denied" };

  return { ok: true };
}

// Feature-only gate for read operations (list/get/duplicate-check) - "can
// this actor see Vendors data at all", independent of any specific
// mutation action.
export async function requireVendorsFeatureAccess(actor: ActorContext | null): Promise<VendorsAccessResult> {
  if (!actor) return { ok: false, reason: "not_authenticated" };
  const hasFeature = await canAccessFeature(actor, "vendors");
  return hasFeature ? { ok: true } : { ok: false, reason: "feature_denied" };
}

// Record Scope, applied to one already-loaded Vendor. Deliberately built
// WITHOUT any "is one of this Vendor's linked Partners in my scope"
// check - Step 8A section 7's critical rule: a visible Partner
// relationship must never become a scope-escalation bridge into a
// Vendor's unrelated portfolio. Only genuine Vendor-side scope (GLOBAL,
// SELF via ownerUid, REGION/TEAM via the Vendor's own dimensions, or an
// EXPLICIT_RECORD grant naming this Vendor specifically) grants access
// here.
// Pure, in-memory form of the Vendor Record Scope decision - the ONE place the
// rule lives. requireVendorInScope delegates to it; bulk/in-memory callers that
// already hold the actor's grants (e.g. Finance Agreements' per-head live scope
// re-verification) call it directly. Same refactor pattern as
// isPartnerDocInScope. Behavior-identical to the previous inline rule.
export function isVendorDocInScope(grants: ScopeGrant[], actorUid: string, vendor: { uid: string; ownerUid: string | null; regionIds: string[]; teamIds: string[] }): boolean {
  return (
    hasGlobalScope(grants) ||
    isSelfInScope(grants, actorUid, vendor.ownerUid ?? undefined) ||
    vendor.regionIds.some((region) => isRegionInScope(grants, region)) ||
    vendor.teamIds.some((teamId) => isTeamInScope(grants, teamId)) ||
    isExplicitRecordInScope(grants, "vendor", vendor.uid)
  );
}

export async function requireVendorInScope(
  actor: ActorContext,
  vendor: { uid: string; ownerUid: string | null; regionIds: string[]; teamIds: string[] },
): Promise<VendorsAccessResult> {
  const grants = await getActorScopeGrants(actor);
  return isVendorDocInScope(grants, actor.uid, vendor) ? { ok: true } : { ok: false, reason: "scope_denied" };
}

// Sensitive Access gate for the restricted financial identity package -
// distinct from the manage_vendor_restricted_identity action: a role can
// be granted the action (allowed to operate the restricted-identity
// workflow) without being granted the "vendor_payment_details" sensitive
// category (allowed to see the actual restricted values). Deliberately
// its own category, never Partners' "payment_details" - see
// sensitive-categories.ts's own comment.
export async function requireVendorRestrictedIdentitySensitiveAccess(actor: ActorContext): Promise<VendorsAccessResult> {
  const allowed = await canAccessSensitive(actor, "vendor_payment_details");
  return allowed ? { ok: true } : { ok: false, reason: "sensitive_denied" };
}
