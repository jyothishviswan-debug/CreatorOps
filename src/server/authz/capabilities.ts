import type { ActionId } from "./actions";
import { FEATURES, type FeatureId } from "./features";
import { getAccessGrantDoc, getUserAccessOverrideLookup } from "./firestore";
import type { AccessGrantDoc, ActorContext, OverrideLookup } from "./types";

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
//
// Step 5B.1A: a THIRD override state - "invalid" (the document exists
// but fails schema validation) - always wins over everything else and
// denies outright, even when the role baseline would allow it. This is
// deliberate and different from "absent": silently treating a corrupt
// override document as "no overrides" would let role-baseline access
// through unexamined, which is not fail-closed. Only a genuinely absent
// document means "inherit the role baseline".
export function resolveFeatureAccess(grant: AccessGrantDoc | null, override: OverrideLookup, feature: FeatureId): boolean {
  if (override.status === "invalid") return false;
  const explicit = override.status === "valid" ? override.doc.features[feature]?.view : undefined;
  if (explicit !== undefined) return explicit;
  return grantAllowsFeature(grant, feature);
}

export function resolveActionAccess(grant: AccessGrantDoc | null, override: OverrideLookup, feature: FeatureId, action: ActionId): boolean {
  if (override.status === "invalid") return false;
  const explicit = override.status === "valid" ? override.doc.features[feature]?.actions[action] : undefined;
  if (explicit !== undefined) return explicit;
  return grantAllowsAction(grant, feature, action);
}

// Feature Access: can this actor even enter/see this feature at all.
export async function canAccessFeature(actor: ActorContext, feature: FeatureId): Promise<boolean> {
  const [grant, override] = await Promise.all([getAccessGrantDoc(actor.role), getUserAccessOverrideLookup(actor.uid)]);
  return resolveFeatureAccess(grant, override, feature);
}

// Action Permission: can this actor perform a specific action within a
// feature.
export async function canPerformAction(actor: ActorContext, feature: FeatureId, action: ActionId): Promise<boolean> {
  const [grant, override] = await Promise.all([getAccessGrantDoc(actor.role), getUserAccessOverrideLookup(actor.uid)]);
  return resolveActionAccess(grant, override, feature, action);
}

// Fetches the actor's grant + override documents once and returns every
// feature they can view. Used to build the safe client DTO (nav
// filtering) - avoids re-fetching the same two documents once per
// feature.
export async function getAllowedFeatures(actor: ActorContext): Promise<FeatureId[]> {
  const [grant, override] = await Promise.all([getAccessGrantDoc(actor.role), getUserAccessOverrideLookup(actor.uid)]);
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
