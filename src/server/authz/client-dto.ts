import { getAllowedFeatures } from "./capabilities";
import type { FeatureId } from "./features";
import { getActorScopeGrants } from "./scope";
import type { ActorContext, ScopeGrant } from "./types";

// The only authorization data ever sent to the client: a flat list of
// feature ids safe for presentation (nav filtering, "what can I even
// try"), plus a summary of scope grants safe enough to *describe* without
// being useful for anything else. This DTO is never trusted for
// enforcement - every protected route independently re-checks
// canAccessFeature/scope primitives server-side on every request (see
// proxy.ts). Losing or tampering with this response can at worst show/
// hide the wrong nav items or scope summary; it cannot grant access to
// anything.
export type ScopeSummaryDto = {
  global: boolean;
  self: boolean;
  regions: string[];
  teams: string[];
  partners: string[];
  campaigns: string[];
  analyticsDatasets: string[];
  analyticsAccounts: string[];
  // Explicit-record grants can name arbitrary resource ids from any
  // module; a count is enough for presentation without echoing them back.
  explicitRecordCount: number;
};

export type ActorClientDto = {
  authenticated: true;
  role: string;
  displayName: string;
  activeFeatures: FeatureId[];
  scope: ScopeSummaryDto;
};

export function toScopeSummaryDto(grants: ScopeGrant[]): ScopeSummaryDto {
  return {
    global: grants.some((grant) => grant.type === "GLOBAL"),
    self: grants.some((grant) => grant.type === "SELF"),
    regions: grants.filter((grant) => grant.type === "REGION").map((grant) => grant.region),
    teams: grants.filter((grant) => grant.type === "TEAM").map((grant) => grant.teamId),
    partners: grants.filter((grant) => grant.type === "PARTNER").map((grant) => grant.partnerId),
    campaigns: grants.filter((grant) => grant.type === "CAMPAIGN").map((grant) => grant.campaignId),
    analyticsDatasets: grants.filter((grant) => grant.type === "ANALYTICS_DATASET").map((grant) => grant.datasetId),
    analyticsAccounts: grants.filter((grant) => grant.type === "ANALYTICS_ACCOUNT").map((grant) => grant.accountId),
    explicitRecordCount: grants.filter((grant) => grant.type === "EXPLICIT_RECORD").length,
  };
}

export async function toClientDto(actor: ActorContext): Promise<ActorClientDto> {
  const [activeFeatures, scopeGrants] = await Promise.all([getAllowedFeatures(actor), getActorScopeGrants(actor)]);
  return {
    authenticated: true,
    role: actor.role,
    displayName: actor.displayName,
    activeFeatures,
    scope: toScopeSummaryDto(scopeGrants),
  };
}
