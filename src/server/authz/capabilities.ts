import type { ActionId } from "./actions";
import { FEATURES, type FeatureId } from "./features";
import { getAccessGrantDoc, getUserAccessOverrideDoc } from "./firestore";
import type { AccessGrantDoc, ActorContext, UserAccessOverrideDoc } from "./types";

// Step 5B.1: the canonical precedence, used everywhere access is decided
// - User → Base Role → Role Baseline → User-Specific Override → (Scope →
// Sensitive Access → Lifecycle, handled elsewhere). An explicit user
// override (true/false) always wins over the role baseline for that
// exact feature/action; a missing override key means "inherit the role
// baseline" - it is never treated as an implicit deny or allow of its
// own. These are pure functions over already-fetched documents
// specifically so the Effective Access Review (effective-access-
// service.ts) can call the SAME precedence without a second Firestore
// round-trip per feature/action and without reimplementing the logic -
// there is exactly one interpretation of "what does this resolve to" in
// this codebase.
export function resolveFeatureAccess(grant: AccessGrantDoc | null, override: UserAccessOverrideDoc | null, feature: FeatureId): boolean {
  const explicit = override?.features[feature]?.view;
  if (explicit !== undefined) return explicit;
  return grantAllowsFeature(grant, feature);
}

export function resolveActionAccess(grant: AccessGrantDoc | null, override: UserAccessOverrideDoc | null, feature: FeatureId, action: ActionId): boolean {
  const explicit = override?.features[feature]?.actions[action];
  if (explicit !== undefined) return explicit;
  return grantAllowsAction(grant, feature, action);
}

// Feature Access: can this actor even enter/see this feature at all.
export async function canAccessFeature(actor: ActorContext, feature: FeatureId): Promise<boolean> {
  const [grant, override] = await Promise.all([getAccessGrantDoc(actor.role), getUserAccessOverrideDoc(actor.uid)]);
  return resolveFeatureAccess(grant, override, feature);
}

// Action Permission: can this actor perform a specific action within a
// feature.
export async function canPerformAction(actor: ActorContext, feature: FeatureId, action: ActionId): Promise<boolean> {
  const [grant, override] = await Promise.all([getAccessGrantDoc(actor.role), getUserAccessOverrideDoc(actor.uid)]);
  return resolveActionAccess(grant, override, feature, action);
}

// Fetches the actor's grant + override documents once and returns every
// feature they can view. Used to build the safe client DTO (nav
// filtering) - avoids re-fetching the same two documents once per
// feature.
export async function getAllowedFeatures(actor: ActorContext): Promise<FeatureId[]> {
  const [grant, override] = await Promise.all([getAccessGrantDoc(actor.role), getUserAccessOverrideDoc(actor.uid)]);
  return FEATURES.filter((feature) => resolveFeatureAccess(grant, override, feature));
}

function grantAllowsFeature(grant: AccessGrantDoc | null, feature: FeatureId): boolean {
  if (!grant) return false;
  const featureGrant = grant.features[feature];
  if (!featureGrant) return false;
  return featureGrant.view === true;
}

function grantAllowsAction(grant: AccessGrantDoc | null, feature: FeatureId, action: ActionId): boolean {
  if (!grant) return false;
  const featureGrant = grant.features[feature];
  if (!featureGrant) return false;
  return featureGrant.actions[action] === true;
}
