import { getPlatformAnalyticsView } from "@/server/analytics/platform-view-service";
import { PLATFORM_VIEW_IDS, type PlatformViewId } from "@/server/analytics/platform-view-metrics";
import type { ActorContext } from "@/server/authz/types";
import { getPartner } from "@/server/partners/partner-service";

import { buildReportResult } from "../result-builder";
import { mapSourceError } from "../source-errors";
import type { AppliedReportFilters, ReportResult, ReportRow, ReportsServiceResult } from "../types";

// Section 12: Channel Growth & Freshness - Partner Account snapshots from Analytics' own platform
// view (partnerAccounts.rows), with an explicit, Reports-owned staleness disclosure (Analytics itself
// models no "stale" concept - see the catalog entry's own limitations). Bounded to the same small,
// fixed PLATFORM_VIEW_IDS set as Campaign Performance.
const STALE_AFTER_DAYS = 60;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export async function runChannelGrowthFreshnessReport(actor: ActorContext, appliedFilters: AppliedReportFilters): Promise<ReportsServiceResult<ReportResult>> {
  const generatedAt = new Date().toISOString();
  const platformFilter = appliedFilters.platform as PlatformViewId | undefined;
  const partnerRefFilter = appliedFilters.partnerRef;
  const platforms = platformFilter && (PLATFORM_VIEW_IDS as readonly string[]).includes(platformFilter) ? [platformFilter] : [...PLATFORM_VIEW_IDS];

  let partnerDisplayName: string | null = null;
  if (partnerRefFilter) {
    const partner = await getPartner(actor, partnerRefFilter);
    if (!partner.ok) return mapSourceError(partner);
    partnerDisplayName = partner.data.displayName;
  }

  const rows: ReportRow[] = [];
  let latestSourceAt: string | null = null;
  let truncated = false;
  let scanned = 0;

  for (const platform of platforms) {
    const view = await getPlatformAnalyticsView(actor, platform);
    if (!view.ok) return mapSourceError(view);
    if (view.data.coverage.channelTruncated) truncated = true;

    let accounts = view.data.partnerAccounts.rows;
    scanned += accounts.length;
    if (partnerDisplayName) accounts = accounts.filter((row) => row.partnerLabel === partnerDisplayName);

    for (const account of accounts) {
      const ageMs = new Date(generatedAt).getTime() - new Date(account.snapshotAt).getTime();
      const stale = Number.isFinite(ageMs) && ageMs > STALE_AFTER_DAYS * MS_PER_DAY;
      rows.push({ platform, partnerLabel: account.partnerLabel, accountLabel: account.accountLabel, accountHandle: account.accountHandle, profileFollowers: account.profileFollowers, snapshotAt: account.snapshotAt, stale });
      if (account.snapshotAt > (latestSourceAt ?? "")) latestSourceAt = account.snapshotAt;
    }
  }

  const staleAccountCount = rows.filter((row) => row.stale === true).length;

  return {
    ok: true,
    data: buildReportResult({
      reportId: "channel_growth_freshness",
      generatedAt,
      evidenceCutoff: latestSourceAt ?? generatedAt,
      appliedFilters,
      scopeSummary: { basis: "actor-scope (getPlatformAnalyticsView.partnerAccounts)", note: partnerDisplayName ? `Filtered to Partner "${partnerDisplayName}".` : "Every actor-scoped Partner Account row across the requested platform(s)." },
      // unavailableAccountCount is deliberately null, never 0: counting Partner Accounts with NO
      // channel source record at all would require an unbounded scan of Partners' own Partner
      // Accounts beyond what this report's bounded Analytics read already touches - omitted rather
      // than guessed (see the extra limitation below).
      metrics: { accountCount: rows.length, staleAccountCount, unavailableAccountCount: null },
      rows,
      sections: { accounts: rows },
      extraLimitations: ["unavailableAccountCount is not computed in 19A - it would require an unbounded scan of Partner Accounts beyond this report's bounded Analytics read; reported null rather than a guessed 0."],
      truncated,
      rowCount: rows.length,
      provenance: platforms.map((platform) => ({ sourceModule: "analytics", sourceFunction: "getPlatformAnalyticsView", recordCount: rows.filter((r) => r.platform === platform).length, scanned })),
    }),
  };
}
