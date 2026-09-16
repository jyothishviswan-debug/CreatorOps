import type { ActionId } from "./actions";
import { canAccessFeature, canPerformAction } from "./capabilities";
import { getActorScopeGrants, hasGlobalScope } from "./scope";
import type { ActorContext } from "./types";

export type AdministrationDenialReason = "not_authenticated" | "not_active" | "feature_denied" | "action_denied" | "scope_denied";

export type AdministrationAccessResult = { ok: true } | { ok: false; reason: AdministrationDenialReason };

// The single gate every Administration route/service must call before
// doing anything else - there is exactly one place in the codebase that
// decides "is this actor allowed to use the Administration API", and it
// is built entirely out of the same shared primitives every other
// protected route already uses (capabilities.ts, scope.ts). No role name
// or rank is ever checked directly.
//
// `actor` must already be the caller's own resolved, active identity
// (i.e. the output of resolveActor - null means "not authenticated/not
// admitted", handled the same way here). This function never looks at
// which target user, role, or grant a request names, so a crafted target
// reference cannot be used to bypass it - the check is always about what
// the REQUESTING actor may do, independent of the target.
//
// Every operation this module's services expose is system-wide (listing
// or mutating data across the whole emulator dataset, not "the actor's
// own" records), so an explicit GLOBAL scope grant is required
// unconditionally - never inferred from role/feature/action already
// having passed.
export async function requireAdministrationAccess(actor: ActorContext | null, action: ActionId): Promise<AdministrationAccessResult> {
  if (!actor) return { ok: false, reason: "not_authenticated" };

  const hasFeature = await canAccessFeature(actor, "administration");
  if (!hasFeature) return { ok: false, reason: "feature_denied" };

  const hasAction = await canPerformAction(actor, "administration", action);
  if (!hasAction) return { ok: false, reason: "action_denied" };

  const scopeGrants = await getActorScopeGrants(actor);
  if (!hasGlobalScope(scopeGrants)) return { ok: false, reason: "scope_denied" };

  return { ok: true };
}
