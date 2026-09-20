// Step 12D: getPlatformAnalyticsView - the ONE trusted read behind the
// separate Instagram / YouTube Analytics views.
//
// Same trust chain as the accepted Overview/Explorer, nothing new:
//   1. Analytics read access = requireAnalyticsExploreAccess (analytics
//      feature + the "explore" action). No Import Center access is implied
//      or checked - these views expose no import surface at all.
//   2. The platform is validated with the shared normalizePlatformIdentifier
//      and only `instagram` / `youtube` are accepted.
//   3. Records are fetched ONLY through the accepted, already-scoped
//      listAnalyticsSourceRecords (scope enforced BEFORE retrieval by the
//      Analytics planner, platform filter pushed to the query) - never the
//      global admin read-model snapshot, never a browser fetch/filter.
//   4. A deliberately bounded, honest window (<= 10 pages x 100 records per
//      record kind, same bound as the Overview); when the real dataset is
//      larger, `coverage.*Truncated` says so.
//   5. Labels: at most ONE bulk resolution per distinct-ref family
//      (partners / partner accounts / campaigns / batches), only for the
//      handful of rows actually displayed - never one read per row. The
//      actor's scope grants are read ONCE for the in-memory Campaign scope
//      decision.
// The result is an actor-safe DTO (see platform-view-dto.ts).
import { canAccessFeature } from "@/server/authz/capabilities";
import { getActorScopeGrants } from "@/server/authz/scope";
import type { ActorContext } from "@/server/authz/types";
import { getCampaignDocsByRefs } from "@/server/campaigns/firestore";
import { getPartnerAccountDocsByRefs, getPartnerDocsByRefs } from "@/server/partners/firestore";
import { isPartnerDocInScope } from "@/server/partners/partners-gate";

import { requireAnalyticsExploreAccess } from "./analytics-gate";
import { listAnalyticsSourceRecords } from "./explorer-service";
import { analyticsImportBatchesCollection } from "./firestore";
import {
  buildPartnerAccountRowDtos,
  buildPublishedContentRowDtos,
  type PlatformAnalyticsViewDto,
  type PlatformViewLabelInputs,
} from "./platform-view-dto";
import {
  aggregatePlatformKpis,
  buildPlatformSourceQuality,
  buildPlatformTrend,
  PARTNER_ACCOUNT_ROW_LIMIT,
  parsePlatformViewId,
  PUBLISHED_CONTENT_ROW_LIMIT,
  selectLatestAccountSnapshots,
  selectPublishedContentRecords,
  type PlatformViewId,
} from "./platform-view-metrics";
import { analyticsImportBatchDocSchema, analyticsNotFoundResult, analyticsUnauthorizedResult, type AnalyticsChannelSourceRecordDoc, type AnalyticsContentSourceRecordDoc, type AnalyticsServiceResult } from "./types";

const BOUNDED_PAGE_SIZE = 100; // explorer-service.ts's own listInputSchema caps `limit` at 100 - never exceed it.
const MAX_PAGES = 10; // 1000 records max per record kind - a deliberate, honest bound, never a true fetch-all.
const IN_QUERY_CHUNK = 30; // Firestore's own `in` cap.

// A fresh, platform-filtered bounded cursor loop (this file's own - the
// accepted Overview's helpers are private to overview-service.ts and stay
// untouched). Stops at the bound and reports `truncated` only when the last
// permitted page still had a next cursor.
type BoundedRecords<T> = { records: T[]; truncated: boolean };

function fetchBoundedRecords(actor: ActorContext, recordKind: "content", platform: PlatformViewId): Promise<BoundedRecords<AnalyticsContentSourceRecordDoc>>;
function fetchBoundedRecords(actor: ActorContext, recordKind: "channel", platform: PlatformViewId): Promise<BoundedRecords<AnalyticsChannelSourceRecordDoc>>;
async function fetchBoundedRecords(actor: ActorContext, recordKind: "content" | "channel", platform: PlatformViewId): Promise<BoundedRecords<AnalyticsContentSourceRecordDoc | AnalyticsChannelSourceRecordDoc>> {
  const records: (AnalyticsContentSourceRecordDoc | AnalyticsChannelSourceRecordDoc)[] = [];
  let cursor: Record<string, unknown> | undefined;
  let truncated = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await listAnalyticsSourceRecords(actor, { recordKind, platform, limit: BOUNDED_PAGE_SIZE, cursor });
    if (!result.ok || result.data.recordKind !== recordKind) break;
    records.push(...result.data.records);
    if (!result.data.nextCursor) break;
    cursor = result.data.nextCursor as Record<string, unknown>;
    if (page === MAX_PAGES - 1) truncated = true;
  }
  return { records, truncated };
}

// ONE bulk, chunked `in` read of the import batches' filenames for the
// displayed rows (a handful of distinct batches) - Analytics import batches
// are not record-scoped; they are readable with the same explore access.
async function getBatchFilenamesByRefs(batchRefs: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(batchRefs)];
  const result = new Map<string, string>();
  for (let i = 0; i < unique.length; i += IN_QUERY_CHUNK) {
    const snapshot = await analyticsImportBatchesCollection().where("batchRef", "in", unique.slice(i, i + IN_QUERY_CHUNK)).get();
    for (const doc of snapshot.docs) {
      const parsed = analyticsImportBatchDocSchema.safeParse(doc.data());
      if (parsed.success) result.set(parsed.data.batchRef, parsed.data.sourceFilename);
    }
  }
  return result;
}

function distinct(values: (string | null)[]): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

export async function getPlatformAnalyticsView(actor: ActorContext | null, platformInput: unknown): Promise<AnalyticsServiceResult<PlatformAnalyticsViewDto>> {
  const gate = await requireAnalyticsExploreAccess(actor);
  if (!gate.ok) return analyticsUnauthorizedResult(gate.reason);

  const platform = parsePlatformViewId(platformInput);
  if (!platform) return analyticsNotFoundResult("Analytics platform view not found.");

  const [content, channel] = await Promise.all([fetchBoundedRecords(actor!, "content", platform), fetchBoundedRecords(actor!, "channel", platform)]);

  const kpis = aggregatePlatformKpis(content.records, platform);
  const trend = buildPlatformTrend(content.records, platform);
  const sourceQuality = buildPlatformSourceQuality(content.records, channel.records, platform);
  const published = selectPublishedContentRecords(content.records, platform, PUBLISHED_CONTENT_ROW_LIMIT);
  const allAccounts = selectLatestAccountSnapshots(channel.records, platform);
  const accountSelections = allAccounts.slice(0, PARTNER_ACCOUNT_ROW_LIMIT);

  // Labels for the DISPLAYED rows only.
  const partnerRefs = distinct([...published.records.map((r) => r.matchedPartnerRef), ...accountSelections.map((s) => s.snapshot.matchedPartnerRef)]);
  const partnerAccountRefs = distinct([...published.records.map((r) => r.matchedPartnerAccountRef), ...accountSelections.map((s) => s.partnerAccountRef)]);
  const campaignRefs = distinct(published.records.map((r) => r.matchedCampaignRef));
  const batchRefs = distinct([...published.records.map((r) => r.batchRef), ...accountSelections.map((s) => s.snapshot.batchRef)]);

  // Feature gates first: a label whose owning feature the actor lacks is
  // never fetched at all. Grants are read ONCE for the Campaign scope check.
  const [partnersFeature, campaignsFeature, grants] = await Promise.all([canAccessFeature(actor!, "partners"), canAccessFeature(actor!, "campaigns"), getActorScopeGrants(actor!)]);

  const [partnerDocs, partnerAccountDocs, campaignDocs, batchFilenames] = await Promise.all([
    partnersFeature ? getPartnerDocsByRefs(partnerRefs) : Promise.resolve(new Map()),
    partnersFeature ? getPartnerAccountDocsByRefs(partnerAccountRefs) : Promise.resolve(new Map()),
    campaignsFeature ? getCampaignDocsByRefs(campaignRefs) : Promise.resolve(new Map()),
    getBatchFilenamesByRefs(batchRefs),
  ]);

  const labelInputs: PlatformViewLabelInputs = {
    actorUid: actor!.uid,
    grants,
    partners: partnerDocs,
    partnerAccounts: partnerAccountDocs,
    campaigns: campaignDocs,
    batchFilenames,
    // Step 12E: a Partner label links to Partner Analytics only when the actor
    // may open that page - the docs above are only loaded with the partners
    // feature, and the accepted Partner Record Scope is decided here in memory
    // from the grants already read ONCE (no per-row read).
    openablePartnerRefs: new Set([...partnerDocs].filter(([, partner]) => isPartnerDocInScope(grants, actor!.uid, partner)).map(([ref]) => ref)),
  };

  return {
    ok: true,
    data: {
      platform,
      coverage: { contentTruncated: content.truncated, channelTruncated: channel.truncated },
      kpis,
      trend,
      publishedContent: { rows: buildPublishedContentRowDtos(published.records, labelInputs), total: published.total },
      partnerAccounts: { rows: buildPartnerAccountRowDtos(accountSelections, labelInputs), totalAccounts: allAccounts.length },
      sourceQuality,
    },
  };
}
