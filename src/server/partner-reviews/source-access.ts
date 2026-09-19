import { requireAnalyticsExploreAccess } from "@/server/analytics/analytics-gate";
import { analyticsChannelSourceRecordsCollection, analyticsContentSourceRecordsCollection } from "@/server/analytics/firestore";
import { analyticsChannelSourceRecordDocSchema, analyticsContentSourceRecordDocSchema } from "@/server/analytics/types";
import { isAssignmentDocInScope, requireAssignmentsFeatureAccess } from "@/server/assignments/assignments-gate";
import { assignmentsCollection } from "@/server/assignments/firestore";
import { assignmentDocSchema } from "@/server/assignments/types";
import { getActorScopeGrants, hasGlobalScope, isSelfInScope } from "@/server/authz/scope";
import type { ActorContext, ScopeGrant } from "@/server/authz/types";
import { isCampaignDocInScope, requireCampaignsFeatureAccess } from "@/server/campaigns/campaigns-gate";
import { getCampaignDocsByRefs } from "@/server/campaigns/firestore";
import { isContentDocInScope, requireContentFeatureAccess } from "@/server/content/content-gate";
import { getContentDocsByRefs } from "@/server/content/firestore";

import { collectSnapshotSourceRefs, type SnapshotSourceRefs, type SourceAccess } from "./source-context-redaction";
import type { EvidenceSnapshot } from "./types";

// Step 13A.1: resolves WHICH of a snapshot's source records the acting user
// may access, so the actor-facing DTO can be redacted accordingly (see
// source-context-redaction.ts). This is the ONE I/O piece of that boundary.
//
// It applies the EXISTING accepted decisions, never a new rule, never rank/
// minimumRole/wildcard:
//   Campaign    the actor holds the campaigns feature AND the Campaign passes
//               the accepted Campaign Record Scope (isCampaignDocInScope -
//               the very function requireCampaignInScope delegates to).
//   Assignment  the assignments feature AND the accepted Assignment Record
//               Scope (isAssignmentDocInScope / requireAssignmentInScope).
//   Content     the content feature AND the accepted Content Record Scope
//               (isContentDocInScope / requireContentInScope).
//   Analytics   the actor passes the Analytics explorer's own gate
//               (requireAnalyticsExploreAccess: analytics feature + the
//               "explore" action) AND the record falls inside the scope the
//               explorer applies to source records (see
//               isAnalyticsSourceRecordInActorScope below - the in-memory
//               twin of planAnalyticsSourceRecordListQuery).
//
// Cost: the actor's scope grants are read ONCE and every decision is then
// evaluated in memory; the source docs are read with bounded, chunked
// `in` queries (a snapshot holds at most 200 in-period Assignments and 400
// Analytics records) - never one read per item. A GLOBAL actor needs no
// document reads at all. A ref whose document cannot be loaded (missing,
// unparseable) is NOT accessible for a non-global actor (fail closed).

// Firestore's `in` operator caps at 30 values per query.
const IN_QUERY_CHUNK = 30;

type ScopeFields = { uid: string; ownerUid: string | null; regionIds: string[]; teamIds: string[] };

// The Analytics explorer scopes source records by the denormalized
// ownerUid/regionIds/teamIds projection ONLY (GLOBAL, SELF, REGION, TEAM -
// no EXPLICIT_RECORD / CAMPAIGN / PARTNER branch: see
// planAnalyticsSourceRecordListQuery). Same decision, evaluated in memory,
// including the planner's own 30-distinct-value cap per dimension.
const EXPLORER_MAX_SCOPE_VALUES = 30;

export function isAnalyticsSourceRecordInActorScope(grants: ScopeGrant[], actorUid: string, record: { ownerUid: string | null; regionIds: string[]; teamIds: string[] }): boolean {
  if (hasGlobalScope(grants)) return true;
  if (isSelfInScope(grants, actorUid, record.ownerUid ?? undefined)) return true;
  const regions = [...new Set(grants.filter((g): g is Extract<ScopeGrant, { type: "REGION" }> => g.type === "REGION").map((g) => g.region))].slice(0, EXPLORER_MAX_SCOPE_VALUES);
  const teams = [...new Set(grants.filter((g): g is Extract<ScopeGrant, { type: "TEAM" }> => g.type === "TEAM").map((g) => g.teamId))].slice(0, EXPLORER_MAX_SCOPE_VALUES);
  return record.regionIds.some((region) => regions.includes(region)) || record.teamIds.some((teamId) => teams.includes(teamId));
}

export type SourceAccessInputs = {
  actorUid: string;
  grants: ScopeGrant[];
  features: { campaigns: boolean; assignments: boolean; content: boolean; analyticsExplore: boolean };
  refs: SnapshotSourceRefs;
  campaignDocs: ReadonlyMap<string, ScopeFields>;
  assignmentDocs: ReadonlyMap<string, ScopeFields>;
  contentDocs: ReadonlyMap<string, ScopeFields>;
  analyticsDocs: ReadonlyMap<string, Pick<ScopeFields, "ownerUid" | "regionIds" | "teamIds">>;
};

// PURE: the access decision itself, given already-loaded docs + grants.
export function evaluateSourceAccess(inputs: SourceAccessInputs): SourceAccess {
  const { actorUid, grants, features, refs } = inputs;
  const global = hasGlobalScope(grants);

  const pick = <D>(enabled: boolean, wanted: string[], docs: ReadonlyMap<string, D>, inScope: (doc: D) => boolean): Set<string> => {
    const allowed = new Set<string>();
    if (!enabled) return allowed;
    for (const ref of wanted) {
      if (global) {
        allowed.add(ref);
        continue;
      }
      const doc = docs.get(ref);
      if (doc && inScope(doc)) allowed.add(ref);
    }
    return allowed;
  };

  return {
    campaigns: pick(features.campaigns, refs.campaigns, inputs.campaignDocs, (doc) => isCampaignDocInScope(grants, actorUid, doc)),
    assignments: pick(features.assignments, refs.assignments, inputs.assignmentDocs, (doc) => isAssignmentDocInScope(grants, actorUid, doc)),
    contents: pick(features.content, refs.contents, inputs.contentDocs, (doc) => isContentDocInScope(grants, actorUid, doc)),
    analyticsRecords: pick(features.analyticsExplore, refs.analyticsRecords, inputs.analyticsDocs, (doc) => isAnalyticsSourceRecordInActorScope(grants, actorUid, doc)),
  };
}

function chunked(values: string[]): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < values.length; i += IN_QUERY_CHUNK) chunks.push(values.slice(i, i + IN_QUERY_CHUNK));
  return chunks;
}

async function loadAssignmentScopeDocs(refs: string[]): Promise<Map<string, ScopeFields>> {
  const result = new Map<string, ScopeFields>();
  const snapshots = await Promise.all(chunked(refs).map((chunk) => assignmentsCollection().where("assignmentRef", "in", chunk).get()));
  for (const snapshot of snapshots) {
    for (const doc of snapshot.docs) {
      const parsed = assignmentDocSchema.safeParse(doc.data());
      if (parsed.success) result.set(parsed.data.assignmentRef, parsed.data);
    }
  }
  return result;
}

// A snapshot's Analytics refs are content source records and (Step 13A.1
// revised) the channel snapshot records a followerGrowth target read. Both
// kinds carry the SAME scope projection and are scoped by the explorer with
// the SAME plan, so one decision function covers both. Content records are
// loaded first; only the refs NOT found there are looked up in the channel
// collection (a snapshot without a followerGrowth target costs nothing extra).
async function loadAnalyticsScopeDocs(refs: string[]): Promise<Map<string, Pick<ScopeFields, "ownerUid" | "regionIds" | "teamIds">>> {
  const result = new Map<string, Pick<ScopeFields, "ownerUid" | "regionIds" | "teamIds">>();
  const contentSnapshots = await Promise.all(chunked(refs).map((chunk) => analyticsContentSourceRecordsCollection().where("sourceRef", "in", chunk).get()));
  for (const snapshot of contentSnapshots) {
    for (const doc of snapshot.docs) {
      const parsed = analyticsContentSourceRecordDocSchema.safeParse(doc.data());
      if (parsed.success) result.set(parsed.data.sourceRef, parsed.data);
    }
  }

  const remaining = refs.filter((ref) => !result.has(ref));
  if (remaining.length === 0) return result;
  const channelSnapshots = await Promise.all(chunked(remaining).map((chunk) => analyticsChannelSourceRecordsCollection().where("sourceRef", "in", chunk).get()));
  for (const snapshot of channelSnapshots) {
    for (const doc of snapshot.docs) {
      const parsed = analyticsChannelSourceRecordDocSchema.safeParse(doc.data());
      if (parsed.success) result.set(parsed.data.sourceRef, parsed.data);
    }
  }
  return result;
}

const EMPTY: ReadonlyMap<string, never> = new Map<string, never>();

export async function resolveActorSourceAccess(actor: ActorContext, snapshot: EvidenceSnapshot): Promise<SourceAccess> {
  const refs = collectSnapshotSourceRefs(snapshot);

  const [campaignGate, assignmentGate, contentGate, analyticsGate, grants] = await Promise.all([
    requireCampaignsFeatureAccess(actor),
    requireAssignmentsFeatureAccess(actor),
    requireContentFeatureAccess(actor),
    requireAnalyticsExploreAccess(actor),
    getActorScopeGrants(actor),
  ]);
  const features = { campaigns: campaignGate.ok, assignments: assignmentGate.ok, content: contentGate.ok, analyticsExplore: analyticsGate.ok };

  // A GLOBAL actor is in scope for every record: no document reads needed.
  const needDocs = !hasGlobalScope(grants);
  const [campaignDocs, assignmentDocs, contentDocs, analyticsDocs] = await Promise.all([
    needDocs && features.campaigns ? getCampaignDocsByRefs(refs.campaigns) : EMPTY,
    needDocs && features.assignments ? loadAssignmentScopeDocs(refs.assignments) : EMPTY,
    needDocs && features.content ? getContentDocsByRefs(refs.contents) : EMPTY,
    needDocs && features.analyticsExplore ? loadAnalyticsScopeDocs(refs.analyticsRecords) : EMPTY,
  ]);

  return evaluateSourceAccess({ actorUid: actor.uid, grants, features, refs, campaignDocs, assignmentDocs, contentDocs, analyticsDocs });
}
