import { getActorScopeGrants as loadActorScopeGrants } from "./firestore";
import type { ActorContext, ScopeGrant } from "./types";

// Record Scope: the canonical, multi-dimensional model. An actor can hold
// any number of grants simultaneously (SELF, GLOBAL, REGION, TEAM,
// PARTNER, CAMPAIGN, EXPLICIT_RECORD, ANALYTICS_DATASET,
// ANALYTICS_ACCOUNT); a resource is in scope if ANY grant matches ANY
// dimension the resource actually has. GLOBAL is never inferred from a
// role or from the absence of other grants - it only exists when an
// explicit GLOBAL grant document is present (see seed-access-data.ts and
// its tests for "GLOBAL absent => no implicit global access").
export async function getActorScopeGrants(actor: ActorContext): Promise<ScopeGrant[]> {
  return loadActorScopeGrants(actor.uid);
}

// A resource being checked against an actor's scope. Every field is
// optional because not every resource has every dimension (a Campaign
// record has no analyticsDatasetId, for instance); a caller only fills in
// the dimensions that apply to what it's checking. Step 4C intentionally
// does not wire this to any real business record yet - callers use
// representative descriptors until a later module needs it for real.
export type ResourceDescriptor = {
  ownerUid?: string;
  region?: string;
  teamId?: string;
  partnerId?: string;
  campaignId?: string;
  resourceType?: string;
  resourceId?: string;
  datasetId?: string;
  accountId?: string;
};

export function hasGlobalScope(grants: ScopeGrant[]): boolean {
  return grants.some((grant) => grant.type === "GLOBAL");
}

export function isSelfInScope(grants: ScopeGrant[], actorUid: string, resourceOwnerUid: string | undefined): boolean {
  if (!resourceOwnerUid) return false;
  if (resourceOwnerUid !== actorUid) return false;
  return grants.some((grant) => grant.type === "SELF");
}

export function isRegionInScope(grants: ScopeGrant[], region: string | undefined): boolean {
  if (!region) return false;
  return grants.some((grant) => grant.type === "REGION" && grant.region === region);
}

export function isTeamInScope(grants: ScopeGrant[], teamId: string | undefined): boolean {
  if (!teamId) return false;
  return grants.some((grant) => grant.type === "TEAM" && grant.teamId === teamId);
}

export function isPartnerInScope(grants: ScopeGrant[], partnerId: string | undefined): boolean {
  if (!partnerId) return false;
  return grants.some((grant) => grant.type === "PARTNER" && grant.partnerId === partnerId);
}

export function isCampaignInScope(grants: ScopeGrant[], campaignId: string | undefined): boolean {
  if (!campaignId) return false;
  return grants.some((grant) => grant.type === "CAMPAIGN" && grant.campaignId === campaignId);
}

export function isExplicitRecordInScope(grants: ScopeGrant[], resourceType: string | undefined, resourceId: string | undefined): boolean {
  if (!resourceType || !resourceId) return false;
  return grants.some((grant) => grant.type === "EXPLICIT_RECORD" && grant.resourceType === resourceType && grant.resourceId === resourceId);
}

export function isAnalyticsDatasetInScope(grants: ScopeGrant[], datasetId: string | undefined): boolean {
  if (!datasetId) return false;
  return grants.some((grant) => grant.type === "ANALYTICS_DATASET" && grant.datasetId === datasetId);
}

export function isAnalyticsAccountInScope(grants: ScopeGrant[], accountId: string | undefined): boolean {
  if (!accountId) return false;
  return grants.some((grant) => grant.type === "ANALYTICS_ACCOUNT" && grant.accountId === accountId);
}

// Composite convenience: true if any dimension the resource actually
// carries matches any of the actor's grants (GLOBAL always short-
// circuits first, since it's meant to). Built entirely out of the
// primitives above - real business modules can call this directly, or
// call the individual primitives when they only care about one dimension.
export function isResourceInScope(grants: ScopeGrant[], actorUid: string, resource: ResourceDescriptor): boolean {
  if (hasGlobalScope(grants)) return true;
  if (isSelfInScope(grants, actorUid, resource.ownerUid)) return true;
  if (isRegionInScope(grants, resource.region)) return true;
  if (isTeamInScope(grants, resource.teamId)) return true;
  if (isPartnerInScope(grants, resource.partnerId)) return true;
  if (isCampaignInScope(grants, resource.campaignId)) return true;
  if (isExplicitRecordInScope(grants, resource.resourceType, resource.resourceId)) return true;
  if (isAnalyticsDatasetInScope(grants, resource.datasetId)) return true;
  if (isAnalyticsAccountInScope(grants, resource.accountId)) return true;
  return false;
}
