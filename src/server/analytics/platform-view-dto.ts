// Step 12D: the actor-safe DTO shape of a platform Analytics view, plus the
// PURE builders that turn already-selected, already-scoped source records and
// already-loaded label documents into it. No I/O here (platform-view-
// service.ts loads the docs); no authorization DECISION is taken from any
// projection - the only decision made here is the Campaign label's Record
// Scope check, evaluated in memory from the actor's own grants against the
// LIVE Campaign document (never against the analytics record's projection).
//
// Actor-safety: the DTO carries display labels, numbers and dates ONLY - no
// raw uid, no opaque *Ref, no Firestore path. A label that cannot be
// resolved (or that the actor may not see) is `null`; the UI renders a
// neutral placeholder. Rows are addressed by their position in the response,
// never by an internal id.
import { sourceLabel } from "@/features/analytics/explorer-helpers";
import type { ScopeGrant } from "@/server/authz/types";
import { isCampaignDocInScope } from "@/server/campaigns/campaigns-gate";

import type { AnalyticsLabelMaps } from "./label-resolution";
import { partnerAnalyticsPath } from "./partner-view-links";
import { parsePlatformViewId, type PartnerAccountSnapshotSelection, type PlatformKpis, type PlatformSourceQuality, type PlatformTrend, type PlatformViewId } from "./platform-view-metrics";
import type { AnalyticsContentSourceRecordDoc, AnalyticsMatchState } from "./types";

export type PlatformContentRowDto = {
  // The record's REAL posted date-time when the source supplied one.
  publishedAt: string | null;
  reportingPeriod: { start: string; end: string } | null;
  partnerLabel: string | null;
  // Step 12E: an opaque same-origin link to the Partner Analytics drill-down
  // (/analytics/partner/<ref>?platform=<this page's platform>) - set ONLY when
  // the actor may open that page (partners feature + live Partner Record
  // Scope), else `null` and the label renders as plain text.
  partnerAnalyticsHref: string | null;
  accountLabel: string | null;
  // Only ever set when the actor holds the campaigns feature AND the
  // Campaign passes the accepted Campaign Record Scope.
  campaignLabel: string | null;
  matchState: AnalyticsMatchState;
  // Source-reported values; `null` = not reported (rendered "Unavailable"), never 0.
  views: number | null;
  engagement: number | null;
  likes: number | null;
  comments: number | null;
  // Same "{file} · sheet {sheet} · row {n}" provenance wording as the Data Explorer.
  source: string;
};

export type PlatformAccountRowDto = {
  partnerLabel: string | null;
  // Same contract as PlatformContentRowDto.partnerAnalyticsHref.
  partnerAnalyticsHref: string | null;
  accountLabel: string | null;
  accountHandle: string | null;
  // ONE account's latest verified snapshot value - a point in time, never a
  // sum and never growth. `null` = not source-reported.
  profileFollowers: number | null;
  reportingPeriod: { start: string; end: string } | null;
  // When the snapshot's owning record was written (import time) - freshness.
  snapshotAt: string;
  snapshotCount: number;
  source: string;
};

export type PlatformAnalyticsViewDto = {
  platform: PlatformViewId;
  coverage: { contentTruncated: boolean; channelTruncated: boolean };
  kpis: PlatformKpis;
  trend: PlatformTrend;
  publishedContent: { rows: PlatformContentRowDto[]; total: number };
  partnerAccounts: { rows: PlatformAccountRowDto[]; totalAccounts: number };
  sourceQuality: PlatformSourceQuality;
};

// ---- Label inputs (already loaded, already feature-gated by the caller) --------

type CampaignScopeFields = { uid: string; name: string; ownerUid: string | null; regionIds: string[]; teamIds: string[] };
type PartnerAccountLabelFields = { displayName: string | null; handle: string | null; platformAccountId: string | null };

export type PlatformViewLabelInputs = {
  actorUid: string;
  grants: ScopeGrant[];
  // Empty when the actor lacks the corresponding feature - a label is then
  // simply unresolved (null), never fetched.
  partners: ReadonlyMap<string, { displayName: string }>;
  partnerAccounts: ReadonlyMap<string, PartnerAccountLabelFields>;
  campaigns: ReadonlyMap<string, CampaignScopeFields>;
  batchFilenames: ReadonlyMap<string, string>;
  // Step 12E: the Partners (of those loaded above) the actor may OPEN in
  // Partner Analytics - partners feature + the accepted Partner Record Scope,
  // decided in memory by the caller with the grants read ONCE. Absent/empty =
  // no row gets a link.
  openablePartnerRefs?: ReadonlySet<string>;
};

// The Partner Analytics link for a row, or `null` (plain text) unless the
// Partner is in the actor's openable set. Carries the row's platform so the
// destination opens with that platform preselected.
export function partnerAnalyticsHrefFor(partnerRef: string | null, platform: string, inputs: Pick<PlatformViewLabelInputs, "openablePartnerRefs">): string | null {
  if (!partnerRef || !inputs.openablePartnerRefs?.has(partnerRef)) return null;
  return partnerAnalyticsPath(partnerRef, parsePlatformViewId(platform));
}

// Same label precedence the Data Explorer uses for a Partner Account.
export function partnerAccountLabelOf(account: PartnerAccountLabelFields): string {
  return account.displayName ?? account.handle ?? account.platformAccountId ?? "Unnamed account";
}

function batchLabelMaps(inputs: PlatformViewLabelInputs): AnalyticsLabelMaps {
  return { content: {}, campaigns: {}, partners: {}, partnerAccounts: {}, batches: Object.fromEntries(inputs.batchFilenames) };
}

// Campaign context is shown ONLY when the actor may access that Campaign:
// the campaigns feature (caller passes an empty map otherwise) AND the
// accepted Campaign Record Scope, evaluated in memory with the grants the
// caller read ONCE. An unresolvable Campaign is never shown.
export function authorizedCampaignLabel(campaignRef: string | null, inputs: PlatformViewLabelInputs): string | null {
  if (!campaignRef) return null;
  const campaign = inputs.campaigns.get(campaignRef);
  if (!campaign) return null;
  return isCampaignDocInScope(inputs.grants, inputs.actorUid, campaign) ? campaign.name : null;
}

export function buildPublishedContentRowDtos(records: AnalyticsContentSourceRecordDoc[], inputs: PlatformViewLabelInputs): PlatformContentRowDto[] {
  const batchLabels = batchLabelMaps(inputs);
  return records.map((record) => {
    const account = record.matchedPartnerAccountRef ? inputs.partnerAccounts.get(record.matchedPartnerAccountRef) : undefined;
    return {
      publishedAt: record.postDateTimeIso,
      reportingPeriod: record.reportingPeriod,
      partnerLabel: record.matchedPartnerRef ? (inputs.partners.get(record.matchedPartnerRef)?.displayName ?? null) : null,
      partnerAnalyticsHref: partnerAnalyticsHrefFor(record.matchedPartnerRef, record.platform, inputs),
      accountLabel: account ? partnerAccountLabelOf(account) : null,
      campaignLabel: authorizedCampaignLabel(record.matchedCampaignRef, inputs),
      matchState: record.matchState,
      views: record.views,
      engagement: record.engagement,
      likes: record.likes,
      comments: record.comments,
      source: sourceLabel(record, batchLabels),
    };
  });
}

export function buildPartnerAccountRowDtos(selections: PartnerAccountSnapshotSelection[], inputs: PlatformViewLabelInputs): PlatformAccountRowDto[] {
  const batchLabels = batchLabelMaps(inputs);
  return selections.map(({ partnerAccountRef, snapshot, snapshotCount }) => {
    const account = inputs.partnerAccounts.get(partnerAccountRef);
    const label = account ? partnerAccountLabelOf(account) : null;
    return {
      partnerLabel: snapshot.matchedPartnerRef ? (inputs.partners.get(snapshot.matchedPartnerRef)?.displayName ?? null) : null,
      partnerAnalyticsHref: partnerAnalyticsHrefFor(snapshot.matchedPartnerRef, snapshot.platform, inputs),
      accountLabel: label,
      // "@username" only when it adds information beyond the label itself.
      accountHandle: account?.handle && account.handle !== label ? account.handle : null,
      profileFollowers: snapshot.profileFollowers,
      reportingPeriod: snapshot.reportingPeriod,
      snapshotAt: snapshot.createdAt,
      snapshotCount,
      source: sourceLabel(snapshot, batchLabels),
    };
  });
}
