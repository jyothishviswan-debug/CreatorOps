// Step 12E: the actor-safe DTO shape of the Partner Analytics drill-down, plus
// the PURE builders that turn already-selected, already-scoped source records
// and already-loaded label documents into it. No I/O here
// (partner-view-service.ts loads the docs); no authorization DECISION is taken
// from any projection - the only decision made here is the Campaign label's
// Record Scope check (reused from platform-view-dto.ts), evaluated in memory
// from the actor's own grants against the LIVE Campaign document.
//
// Actor-safety: the DTO carries display labels, numbers, dates and same-origin
// HREFS only. There is no raw uid, no bare *Ref field, no Firestore path, no
// post/media URL and no restricted Partner profile field (no legal name, email,
// phone, KYC/bank/tax) - the Partner is represented by its display name alone.
// A label that cannot be resolved (or that the actor may not see) is `null`;
// the UI renders a neutral placeholder. Rows are addressed by their position in
// the response, never by an internal id. The only place a canonical ref appears
// is INSIDE an `*Href` path (the same partnerRef the Partner profile route
// already carries in its URL).
import { sourceLabel } from "@/features/analytics/explorer-helpers";

import { partnerAccountLabelOf, buildPublishedContentRowDtos, type PlatformContentRowDto, type PlatformViewLabelInputs } from "./platform-view-dto";
import { partnerAnalyticsPath, partnerExplorerPath, partnerProfilePath } from "./partner-view-links";
import {
  aggregatePartnerKpis,
  buildPartnerPlatformCards,
  buildPartnerSourceQuality,
  derivePartnerReportingPeriod,
  PARTNER_ACCOUNT_ROW_LIMIT,
  PARTNER_VIEW_SELECTIONS,
  platformLabelOf,
  platformsForSelection,
  selectPartnerAccounts,
  selectTopContent,
  topContentNote,
  type PartnerAccountSelection,
  type PartnerKpis,
  type PartnerPlatformCard,
  type PartnerReportingPeriod,
  type PartnerSourceQuality,
  type PartnerViewSelection,
  type TopContentBasis,
} from "./partner-view-metrics";
import { comparePublishedContentNewestFirst, forPlatform, parsePlatformViewId, PLATFORM_VIEW_COPY, type PlatformViewId } from "./platform-view-metrics";
import type { AnalyticsChannelSourceRecordDoc, AnalyticsContentSourceRecordDoc } from "./types";

export const PARTNER_PUBLISHED_CONTENT_ROW_LIMIT = 10;

// A content row of the Partner page: the 12D row minus its Partner label /
// link (the whole page IS that Partner), plus the row's own platform (Instagram
// and YouTube rows share these tables and stay visually distinguishable).
export type PartnerContentRowDto = Omit<PlatformContentRowDto, "partnerLabel" | "partnerAnalyticsHref"> & { platform: PlatformViewId };
export type PartnerTopContentRowDto = PartnerContentRowDto & { rank: number };

export type PartnerAccountRowDto = {
  platform: PlatformViewId;
  accountLabel: string | null;
  accountHandle: string | null;
  // ONE account's latest verified snapshot value - a point in time, never a
  // sum and never growth. `null` = not source-reported (Unavailable).
  profileFollowers: number | null;
  reportingPeriod: { start: string; end: string } | null;
  // When the snapshot's owning record was imported (freshness); `null` when the
  // account has no channel snapshot in the window.
  snapshotAt: string | null;
  snapshotCount: number;
  // Analytics source records for THIS account in the current window.
  contentRecords: number;
  channelRecords: number;
  source: string | null;
  // Data Explorer filtered to exactly this Partner Account (server-honored).
  explorerHref: string;
};

export type PartnerPlatformSwitchItem = { selection: PartnerViewSelection; label: string; href: string; active: boolean };

export type PartnerTopContentGroupDto = { platform: PlatformViewId; label: string; rows: PartnerTopContentRowDto[] };

export type PartnerAnalyticsViewDto = {
  // Display name ONLY - no status/tier/legal name/contact field (none is part
  // of an Analytics-safe DTO).
  partner: { displayName: string };
  selection: PartnerViewSelection;
  links: {
    // Present only because the actor passed the partners feature + Partner
    // Record Scope (the same check the profile route itself applies).
    profileHref: string;
    platformSwitch: PartnerPlatformSwitchItem[];
    // Data Explorer carrying this Partner filter (+ platform only when selected).
    explorerContentHref: string;
    explorerChannelHref: string;
  };
  coverage: { contentTruncated: boolean; channelTruncated: boolean };
  period: PartnerReportingPeriod;
  kpis: PartnerKpis;
  platformPerformance: PartnerPlatformCard[];
  partnerAccounts: { rows: PartnerAccountRowDto[]; totalAccounts: number };
  publishedContent: { rows: PartnerContentRowDto[]; total: number };
  topContent: { basis: TopContentBasis; note: string; groups: PartnerTopContentGroupDto[] };
  sourceQuality: PartnerSourceQuality;
};

// ---- Builders --------------------------------------------------------------------------------

function platformOf(record: { platform: string }): PlatformViewId {
  // Records reaching here were already filtered to the included platforms.
  return parsePlatformViewId(record.platform) as PlatformViewId;
}

export function buildPartnerContentRowDtos(records: AnalyticsContentSourceRecordDoc[], inputs: PlatformViewLabelInputs): PartnerContentRowDto[] {
  // The 12D builder is reused verbatim (labels, Campaign scope decision, source
  // provenance); this only drops the Partner fields and adds the platform.
  return buildPublishedContentRowDtos(records, inputs).map((row, index) => ({
    publishedAt: row.publishedAt,
    reportingPeriod: row.reportingPeriod,
    accountLabel: row.accountLabel,
    campaignLabel: row.campaignLabel,
    matchState: row.matchState,
    views: row.views,
    engagement: row.engagement,
    likes: row.likes,
    comments: row.comments,
    source: row.source,
    platform: platformOf(records[index]!),
  }));
}

export function buildPartnerTopContentGroupDtos(groups: { platform: PlatformViewId; records: AnalyticsContentSourceRecordDoc[] }[], inputs: PlatformViewLabelInputs): PartnerTopContentGroupDto[] {
  return groups.map(({ platform, records }) => ({
    platform,
    label: platformLabelOf(platform),
    rows: buildPartnerContentRowDtos(records, inputs).map((row, index) => ({ ...row, rank: index + 1 })),
  }));
}

export function buildPartnerAccountRowDtos(selections: PartnerAccountSelection[], inputs: PlatformViewLabelInputs): PartnerAccountRowDto[] {
  const batchLabels = { content: {}, campaigns: {}, partners: {}, partnerAccounts: {}, batches: Object.fromEntries(inputs.batchFilenames) };
  return selections.map(({ partnerAccountRef, platform, snapshot, snapshotCount, contentRecords, channelRecords }) => {
    const account = inputs.partnerAccounts.get(partnerAccountRef);
    const label = account ? partnerAccountLabelOf(account) : null;
    return {
      platform,
      accountLabel: label,
      // "@username" only when it adds information beyond the label itself.
      accountHandle: account?.handle && account.handle !== label ? account.handle : null,
      profileFollowers: snapshot?.profileFollowers ?? null,
      reportingPeriod: snapshot?.reportingPeriod ?? null,
      snapshotAt: snapshot?.createdAt ?? null,
      snapshotCount,
      contentRecords,
      channelRecords,
      source: snapshot ? sourceLabel(snapshot, batchLabels) : null,
      explorerHref: partnerExplorerPath({ partnerAccountRef, platform, recordKind: contentRecords > 0 ? "content" : "channel" }),
    };
  });
}

export function buildPartnerPlatformSwitch(partnerRef: string, selection: PartnerViewSelection): PartnerPlatformSwitchItem[] {
  return PARTNER_VIEW_SELECTIONS.map((item) => ({
    selection: item,
    label: item === "all" ? "All" : PLATFORM_VIEW_COPY[item].label,
    href: partnerAnalyticsPath(partnerRef, item),
    active: item === selection,
  }));
}

// The bounded, deterministic selection of what the page DISPLAYS, computed once
// (pure) so the service can bulk-load labels for the displayed rows ONLY and
// then hand the same selection to buildPartnerAnalyticsView.
export type PartnerViewSelectedRecords = {
  selection: PartnerViewSelection;
  content: AnalyticsContentSourceRecordDoc[];
  channel: AnalyticsChannelSourceRecordDoc[];
  allAccounts: PartnerAccountSelection[];
  displayedAccounts: PartnerAccountSelection[];
  publishedRows: AnalyticsContentSourceRecordDoc[];
  top: ReturnType<typeof selectTopContent>;
};

export function selectPartnerViewRecords(content: AnalyticsContentSourceRecordDoc[], channel: AnalyticsChannelSourceRecordDoc[], selection: PartnerViewSelection): PartnerViewSelectedRecords {
  const platforms = platformsForSelection(selection);
  // Belt and braces (same discipline as 12D): only the included platforms'
  // records can ever enter the DTO, even if a caller passed a mixed window.
  const includedContent = platforms.flatMap((platform) => forPlatform(content, platform));
  const includedChannel = platforms.flatMap((platform) => forPlatform(channel, platform));
  const allAccounts = selectPartnerAccounts(includedContent, includedChannel, selection);
  return {
    selection,
    content: includedContent,
    channel: includedChannel,
    allAccounts,
    displayedAccounts: allAccounts.slice(0, PARTNER_ACCOUNT_ROW_LIMIT),
    publishedRows: [...includedContent].sort(comparePublishedContentNewestFirst).slice(0, PARTNER_PUBLISHED_CONTENT_ROW_LIMIT),
    top: selectTopContent(includedContent, selection),
  };
}

// The distinct, non-null refs of the DISPLAYED rows - what the service loads
// labels for (one bulk read per family, never per row).
export function displayedLabelRefs(selected: PartnerViewSelectedRecords): { partnerAccountRefs: string[]; campaignRefs: string[]; batchRefs: string[] } {
  const rows = [...selected.publishedRows, ...selected.top.groups.flatMap((group) => group.records)];
  const distinct = (values: (string | null)[]) => [...new Set(values.filter((value): value is string => Boolean(value)))];
  return {
    partnerAccountRefs: distinct([...rows.map((r) => r.matchedPartnerAccountRef), ...selected.displayedAccounts.map((a) => a.partnerAccountRef)]),
    campaignRefs: distinct(rows.map((r) => r.matchedCampaignRef)),
    batchRefs: distinct([...rows.map((r) => r.batchRef), ...selected.displayedAccounts.map((a) => a.snapshot?.batchRef ?? null)]),
  };
}

export function buildPartnerAnalyticsView(params: {
  partnerRef: string;
  partnerDisplayName: string;
  selected: PartnerViewSelectedRecords;
  coverage: { contentTruncated: boolean; channelTruncated: boolean };
  inputs: PlatformViewLabelInputs;
}): PartnerAnalyticsViewDto {
  const { partnerRef, partnerDisplayName, selected, coverage, inputs } = params;
  const { selection } = selected;

  return {
    partner: { displayName: partnerDisplayName },
    selection,
    links: {
      profileHref: partnerProfilePath(partnerRef),
      platformSwitch: buildPartnerPlatformSwitch(partnerRef, selection),
      explorerContentHref: partnerExplorerPath({ partnerRef, platform: selection, recordKind: "content" }),
      explorerChannelHref: partnerExplorerPath({ partnerRef, platform: selection, recordKind: "channel" }),
    },
    coverage,
    period: derivePartnerReportingPeriod([...selected.content, ...selected.channel]),
    kpis: aggregatePartnerKpis(selected.content, selection),
    platformPerformance: buildPartnerPlatformCards(selected.content, selection),
    partnerAccounts: { rows: buildPartnerAccountRowDtos(selected.displayedAccounts, inputs), totalAccounts: selected.allAccounts.length },
    publishedContent: { rows: buildPartnerContentRowDtos(selected.publishedRows, inputs), total: selected.content.length },
    topContent: { basis: selected.top.basis, note: topContentNote(selected.top.basis, selection), groups: buildPartnerTopContentGroupDtos(selected.top.groups, inputs) },
    sourceQuality: buildPartnerSourceQuality(selected.content, selected.channel, selection, selected.allAccounts),
  };
}
