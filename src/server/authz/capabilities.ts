import type { ActionId } from "./actions";
import { FEATURES, type FeatureId } from "./features";
import { getAccessGrantDoc } from "./firestore";
import type { AccessGrantDoc, ActorContext } from "./types";

// Feature Access: can this actor even enter/see this feature at all.
// Explicit per-role lookup only - a missing grant document, or a feature
// entry the document doesn't mention, both mean "no", never "yes". There
// is no rank, no "higher role implies this too" - every role's document
// must say so itself, including Super Admin's (see seed-access-data.ts).
export async function canAccessFeature(actor: ActorContext, feature: FeatureId): Promise<boolean> {
  const grant = await getAccessGrantDoc(actor.role);
  return grantAllowsFeature(grant, feature);
}

// Action Permission: can this actor perform a specific action within a
// feature. Also explicit - actions absent from the feature's actions map
// are denied; they are never inferred from `view` or from any other
// action already being granted.
export async function canPerformAction(actor: ActorContext, feature: FeatureId, action: ActionId): Promise<boolean> {
  const grant = await getAccessGrantDoc(actor.role);
  return grantAllowsAction(grant, feature, action);
}

// Fetches the actor's grant document once and returns every feature they
// can view. Used to build the safe client DTO (nav filtering) - avoids
// re-fetching the same accessGrants/{role} document once per feature.
export async function getAllowedFeatures(actor: ActorContext): Promise<FeatureId[]> {
  const grant = await getAccessGrantDoc(actor.role);
  return FEATURES.filter((feature) => grantAllowsFeature(grant, feature));
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
