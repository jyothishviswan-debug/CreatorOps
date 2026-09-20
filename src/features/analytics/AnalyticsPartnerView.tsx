// Step 12E: the presentational Partner-wise Analytics drill-down.
//
// The golden master (docs/reference/CreatorOps_UI_Golden_Master.html) models
// ONLY the combined Analytics Overview - there is no Partner drill-down page in
// it - so this is a NEW composition built exclusively from the foundation
// pieces the accepted Overview and the 12D platform pages already use: the
// Overview's `ov-page` wrapper, ContextBanner, OverviewKpiRow, OverviewRow /
// OverviewPanel, Checks, PlatformTrendGrid (12D), the Explorer's own
// `tablewrap` + `compact` table + Pill, the `.segment` group and the shared
// `btn` links. No new CSS class is introduced.
//
// Agreement / target context is deliberately absent (no accepted safe read
// path at this baseline; Analytics must not duplicate commercial-policy logic).
import Link from "next/link";

import { Pill } from "@/ui/Badge";
import { Checks, ContextBanner, OverviewKpiRow, OverviewPanel, OverviewRow } from "@/ui/Overview";
import { absoluteTime } from "@/features/administration/format";
import { computeFreshnessBadge } from "@/server/analytics/overview-metrics";
import { buildPartnerKpiData, selectionLabel, TOP_CONTENT_LIMIT, type PartnerPlatformCard } from "@/server/analytics/partner-view-metrics";
import type { PartnerAccountRowDto, PartnerAnalyticsViewDto, PartnerContentRowDto, PartnerTopContentRowDto } from "@/server/analytics/partner-view-dto";
import { PLATFORM_VIEW_COPY, PLATFORM_VIEW_METRIC_LABELS, type PlatformViewId } from "@/server/analytics/platform-view-metrics";
import { describeExclusions } from "@/server/analytics/reporting-month";

import { linkageRow, metricCoverageRows, MetricCell, PlaceholderCell, PlatformTrendGrid, UnavailableDash } from "./AnalyticsPlatformView";
import { matchStateLabel, matchStateTone, reportingPeriodLabel } from "./format";
import { formatPublishedDate } from "./platform-view-helpers";

const TRUNCATION_NOTE = "Showing a bounded window of the most recent scoped source records - totals may not reflect the full dataset.";

// Two platforms stay visually distinguishable: each gets its own pill tone.
const PLATFORM_PILL_TONE: Record<PlatformViewId, "purple" | "blue"> = { instagram: "purple", youtube: "blue" };

// Step 12F: `embedded` = rendered INSIDE the Partners workspace, which owns its own
// platform switch and month selector (so this component omits its platform switch
// and the "all periods" link). A view carrying `month` is restricted to that one
// reporting month and says so; every other view is exactly the 12E page.
export function AnalyticsPartnerView({ view, embedded = false }: { view: PartnerAnalyticsViewDto; embedded?: boolean }) {
  const chips = ["Authorized scope preview"];
  if (view.coverage.contentTruncated || view.coverage.channelTruncated) chips.push(TRUNCATION_NOTE);
  // Month-view disclosures are plain wrapping notes (a long nowrap chip could overflow a phone). Embedded in the workspace, the
  // workspace already shows the exclusion disclosure once, so it is not repeated here.
  const notes = [view.monthNotice ?? null, view.month && !embedded ? describeExclusions(view.month.excluded) : null].filter((note): note is string => Boolean(note));

  return (
    <>
      {!embedded && <PlatformSwitch items={view.links.platformSwitch} />}
      {!embedded && view.month && view.links.allPeriodsHref && (
        <div className="actions" style={{ marginBottom: 10 }}>
          <span className="foundationnote">
            Reporting month <b>{view.month.label}</b>
          </span>
          <Link href={view.links.allPeriodsHref} className="btn ghost">
            Show all imported periods
          </Link>
        </div>
      )}

      <ContextBanner
        icon="chart"
        title={`Partner performance · ${selectionLabel(view.selection)}${view.month ? ` · ${view.month.label}` : ""}`}
        description={
          view.month
            ? `Reporting month: ${view.month.label}. Only source records whose reporting period lies entirely within this month are included (the monthly trend shows the latest months). Nothing here is estimated, derived or blended across platforms.`
            : `Reporting period: ${view.period.label}. Not a filter - every imported period within your authorized scope is included. Nothing here is estimated, derived or blended across platforms.`
        }
        chips={chips}
      />
      {notes.map((note) => (
        <p key={note} className="foundationnote" style={{ margin: "0 0 8px" }}>
          {note}
        </p>
      ))}

      <OverviewKpiRow items={buildPartnerKpiData(view.kpis)} />

      <OverviewRow>
        {view.platformPerformance.map((card, index) => (
          <PlatformPerformancePanel key={card.platform} card={card} span={view.platformPerformance.length > 1 ? 6 : 12} tone={index * 2} />
        ))}
      </OverviewRow>

      <OverviewRow secondary>
        <OverviewPanel
          span={12}
          icon="users"
          tone={2}
          title="Partner Accounts"
          note={
            view.partnerAccounts.totalAccounts === 0
              ? "No Partner Accounts linked to Analytics records for this Partner in your authorized scope yet"
              : `One row per Partner Account · ${view.partnerAccounts.rows.length === view.partnerAccounts.totalAccounts ? view.partnerAccounts.totalAccounts : `${view.partnerAccounts.rows.length} of ${view.partnerAccounts.totalAccounts}`} account${view.partnerAccounts.totalAccounts === 1 ? "" : "s"}`
          }
          foot="Per-account, point-in-time snapshots - not growth. No follower total is computed across accounts or platforms."
        >
          <PartnerAccountsTable rows={view.partnerAccounts.rows} />
        </OverviewPanel>
      </OverviewRow>

      <OverviewRow secondary>
        <OverviewPanel
          span={12}
          icon="file"
          tone={1}
          title="Published Content"
          note={
            view.publishedContent.total === 0
              ? "No source content records for this Partner in your authorized scope yet"
              : `Showing ${view.publishedContent.rows.length} of ${view.publishedContent.total} source content record${view.publishedContent.total === 1 ? "" : "s"}, newest first`
          }
          foot="Metrics are source-reported. A dash means the source did not report the value - never zero."
        >
          <PartnerContentTable rows={view.publishedContent.rows} caption="Partner published content source records" empty="Imported content records for this Partner that you are authorized to see will appear here." />
          {view.publishedContent.total > 0 && (
            <div className="actions" style={{ marginTop: 10 }}>
              <Link href={view.links.explorerContentHref} className="btn">
                View all in Data Explorer
              </Link>
            </div>
          )}
        </OverviewPanel>
      </OverviewRow>

      <OverviewRow secondary>
        <OverviewPanel span={12} icon="flag" tone={4} title="Top Content" note={view.topContent.note} foot="One explicit ranking basis, applied as reported - no cross-platform normalization.">
          <TopContentBody view={view} />
        </OverviewPanel>
      </OverviewRow>

      <OverviewRow secondary>
        <OverviewPanel span={12} icon="check" tone={3} title="Data Quality & Freshness" note={view.month ? `This Partner's records for ${view.month.label} in your authorized scope, for the selected platform view` : "This Partner's records in your authorized scope, for the selected platform view"} foot="Missing values stay unavailable; nothing is estimated to fill a gap. Freshness shows the latest import - no staleness threshold is applied.">
          <Checks rows={buildQualityRows(view)} />
        </OverviewPanel>
      </OverviewRow>
    </>
  );
}

// ---- Platform switch (local view filter, real links) -------------------------------------------

function PlatformSwitch({ items }: { items: PartnerAnalyticsViewDto["links"]["platformSwitch"] }) {
  return (
    <div className="actions" style={{ marginBottom: 10 }}>
      <span className="foundationnote">Platform view</span>
      <div className="segment" role="group" aria-label="Platform view" style={{ marginLeft: 0 }}>
        {items.map((item) => (
          <Link key={item.selection} href={item.href} className={item.active ? "btn primary" : "btn ghost"} aria-current={item.active ? "page" : undefined}>
            {item.label}
          </Link>
        ))}
      </div>
    </div>
  );
}

// ---- Platform Performance ----------------------------------------------------------------------

function PlatformPerformancePanel({ card, span, tone }: { card: PartnerPlatformCard; span: number; tone: number }) {
  const copy = PLATFORM_VIEW_COPY[card.platform];
  const monthly = card.trendBasis === "month";
  const omitted = card.trend.omittedMetrics.map((metric) => PLATFORM_VIEW_METRIC_LABELS[metric]);
  const foot = omitted.length > 0 ? `${copy.footnote} Not plotted (source-reported in fewer than two ${monthly ? "months" : "periods"}): ${omitted.join(", ")}.` : copy.footnote;
  const note = !card.hasData
    ? "Unavailable — no source data"
    : card.trend.series.length > 0
      ? monthly
        ? "Source-reported metrics by reporting month (latest 12 calendar months) - a gap means nothing was reported that month"
        : "Source-reported metrics by reporting period (import month where the source gave none) - a gap means nothing was reported"
      : "No trend available yet from source-reported data";
  return (
    <OverviewPanel span={span} icon="chart" tone={tone} title={`${card.label} performance`} note={note} foot={foot}>
      {!card.hasData ? (
        <p className="foundationnote">
          <b>Unavailable</b> — no source data for {card.label} on this Partner in your authorized scope. Nothing is estimated in the meantime.
        </p>
      ) : card.trend.series.length > 0 ? (
        <PlatformTrendGrid trend={card.trend} />
      ) : (
        <p className="foundationnote">A trend needs a source-reported value in at least two reporting {monthly ? "months" : "periods"}. Nothing is estimated in the meantime.</p>
      )}
    </OverviewPanel>
  );
}

// ---- Partner Accounts ----------------------------------------------------------------------------

function PartnerAccountsTable({ rows }: { rows: PartnerAccountRowDto[] }) {
  if (rows.length === 0) return <p className="foundationnote">Imported channel snapshots and content records matched to this Partner&rsquo;s accounts will appear here.</p>;
  return (
    <div className="tablewrap">
      <table className="compact">
        <caption className="sr">Partner Accounts with profile-follower snapshots</caption>
        <thead>
          <tr>
            <th scope="col">Platform</th>
            <th scope="col">Account</th>
            <th scope="col">Profile followers (snapshot)</th>
            <th scope="col">Reporting period</th>
            <th scope="col">Snapshot imported</th>
            <th scope="col">Records in window</th>
            <th scope="col">Source</th>
            <th scope="col">Data Explorer</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              <td>
                <Pill tone={PLATFORM_PILL_TONE[row.platform]}>{PLATFORM_VIEW_COPY[row.platform].label}</Pill>
              </td>
              <td>
                {row.accountLabel ?? <PlaceholderCell>Unavailable</PlaceholderCell>}
                {row.accountHandle && <small> @{row.accountHandle.replace(/^@/, "")}</small>}
              </td>
              <td>
                {row.profileFollowers === null ? <UnavailableDash /> : row.profileFollowers.toLocaleString("en-GB")}
                {row.snapshotCount > 1 && <small> latest of {row.snapshotCount} snapshots</small>}
              </td>
              <td>{row.snapshotAt ? reportingPeriodLabel(row.reportingPeriod) : <PlaceholderCell>No snapshot</PlaceholderCell>}</td>
              <td>{row.snapshotAt ? absoluteTime(row.snapshotAt) : <PlaceholderCell>No snapshot</PlaceholderCell>}</td>
              <td>
                {row.contentRecords + row.channelRecords} <small>({row.contentRecords} content · {row.channelRecords} channel)</small>
              </td>
              <td>{row.source ?? <PlaceholderCell>—</PlaceholderCell>}</td>
              <td>
                <Link href={row.explorerHref} aria-label={`Open ${row.accountLabel ?? "this account"}'s records in Data Explorer`}>
                  Open records
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---- Content tables (Published Content + Top Content) -----------------------------------------------

function PartnerContentTable({ rows, caption, empty, ranked }: { rows: (PartnerContentRowDto | PartnerTopContentRowDto)[]; caption: string; empty: string; ranked?: boolean }) {
  if (rows.length === 0) return <p className="foundationnote">{empty}</p>;
  return (
    <div className="tablewrap">
      <table className="compact">
        <caption className="sr">{caption}</caption>
        <thead>
          <tr>
            {ranked && <th scope="col">Rank</th>}
            <th scope="col">Platform</th>
            <th scope="col">Published</th>
            <th scope="col">Account</th>
            <th scope="col">Campaign</th>
            <th scope="col">Views</th>
            <th scope="col">Engagement</th>
            <th scope="col">Likes</th>
            <th scope="col">Comments</th>
            <th scope="col">Match</th>
            <th scope="col">Source</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const published = formatPublishedDate(row.publishedAt);
            return (
              <tr key={index}>
                {ranked && <td>{"rank" in row ? row.rank : index + 1}</td>}
                <td>
                  <Pill tone={PLATFORM_PILL_TONE[row.platform]}>{PLATFORM_VIEW_COPY[row.platform].label}</Pill>
                </td>
                <td>{published ?? (row.reportingPeriod ? <PlaceholderCell>{reportingPeriodLabel(row.reportingPeriod)}</PlaceholderCell> : <PlaceholderCell>Date unavailable</PlaceholderCell>)}</td>
                <td>{row.accountLabel ?? <PlaceholderCell>—</PlaceholderCell>}</td>
                <td>{row.campaignLabel ?? <PlaceholderCell>—</PlaceholderCell>}</td>
                <MetricCell value={row.views} />
                <MetricCell value={row.engagement} />
                <MetricCell value={row.likes} />
                <MetricCell value={row.comments} />
                <td>
                  <Pill tone={matchStateTone(row.matchState)}>{matchStateLabel(row.matchState)}</Pill>
                </td>
                <td>{row.source}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---- Top Content ---------------------------------------------------------------------------------------

function TopContentBody({ view }: { view: PartnerAnalyticsViewDto }) {
  const { topContent } = view;
  if (topContent.basis === "none") return <p className="foundationnote">No content with reported Views or Engagement. Nothing is ranked - and nothing is estimated in the meantime.</p>;
  const basisLabel = topContent.basis === "views" ? "Views" : "Engagement";
  return (
    <>
      {topContent.groups.map((group) => (
        <div key={group.platform} style={{ marginBottom: 12 }}>
          {view.selection === "all" && (
            <p className="foundationnote" style={{ margin: "0 0 6px" }}>
              <b>{group.label}</b> · top {TOP_CONTENT_LIMIT} by {basisLabel}
            </p>
          )}
          <PartnerContentTable
            rows={group.rows}
            ranked
            caption={`${group.label} top content by ${basisLabel}`}
            empty={`No ${group.label} content with reported ${basisLabel} for this Partner.`}
          />
        </div>
      ))}
    </>
  );
}

// ---- Data Quality / Freshness ----------------------------------------------------------------------------

function buildQualityRows(view: PartnerAnalyticsViewDto): { label: string; detail: string; badge: string }[] {
  const { sourceQuality } = view;
  const withoutAccountRow = (label: string, counts: PartnerAnalyticsViewDto["sourceQuality"]["content"], kind: string) => {
    if (counts.total === 0) return { label, detail: "No source data yet", badge: "No data" };
    return {
      label,
      detail: `${counts.withoutAccount} of ${counts.total} ${kind} record${counts.total === 1 ? "" : "s"} not linked to a Partner Account`,
      badge: counts.withoutAccount > 0 ? "Partial" : "Current",
    };
  };

  const rows = [
    linkageRow("Content linkage", sourceQuality.content),
    linkageRow("Channel linkage", sourceQuality.channel),
    withoutAccountRow("Content account linkage", sourceQuality.content, "content"),
    withoutAccountRow("Channel account linkage", sourceQuality.channel, "channel"),
    ...metricCoverageRows(sourceQuality.missingMetrics),
  ];

  const { latestContentAt, latestChannelAt } = sourceQuality.freshness;
  rows.push({ label: "Content freshness", detail: latestContentAt ? `Latest record ${absoluteTime(latestContentAt)}` : "No source data yet", badge: computeFreshnessBadge(latestContentAt) });
  rows.push({ label: "Channel freshness", detail: latestChannelAt ? `Latest record ${absoluteTime(latestChannelAt)}` : "No source data yet", badge: computeFreshnessBadge(latestChannelAt) });

  const coverage = sourceQuality.accountCoverage;
  rows.push({
    label: "Account coverage",
    detail:
      coverage.accountsTotal === 0 && sourceQuality.content.total + sourceQuality.channel.total === 0
        ? "No source data yet"
        : `${coverage.accountsWithSnapshots} Partner Account${coverage.accountsWithSnapshots === 1 ? "" : "s"} with snapshots · ${coverage.recordsWithoutAccount} platform record${coverage.recordsWithoutAccount === 1 ? "" : "s"} not linked to an account`,
    badge: coverage.accountsTotal === 0 && sourceQuality.content.total + sourceQuality.channel.total === 0 ? "No data" : coverage.recordsWithoutAccount > 0 || coverage.accountsWithSnapshots < coverage.accountsTotal ? "Partial" : "Current",
  });
  return rows;
}
