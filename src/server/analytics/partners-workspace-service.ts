// Step 12F: the trusted reads behind the Partners Analytics workspace
// (/analytics/partners): getPartnersWorkspace (the page) and
// searchWorkspacePartners (the selector's search API).
//
// getPartnersWorkspace - trust chain, in order (each step fails closed):
//   1. Authentication + Analytics read access = requireAnalyticsExploreAccess
//      (analytics feature + the "explore" action) - exactly the Overview /
//      Explorer / 12D / 12E gate. Explicit grants only: no rank, no minimumRole,
//      no wildcard. No Import Center access is implied or checked.
//   2. The partners feature (a caller without it is denied, not degraded).
//   3. Every request parameter is parsed and BOUNDED (partners-workspace-
//      params.ts): month `^\d{4}-(0[1-9]|1[0-2])$`, platform via the shared
//      normalizer, canonical Target Audience values only, a hard selection cap.
//   4. Each selected Partner is loaded LIVE (one bulk read by canonical
//      partnerRef - never display-name matching) and checked against the accepted
//      Partner Record Scope with the pure isPartnerDocInScope, the actor's grants
//      read ONCE. A ref that is unknown, out of scope or malformed is DROPPED
//      from the selection with ONE neutral notice - indistinguishable between the
//      three; no name, no existence signal - and never yields any data.
//   5. Records come ONLY through the accepted, already-scoped
//      listAnalyticsSourceRecords - the Partner and platform filters are pushed
//      to the accepted planner (scope enforced BEFORE retrieval), in bounded
//      cursor loops with a per-Partner `truncated` flag; never the global admin
//      snapshot, never a browser fetch/filter. The month restriction and the
//      month-availability derivation run in this SERVER code over those bounded,
//      scoped records.
//   6. With NOTHING selected the month list / default derive from a small bounded
//      scan of the actor's own scoped, platform-filtered, Partner-linked records
//      (truncation disclosed).
//   7. Labels: the single-Partner inline view reuses the 12E bulk label loads
//      (Campaign labels only with the campaigns feature AND the accepted
//      Campaign Record Scope); the comparison needs only the Partners' display
//      names, already loaded live.
//
// Target Audience and region are Partner-DISCOVERY aids of the selector only:
// they narrow the search list and never select Partners, filter the selection,
// touch Analytics data or broaden scope. No Tier filter exists here.
//
// No new datastore, no projection used for authorization, no Firestore writes.
import { canAccessFeature } from "@/server/authz/capabilities";
import { getActorScopeGrants } from "@/server/authz/scope";
import type { ActorContext } from "@/server/authz/types";
import { getPartnerDocsByRefs } from "@/server/partners/firestore";
import { listPartners } from "@/server/partners/partner-service";
import { isPartnerDocInScope } from "@/server/partners/partners-gate";

import { requireAnalyticsExploreAccess } from "./analytics-gate";
import { listAnalyticsSourceRecords } from "./explorer-service";
import { assemblePartnerAnalyticsView, fetchBoundedPartnerRecords, MAX_PARTNER_VIEW_PAGES } from "./partner-view-service";
import { platformsForSelection } from "./partner-view-metrics";
import { buildPartnersWorkspaceDto, type PartnerSearchResultDto, type PartnersWorkspaceDto } from "./partners-workspace-dto";
import { availableMonthsOf, restrictWindowToSelection, type PartnerRecordWindow } from "./partners-workspace-metrics";
import { parsePartnerSearchInput, parseWorkspaceParams, type WorkspaceParamsInput } from "./partners-workspace-params";
import type { PlatformViewId } from "./platform-view-metrics";
import { resolveMonth } from "./reporting-month";
import { analyticsInvalidInputResult, analyticsUnauthorizedResult, type AnalyticsChannelSourceRecordDoc, type AnalyticsContentSourceRecordDoc, type AnalyticsServiceResult } from "./types";

const BOUNDED_PAGE_SIZE = 100; // explorer-service.ts's own listInputSchema caps `limit` at 100 - never exceed it.
// Comparison (2+ Partners): a smaller per-Partner bound than the single-Partner view.
export const COMPARISON_MAX_PAGES = 3;
// The no-selection whole-scope scan (month list / default only).
export const CONTEXT_SCAN_MAX_PAGES = 3;
const PARTNER_READ_CONCURRENCY = 3;

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

type Bounded<T> = { records: T[]; truncated: boolean };

// The no-selection scan: this actor's own scoped, platform-filtered records
// (planner-scoped before retrieval), newest import first, at most
// CONTEXT_SCAN_MAX_PAGES pages of 100 per record kind and platform.
async function scanScopedRecords(actor: ActorContext, recordKind: "content", platform: PlatformViewId): Promise<Bounded<AnalyticsContentSourceRecordDoc>>;
async function scanScopedRecords(actor: ActorContext, recordKind: "channel", platform: PlatformViewId): Promise<Bounded<AnalyticsChannelSourceRecordDoc>>;
async function scanScopedRecords(actor: ActorContext, recordKind: "content" | "channel", platform: PlatformViewId): Promise<Bounded<AnalyticsContentSourceRecordDoc | AnalyticsChannelSourceRecordDoc>> {
  const records: (AnalyticsContentSourceRecordDoc | AnalyticsChannelSourceRecordDoc)[] = [];
  let cursor: Record<string, unknown> | undefined;
  let truncated = false;
  for (let page = 0; page < CONTEXT_SCAN_MAX_PAGES; page++) {
    const result = await listAnalyticsSourceRecords(actor, { recordKind, platform, limit: BOUNDED_PAGE_SIZE, cursor });
    if (!result.ok || result.data.recordKind !== recordKind) break;
    records.push(...result.data.records);
    if (!result.data.nextCursor) break;
    cursor = result.data.nextCursor as Record<string, unknown>;
    if (page === CONTEXT_SCAN_MAX_PAGES - 1) truncated = true;
  }
  return { records, truncated };
}

// One Partner's bounded window across the selected platforms (Partner + platform
// filters pushed to the accepted planner, kept per platform).
async function readPartnerWindow(actor: ActorContext, partnerRef: string, platforms: PlatformViewId[], maxPages: number): Promise<PartnerRecordWindow & { contentTruncated: boolean; channelTruncated: boolean }> {
  const perPlatform = await Promise.all(
    platforms.map(async (platform) => {
      const [content, channel] = await Promise.all([fetchBoundedPartnerRecords(actor, "content", partnerRef, platform, maxPages), fetchBoundedPartnerRecords(actor, "channel", partnerRef, platform, maxPages)]);
      return { content, channel };
    }),
  );
  const contentTruncated = perPlatform.some((entry) => entry.content.truncated);
  const channelTruncated = perPlatform.some((entry) => entry.channel.truncated);
  return {
    content: perPlatform.flatMap((entry) => entry.content.records),
    channel: perPlatform.flatMap((entry) => entry.channel.records),
    truncated: contentTruncated || channelTruncated,
    contentTruncated,
    channelTruncated,
  };
}

export async function getPartnersWorkspace(actor: ActorContext | null, rawParams: WorkspaceParamsInput): Promise<AnalyticsServiceResult<PartnersWorkspaceDto>> {
  const gate = await requireAnalyticsExploreAccess(actor);
  if (!gate.ok) return analyticsUnauthorizedResult(gate.reason);
  if (!(await canAccessFeature(actor!, "partners"))) return analyticsUnauthorizedResult("feature_denied");

  const state = parseWorkspaceParams(rawParams);
  const platforms = platformsForSelection(state.platform);

  // Grants are read ONCE: the Partner scope decision and the Campaign label scope reuse them.
  const [campaignsFeature, grants, partnerDocs] = await Promise.all([
    canAccessFeature(actor!, "campaigns"),
    getActorScopeGrants(actor!),
    state.partnerRefs.length > 0 ? getPartnerDocsByRefs(state.partnerRefs) : Promise.resolve(new Map()),
  ]);

  // Selection order is the caller's own; anything unknown / out of scope is
  // dropped without a trace beyond the neutral count.
  const selectedDocs = state.partnerRefs.flatMap((ref) => {
    const doc = partnerDocs.get(ref);
    return doc && isPartnerDocInScope(grants, actor!.uid, doc) ? [doc] : [];
  });
  const unavailableCount = state.partnerRefs.length - selectedDocs.length;

  let windows: PartnerRecordWindow[] = [];
  let contextWindows: PartnerRecordWindow[];
  let singleRaw: (PartnerRecordWindow & { contentTruncated: boolean; channelTruncated: boolean }) | null = null;

  if (selectedDocs.length > 0) {
    const maxPages = selectedDocs.length === 1 ? MAX_PARTNER_VIEW_PAGES : COMPARISON_MAX_PAGES;
    const raw = await mapWithConcurrency(selectedDocs, PARTNER_READ_CONCURRENCY, (doc) => readPartnerWindow(actor!, doc.partnerRef, platforms, maxPages));
    if (selectedDocs.length === 1) singleRaw = raw[0]!;
    windows = raw.map((window) => restrictWindowToSelection(window, state.platform));
    contextWindows = windows;
  } else {
    const scanned = await Promise.all(
      platforms.map(async (platform) => {
        const [content, channel] = await Promise.all([scanScopedRecords(actor!, "content", platform), scanScopedRecords(actor!, "channel", platform)]);
        return { content, channel };
      }),
    );
    // Partner-linked records only: this month context is "the actor's whole authorized Partner-linked data".
    contextWindows = [
      {
        content: scanned.flatMap((entry) => entry.content.records).filter((record) => record.matchedPartnerRef !== null),
        channel: scanned.flatMap((entry) => entry.channel.records).filter((record) => record.matchedPartnerRef !== null),
        truncated: scanned.some((entry) => entry.content.truncated || entry.channel.truncated),
      },
    ];
  }

  // The single-Partner inline view (12E sections for the resolved month). It needs the
  // resolved month, which follows the same data as the DTO builder's own derivation.
  let single = null;
  if (selectedDocs.length === 1 && singleRaw) {
    const month = resolveMonth(state.month, availableMonthsOf(contextWindows)).month;
    single = await assemblePartnerAnalyticsView({
      actor: actor!,
      grants,
      campaignsFeature,
      partner: selectedDocs[0]!,
      // No resolvable month = nothing to show for any month (never "all periods" by accident).
      content: month ? singleRaw.content : [],
      channel: month ? singleRaw.channel : [],
      coverage: { contentTruncated: singleRaw.contentTruncated, channelTruncated: singleRaw.channelTruncated },
      selection: state.platform,
      month,
    });
  }

  return {
    ok: true,
    data: buildPartnersWorkspaceDto({
      state,
      selected: selectedDocs.map((doc) => ({ ref: doc.partnerRef, displayName: doc.displayName, regions: doc.regionIds, targetAudience: doc.targetAudience })),
      unavailableCount,
      windows,
      contextWindows,
      single,
    }),
  };
}

// ---- Partner search (the selector) ----------------------------------------------------------------------

export type PartnerSearchResponse = { partners: PartnerSearchResultDto[]; hasMore: boolean };

// Bounded (<= 20, default 10), scope-first Partner search. Analytics explore gate
// + the accepted Partners list (listPartners): the actor's Partner Record Scope is
// applied by the accepted planner BEFORE retrieval; displayNamePrefix, Target
// Audience and region are pushed to that same planner - a filter can only narrow
// what scope already allows, never add a Partner. Every status is searchable
// (listPartners applies no default status filter, like the 12E drill-down which
// opens any in-scope Partner), so a paused Partner's historical Analytics stays
// reachable. Results carry SAFE display identity only: display name, region
// labels and Target Audience values (plus the opaque canonical ref the selector
// round-trips into the URL) - no email, phone, legal name, owner or status.
export async function searchWorkspacePartners(actor: ActorContext | null, rawInput: unknown): Promise<AnalyticsServiceResult<PartnerSearchResponse>> {
  const gate = await requireAnalyticsExploreAccess(actor);
  if (!gate.ok) return analyticsUnauthorizedResult(gate.reason);
  if (!(await canAccessFeature(actor!, "partners"))) return analyticsUnauthorizedResult("feature_denied");

  const parsed = parsePartnerSearchInput(rawInput && typeof rawInput === "object" ? (rawInput as Record<string, unknown>) : {});
  if (!parsed.ok) return analyticsInvalidInputResult(parsed.message);
  const { prefix, targetAudience, regions, limit } = parsed.input;

  const result = await listPartners(actor, {
    displayNamePrefix: prefix.length > 0 ? prefix : undefined,
    targetAudience: targetAudience.length > 0 ? targetAudience : undefined,
    region: regions.length > 0 ? regions : undefined,
    limit,
  });
  if (!result.ok) return analyticsUnauthorizedResult(result.reason === "not_authenticated" ? "not_authenticated" : "feature_denied");

  return {
    ok: true,
    data: {
      partners: result.data.partners.map((partner) => ({ ref: partner.partnerRef, displayName: partner.displayName, regions: partner.regionIds, targetAudience: partner.targetAudience })),
      hasMore: result.data.nextCursor !== null,
    },
  };
}
