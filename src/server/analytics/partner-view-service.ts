// Step 12E: getPartnerAnalyticsView - the ONE trusted read behind the
// Partner-wise Analytics drill-down (/analytics/partner/[partnerId]).
//
// Trust chain, in order (each step fails closed):
//   1. Authentication + Analytics read access = requireAnalyticsExploreAccess
//      (analytics feature + the "explore" action) - exactly the Overview /
//      Explorer / 12D gate. Explicit grants only: no rank, no minimumRole, no
//      wildcard. No Import Center access is implied or checked.
//   2. The partners feature, then a LIVE load of the Partner document and the
//      accepted Partner Record Scope (isPartnerDocInScope - the pure form
//      requirePartnerInScope itself delegates to; the actor's grants are read
//      ONCE and reused for the Campaign scope decision below). Knowing a
//      partnerId grants nothing. A missing feature, an UNKNOWN Partner and an
//      OUT-OF-SCOPE Partner all return the identical neutral not_found result:
//      no Partner name, no existence signal.
//   3. Records are fetched ONLY through the accepted, already-scoped
//      listAnalyticsSourceRecords - the Partner filter (matchedPartnerRef) and
//      the platform filter are applied server-side by the accepted planner,
//      scope enforced BEFORE retrieval; never the global admin read-model
//      snapshot, never a browser fetch/filter.
//   4. A deliberately bounded, honest window (<= 10 pages x 100 records per
//      record kind and platform, same bound as the Overview / 12D); when the
//      real dataset is larger, `coverage.*Truncated` says so.
//   5. Labels: at most ONE bulk resolution per distinct-ref family (Partner
//      Accounts / Campaigns / import batches), only for the rows actually
//      displayed - never one read per row. Campaign labels only with the
//      campaigns feature AND the accepted Campaign Record Scope (pure
//      isCampaignDocInScope, grants read once); an out-of-scope Campaign is
//      neutral context (no name, no ref) and the Analytics fact stays visible.
// The result is an actor-safe DTO (see partner-view-dto.ts).
//
// Agreement / target context is deliberately NOT part of this read: there is
// no accepted safe read path for Agreement targets at this baseline, and
// Analytics must not depend on or duplicate commercial-policy logic.
import { canAccessFeature } from "@/server/authz/capabilities";
import { getActorScopeGrants } from "@/server/authz/scope";
import type { ActorContext } from "@/server/authz/types";
import { getCampaignDocsByRefs } from "@/server/campaigns/firestore";
import { getPartnerAccountDocsByRefs, getPartnerDocByRef } from "@/server/partners/firestore";
import { isPartnerDocInScope } from "@/server/partners/partners-gate";

import type { ScopeGrant } from "@/server/authz/types";
import type { PartnerDoc } from "@/server/partners/types";

import { requireAnalyticsExploreAccess } from "./analytics-gate";
import { listAnalyticsSourceRecords } from "./explorer-service";
import { analyticsImportBatchesCollection } from "./firestore";
import { buildPartnerAnalyticsView, displayedLabelRefs, selectPartnerViewRecords, type PartnerAnalyticsViewDto } from "./partner-view-dto";
import { parsePartnerViewSelection, platformsForSelection, type PartnerViewSelection } from "./partner-view-metrics";
import { buildMonthlyPartnerPlatformCards, restrictWindowToSelection, sliceWindowToMonth } from "./partners-workspace-metrics";
import { countExclusions, monthLabel, parseMonthParam } from "./reporting-month";
import type { PlatformViewLabelInputs } from "./platform-view-dto";
import type { PlatformViewId } from "./platform-view-metrics";
import { analyticsImportBatchDocSchema, analyticsNotFoundResult, analyticsUnauthorizedResult, type AnalyticsChannelSourceRecordDoc, type AnalyticsContentSourceRecordDoc, type AnalyticsServiceResult } from "./types";

const BOUNDED_PAGE_SIZE = 100; // explorer-service.ts's own listInputSchema caps `limit` at 100 - never exceed it.
export const MAX_PARTNER_VIEW_PAGES = 10; // 1000 records max per record kind (per platform) - a deliberate, honest bound, never a true fetch-all.
const MAX_PAGES = MAX_PARTNER_VIEW_PAGES;
const IN_QUERY_CHUNK = 30; // Firestore's own `in` cap.
const MAX_PARTNER_REF_LENGTH = 200;

// The ONE neutral outcome for "no such Partner / no access to it": identical
// message and code whether the Partner is unknown, out of scope, or the
// actor's partners feature is absent.
export const INVALID_DETAIL_MONTH_NOTICE = "The month in the link is not a valid reporting month, so all imported periods are shown.";
export const PARTNER_ANALYTICS_NEUTRAL_MESSAGE = "Partner Analytics not found or not available.";
function neutralPartnerResult() {
  return analyticsNotFoundResult(PARTNER_ANALYTICS_NEUTRAL_MESSAGE);
}

export type BoundedRecords<T> = { records: T[]; truncated: boolean };

// A Partner- and platform-filtered bounded cursor loop over the accepted,
// scoped listAnalyticsSourceRecords. Stops at the bound and reports
// `truncated` only when the last permitted page still had a next cursor.
//
// Step 12F: `maxPages` is an optional, smaller per-Partner bound (the Partners
// workspace's comparison reads several Partners); the default is the unchanged
// 12E bound.
export function fetchBoundedPartnerRecords(actor: ActorContext, recordKind: "content", partnerRef: string, platform: PlatformViewId, maxPages?: number): Promise<BoundedRecords<AnalyticsContentSourceRecordDoc>>;
export function fetchBoundedPartnerRecords(actor: ActorContext, recordKind: "channel", partnerRef: string, platform: PlatformViewId, maxPages?: number): Promise<BoundedRecords<AnalyticsChannelSourceRecordDoc>>;
export async function fetchBoundedPartnerRecords(actor: ActorContext, recordKind: "content" | "channel", partnerRef: string, platform: PlatformViewId, maxPages: number = MAX_PAGES): Promise<BoundedRecords<AnalyticsContentSourceRecordDoc | AnalyticsChannelSourceRecordDoc>> {
  const records: (AnalyticsContentSourceRecordDoc | AnalyticsChannelSourceRecordDoc)[] = [];
  let cursor: Record<string, unknown> | undefined;
  let truncated = false;
  for (let page = 0; page < maxPages; page++) {
    const result = await listAnalyticsSourceRecords(actor, { recordKind, platform, matchedPartnerRef: partnerRef, limit: BOUNDED_PAGE_SIZE, cursor });
    if (!result.ok || result.data.recordKind !== recordKind) break;
    records.push(...result.data.records);
    if (!result.data.nextCursor) break;
    cursor = result.data.nextCursor as Record<string, unknown>;
    if (page === maxPages - 1) truncated = true;
  }
  return { records, truncated };
}

// ONE bulk, chunked `in` read of the import batches' filenames for the
// displayed rows (a handful of distinct batches) - Analytics import batches
// are not record-scoped; they are readable with the same explore access.
export async function getBatchFilenamesByRefs(batchRefs: string[]): Promise<Map<string, string>> {
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

// Step 12F: everything AFTER the bounded read - the optional month restriction, the
// bulk label loads and the DTO - shared verbatim by the Partner drill-down and the
// Partners workspace's inline single-Partner view, so the two can never drift.
// `month` (an already-validated `YYYY-MM`) restricts every section to records whose
// reporting period lies entirely in that month (see reporting-month.ts) and swaps
// the per-period Platform Performance cards for the monthly-trend cards; when it
// is absent the DTO is byte-identical to Step 12E's.
export async function assemblePartnerAnalyticsView(params: {
  actor: ActorContext;
  grants: ScopeGrant[];
  campaignsFeature: boolean;
  partner: PartnerDoc;
  content: AnalyticsContentSourceRecordDoc[];
  channel: AnalyticsChannelSourceRecordDoc[];
  coverage: { contentTruncated: boolean; channelTruncated: boolean };
  selection: PartnerViewSelection;
  month?: string | null;
}): Promise<PartnerAnalyticsViewDto> {
  const { actor, grants, campaignsFeature, partner, coverage, selection } = params;

  let content = params.content;
  let channel = params.channel;
  let monthFields: { month?: NonNullable<Parameters<typeof buildPartnerAnalyticsView>[0]["month"]>; platformPerformance?: ReturnType<typeof buildMonthlyPartnerPlatformCards> } = {};
  if (params.month) {
    const restricted = restrictWindowToSelection({ content, channel, truncated: false }, selection);
    const inMonth = sliceWindowToMonth(restricted, params.month);
    monthFields = {
      month: { month: params.month, label: monthLabel(params.month), excluded: countExclusions([...restricted.content, ...restricted.channel]), windowRecords: restricted.content.length + restricted.channel.length },
      platformPerformance: buildMonthlyPartnerPlatformCards(restricted.content, selection),
    };
    content = inMonth.content;
    channel = inMonth.channel;
  }

  const selected = selectPartnerViewRecords(content, channel, selection);
  const refs = displayedLabelRefs(selected);

  const [accountDocs, campaignDocs, batchFilenames] = await Promise.all([
    getPartnerAccountDocsByRefs(refs.partnerAccountRefs),
    // A Campaign the actor lacks the feature for is never fetched at all.
    campaignsFeature ? getCampaignDocsByRefs(refs.campaignRefs) : Promise.resolve(new Map()),
    getBatchFilenamesByRefs(refs.batchRefs),
  ]);

  // A Partner Account label is used only when the account really belongs to
  // THIS Partner - a record's projection is never trusted to name another
  // Partner's account.
  const partnerAccounts = new Map([...accountDocs].filter(([, account]) => account.partnerRef === partner.partnerRef));

  const inputs: PlatformViewLabelInputs = {
    actorUid: actor.uid,
    grants,
    partners: new Map(),
    partnerAccounts,
    campaigns: campaignDocs,
    batchFilenames,
  };

  return buildPartnerAnalyticsView({ partnerRef: partner.partnerRef, partnerDisplayName: partner.displayName, selected, coverage, inputs, ...monthFields });
}

// `monthInput` (Step 12F, optional) is the raw ?month= of the drill-down: valid
// `YYYY-MM` restricts the view to that reporting month; absent or invalid keeps the
// unchanged "all imported periods" view (an invalid value is disclosed, never guessed).
export async function getPartnerAnalyticsView(actor: ActorContext | null, partnerRefInput: unknown, platformInput?: unknown, monthInput?: unknown): Promise<AnalyticsServiceResult<PartnerAnalyticsViewDto>> {
  const gate = await requireAnalyticsExploreAccess(actor);
  if (!gate.ok) return analyticsUnauthorizedResult(gate.reason);

  if (typeof partnerRefInput !== "string" || partnerRefInput.length === 0 || partnerRefInput.length > MAX_PARTNER_REF_LENGTH) return neutralPartnerResult();
  const partnerRef = partnerRefInput;

  // Partner access: feature, live document, Record Scope - all collapsing into
  // the one neutral outcome. Grants are read ONCE (Campaign scope reuses them).
  const [partnersFeature, campaignsFeature, grants, partner] = await Promise.all([
    canAccessFeature(actor!, "partners"),
    canAccessFeature(actor!, "campaigns"),
    getActorScopeGrants(actor!),
    getPartnerDocByRef(partnerRef),
  ]);
  if (!partnersFeature || !partner || !isPartnerDocInScope(grants, actor!.uid, partner)) return neutralPartnerResult();

  const selection = parsePartnerViewSelection(platformInput);
  const platforms = platformsForSelection(selection);
  const parsedMonth = parseMonthParam(monthInput);

  // Each included platform's Partner-filtered records, kept separate.
  const fetched = await Promise.all(
    platforms.map(async (platform) => {
      const [content, channel] = await Promise.all([fetchBoundedPartnerRecords(actor!, "content", partnerRef, platform), fetchBoundedPartnerRecords(actor!, "channel", partnerRef, platform)]);
      return { content, channel };
    }),
  );
  const content = fetched.flatMap((entry) => entry.content.records);
  const channel = fetched.flatMap((entry) => entry.channel.records);
  const coverage = { contentTruncated: fetched.some((entry) => entry.content.truncated), channelTruncated: fetched.some((entry) => entry.channel.truncated) };

  const view = await assemblePartnerAnalyticsView({ actor: actor!, grants, campaignsFeature, partner, content, channel, coverage, selection, month: parsedMonth.month });
  return { ok: true, data: parsedMonth.invalid ? { ...view, monthNotice: INVALID_DETAIL_MONTH_NOTICE } : view };
}
