import type { ActionId } from "@/server/authz/actions";
import { canAccessFeature, canPerformAction } from "@/server/authz/capabilities";
import { canAccessSensitive } from "@/server/authz/sensitive";
import { getActorScopeGrants, isResourceInScope } from "@/server/authz/scope";
import type { ActorContext } from "@/server/authz/types";
import type { DiscoveryDenialReason } from "./types";

export type DiscoveryAccessResult = { ok: true } | { ok: false; reason: DiscoveryDenialReason };

// Step 6A's version of requireAdministrationAccess - but Discovery is a
// record-scoped domain, not a system-wide one: unlike Administration,
// there is deliberately NO unconditional GLOBAL scope requirement here.
// Feature + action access gates whether the actor may use Discovery at
// all; per-record scope (requireLeadInScope below) and, for KYC,
// Sensitive Access, are checked separately by each service against the
// specific record/operation involved.
//
// `actor` must already be the caller's own resolved, active identity
// (resolveActor's output - null means not authenticated/not admitted).
export async function requireDiscoveryAccess(actor: ActorContext | null, action: ActionId): Promise<DiscoveryAccessResult> {
  if (!actor) return { ok: false, reason: "not_authenticated" };

  const hasFeature = await canAccessFeature(actor, "discovery");
  if (!hasFeature) return { ok: false, reason: "feature_denied" };

  const hasAction = await canPerformAction(actor, "discovery", action);
  if (!hasAction) return { ok: false, reason: "action_denied" };

  return { ok: true };
}

// Feature-only gate for read operations (list/get) - "can this actor see
// Discovery data at all", independent of any specific mutation action.
// Every read is still scope-filtered/scope-checked separately (see
// requireLeadInScope and firestore.ts's listLeadDocs); this only answers
// the Feature Access question.
export async function requireDiscoveryFeatureAccess(actor: ActorContext | null): Promise<DiscoveryAccessResult> {
  if (!actor) return { ok: false, reason: "not_authenticated" };
  const hasFeature = await canAccessFeature(actor, "discovery");
  return hasFeature ? { ok: true } : { ok: false, reason: "feature_denied" };
}

// Record Scope, applied to one already-loaded Lead. Built entirely out
// of the existing Step 4C primitives (isResourceInScope) - the Lead's
// own ownerUid/region/teamId double as its scope dimensions, and
// EXPLICIT_RECORD grants match against resourceType "lead" + the Lead's
// internal uid (never exposed to the browser, but scope grants are
// managed server-side by Administration regardless).
export async function requireLeadInScope(actor: ActorContext, lead: { uid: string; ownerUid: string | null; region: string | null; teamId: string | null }): Promise<DiscoveryAccessResult> {
  const grants = await getActorScopeGrants(actor);
  const inScope = isResourceInScope(grants, actor.uid, {
    ownerUid: lead.ownerUid ?? undefined,
    region: lead.region ?? undefined,
    teamId: lead.teamId ?? undefined,
    resourceType: "lead",
    resourceId: lead.uid,
  });
  return inScope ? { ok: true } : { ok: false, reason: "scope_denied" };
}

// Sensitive Access gate for the restricted KYC package - a distinct
// check from the manage_kyc action: a role can be granted the action
// (allowed to operate the KYC workflow) without being granted the
// "discovery_kyc" sensitive category (allowed to see the actual
// restricted values), mirroring Finance's finance_amounts pattern.
export async function requireDiscoveryKycSensitiveAccess(actor: ActorContext): Promise<DiscoveryAccessResult> {
  const allowed = await canAccessSensitive(actor, "discovery_kyc");
  return allowed ? { ok: true } : { ok: false, reason: "sensitive_denied" };
}
