import { requireAdministrationAccess } from "@/server/authz/administration-gate";
import { getAllowedFeatures } from "@/server/authz/capabilities";
import { toScopeSummaryDto, type ScopeSummaryDto } from "@/server/authz/client-dto";
import type { FeatureId } from "@/server/authz/features";
import { getAccessGrantDoc, getSensitiveAccessGrantDoc, getUserDocByRef } from "@/server/authz/firestore";
import type { Role } from "@/server/authz/roles";
import { getActorScopeGrants } from "@/server/authz/scope";
import type { AccessGrantDoc, ActorContext } from "@/server/authz/types";
import { invalidInputResult, unauthorizedResult, type ServiceResult } from "./types";

export type EffectiveAccessDto = {
  userRef: string;
  role: Role;
  active: boolean;
  activeFeatures: FeatureId[];
  // The full, resolved {featureId: {view, actions}} grant for this role -
  // the exact document canAccessFeature/canPerformAction read, not a
  // re-derivation of it.
  features: AccessGrantDoc["features"];
  scope: ScopeSummaryDto;
  sensitiveCategories: string[];
};

// Effective Access Review: what does this user *actually* resolve to,
// right now, using the exact same shared primitives every protected
// route and /api/me already use (getAllowedFeatures, getActorScopeGrants,
// the accessGrants/sensitiveAccessGrants reads). Deliberately not a
// second interpretation of "what can this user do" - it's the same one,
// just run against a target user instead of the requesting actor and
// returned with more detail than the minimal client DTO needs.
export async function getEffectiveAccess(actor: ActorContext | null, userRef: unknown): Promise<ServiceResult<EffectiveAccessDto>> {
  if (!actor) return unauthorizedResult("not_authenticated");
  const gate = await requireAdministrationAccess(actor, "manage_users");
  if (!gate.ok) return unauthorizedResult(gate.reason);

  if (typeof userRef !== "string" || userRef.length === 0) return invalidInputResult("Missing userRef.");

  const targetDoc = await getUserDocByRef(userRef);
  if (!targetDoc) return { ok: false, code: "not_found", message: "User not found." };

  const targetActor: ActorContext = {
    uid: targetDoc.uid,
    email: targetDoc.email,
    role: targetDoc.role,
    displayName: targetDoc.displayName,
    userRef: targetDoc.userRef,
  };

  const [activeFeatures, scopeGrants, accessGrantDoc, sensitiveDoc] = await Promise.all([
    getAllowedFeatures(targetActor),
    getActorScopeGrants(targetActor),
    getAccessGrantDoc(targetDoc.role),
    getSensitiveAccessGrantDoc(targetDoc.role),
  ]);

  return {
    ok: true,
    data: {
      userRef: targetDoc.userRef,
      role: targetDoc.role,
      active: targetDoc.active,
      activeFeatures,
      features: accessGrantDoc?.features ?? {},
      scope: toScopeSummaryDto(scopeGrants),
      sensitiveCategories: sensitiveDoc?.categories ?? [],
    },
  };
}
