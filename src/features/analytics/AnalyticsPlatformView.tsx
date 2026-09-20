// Step 12D: the ONE presentational implementation of the separate Instagram /
// YouTube Analytics views, parameterized by the DTO's normalized platform id.
//
// The golden master (docs/reference/CreatorOps_UI_Golden_Master.html) models
// ONLY the combined Analytics Overview - there is no dedicated per-platform
// page in it - so this is a NEW composition built exclusively from the
// already-accepted foundation building blocks: the Overview's `ov-page`
// wrapper, ContextBanner, OverviewKpiRow, OverviewRow/OverviewPanel, Checks,
// the Explorer's own `tablewrap` + compact table + Pill styles and the shared
// `btn` links. No new CSS class is introduced. The one thing that could not be
// reused verbatim is TrendGrid (its axis labels, "vs Jul" delta and value
// scale are hard-coded to demo data and it cannot draw gaps) - PlatformTrendGrid
// below reuses TrendGrid's exact markup/class names instead.
import Link from "next/link";
import type { ReactNode } from "react";

import { Pill } from "@/ui/Badge";
import { Checks, ContextBanner, OverviewKpiRow, OverviewPanel, OverviewRow, TONES } from "@/ui/Overview";
import { absoluteTime } from "@/features/administration/format";
import { buildPlatformKpiData, PLATFORM_VIEW_COPY, PLATFORM_VIEW_METRIC_LABELS, type PlatformTrend } from "@/server/analytics/platform-view-metrics";
import { computeFreshnessBadge } from "@/server/analytics/overview-metrics";
import type { PlatformAccountRowDto, PlatformAnalyticsViewDto, PlatformContentRowDto } from "@/server/analytics/platform-view-dto";
import type { LinkageCounts, MissingMetricEntry } from "@/server/analytics/platform-view-metrics";

import { formatMetric, matchStateLabel, matchStateTone, reportingPeriodLabel } from "./format";
import { computeTrendGeometry, describeLatestTrendChange, formatPublishedDate, platformExplorerHref } from "./platform-view-helpers";

const TRUNCATION_NOTE = "Showing a bounded window of the most recent scoped source records - totals may not reflect the full dataset.";

export function AnalyticsPlatformView({ view }: { view: PlatformAnalyticsViewDto }) {
  const copy = PLATFORM_VIEW_COPY[view.platform];
  const chips = ["Authorized scope preview"];
  if (view.coverage.contentTruncated || view.coverage.channelTruncated) chips.push(TRUNCATION_NOTE);

  return (
    <>
      <ContextBanner icon="chart" title={`${copy.label} source-reported performance`} description="Platform-filtered source records within your authorized scope. Nothing here is estimated, derived or blended across platforms." chips={chips} />

      <OverviewKpiRow items={buildPlatformKpiData(view.kpis)} />

      <OverviewRow>
        <PlatformTrendPanel platform={view.platform} trend={view.trend} />
      </OverviewRow>

      <OverviewRow secondary>
        <OverviewPanel
          span={12}
          icon="file"
          tone={1}
          title="Published Content"
          note={
            view.publishedContent.total === 0
              ? "No source content records for this platform in your authorized scope yet"
              : `Showing ${view.publishedContent.rows.length} of ${view.publishedContent.total} source content record${view.publishedContent.total === 1 ? "" : "s"}, newest first`
          }
          foot="Metrics are source-reported. A dash means the source did not report the value - never zero."
        >
          <PublishedContentTable platformLabel={copy.label} rows={view.publishedContent.rows} />
          {view.publishedContent.total > 0 && (
            <div className="actions" style={{ marginTop: 10 }}>
              <Link href={platformExplorerHref(view.platform, "content")} className="btn">
                View all in Data Explorer
              </Link>
            </div>
          )}
        </OverviewPanel>
      </OverviewRow>

      <OverviewRow secondary>
        <OverviewPanel
          span={12}
          icon="users"
          tone={2}
          title="Partner Accounts"
          note={
            view.partnerAccounts.totalAccounts === 0
              ? "No matched Partner Account snapshots for this platform in your authorized scope yet"
              : `Latest verified snapshot per Partner Account · ${view.partnerAccounts.rows.length === view.partnerAccounts.totalAccounts ? view.partnerAccounts.totalAccounts : `${view.partnerAccounts.rows.length} of ${view.partnerAccounts.totalAccounts}`} account${view.partnerAccounts.totalAccounts === 1 ? "" : "s"}`
          }
          foot="Per-account, point-in-time snapshots - not growth. No platform-wide follower figure is computed."
        >
          <PartnerAccountsTable platformLabel={copy.label} rows={view.partnerAccounts.rows} />
          {view.partnerAccounts.totalAccounts > 0 && (
            <div className="actions" style={{ marginTop: 10 }}>
              <Link href={platformExplorerHref(view.platform, "channel")} className="btn">
                View channel records in Data Explorer
              </Link>
            </div>
          )}
        </OverviewPanel>
      </OverviewRow>

      <OverviewRow secondary>
        <OverviewPanel span={12} icon="check" tone={3} title="Source Quality" note={`${copy.label} records in your authorized scope`} foot="Missing values stay unavailable; nothing is estimated to fill a gap.">
          <Checks rows={buildSourceQualityRows(view)} />
        </OverviewPanel>
      </OverviewRow>
    </>
  );
}

// ---- Native Metric Trend -----------------------------------------------------------------

function PlatformTrendPanel({ platform, trend }: { platform: PlatformAnalyticsViewDto["platform"]; trend: PlatformTrend }) {
  const copy = PLATFORM_VIEW_COPY[platform];
  const omitted = trend.omittedMetrics.map((metric) => PLATFORM_VIEW_METRIC_LABELS[metric]);
  const foot = omitted.length > 0 ? `${copy.footnote} Not plotted (source-reported in fewer than two periods): ${omitted.join(", ")}.` : copy.footnote;
  return (
    <OverviewPanel
      span={12}
      icon="chart"
      tone={0}
      title="Native Metric Trend"
      note={trend.series.length > 0 ? "Source-reported metrics by reporting period (import month where the source gave none) - a gap means nothing was reported" : "No trend available yet from source-reported data"}
      foot={foot}
    >
      {trend.series.length > 0 ? <PlatformTrendGrid trend={trend} /> : <p className="foundationnote">A trend needs a source-reported value in at least two reporting periods. Nothing is estimated in the meantime.</p>}
    </OverviewPanel>
  );
}

// TrendGrid's exact markup and class names (ov-trend-grid / ov-trend-label /
// ov-trend-value / ov-trend / ov-axis), fed with real period labels, a
// per-series scale and gapped lines.
export function PlatformTrendGrid({ trend }: { trend: PlatformTrend }) {
  const firstPeriod = trend.periods[0]!.label;
  const lastPeriod = trend.periods[trend.periods.length - 1]!.label;
  return (
    <div className="ov-trend-grid">
      {trend.series.map((series, i) => {
        const color = TONES[i % TONES.length]!.tone;
        const { segments, points } = computeTrendGeometry(series.values);
        const change = describeLatestTrendChange(series.values);
        const summary = `${series.label} by reporting period, ${points.length} of ${series.values.length} periods reported${change ? `, latest ${formatMetric(change.latest)}` : ""}`;
        return (
          <div key={series.metric}>
            <div className="ov-trend-label">
              <span className="ov-swatch" style={{ background: color, width: 7, height: 7 }} />
              {series.label}
            </div>
            <div className="ov-trend-value">
              {change ? formatMetric(change.latest) : "Unavailable"}
              {change && change.changePct !== null && (
                <small style={change.changePct < 0 ? { color: "var(--muted)" } : undefined}>
                  {change.changePct >= 0 ? "+" : ""}
                  {change.changePct.toFixed(1)}% vs previous period
                </small>
              )}
            </div>
            <div className="ov-trend">
              <svg viewBox="-4 0 272 110" role="img" aria-label={summary}>
                <path d="M0 100H260M0 55H260M0 10H260" fill="none" stroke="#e9eef5" />
                {segments.map((segment, s) =>
                  segment.length > 1 ? (
                    <g key={s}>
                      <polygon points={`${segment[0]!.x},100 ${segment.map((p) => `${p.x},${p.y}`).join(" ")} ${segment[segment.length - 1]!.x},100`} fill={color} opacity={0.09} />
                      <polyline points={segment.map((p) => `${p.x},${p.y}`).join(" ")} fill="none" stroke={color} strokeWidth={2.5} />
                    </g>
                  ) : null,
                )}
                {points.map((p, j) => (
                  <circle key={j} cx={p.x} cy={p.y} r={3.2} fill="white" stroke={color} strokeWidth={2} />
                ))}
              </svg>
              <div className="ov-axis">
                <span>{firstPeriod}</span>
                <span>{lastPeriod}</span>
              </div>
            </div>
            <ul className="sr">
              {series.values.map((value, j) => (
                <li key={trend.periods[j]!.key}>
                  {trend.periods[j]!.label}: {value === null ? "Unavailable" : formatMetric(value)}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

// ---- Published Content ---------------------------------------------------------------------

// A missing value is a dash that announces itself as "Unavailable" - never 0. (An
// `.sr` visually-hidden span is deliberately NOT used inside a scrolling table: it
// is absolutely positioned relative to the page, so it escapes the table's own
// scroll container and would widen the page at narrow viewports.)
export function UnavailableDash() {
  return (
    <span role="img" aria-label="Unavailable" title="Unavailable">
      —
    </span>
  );
}

export function MetricCell({ value }: { value: number | null }) {
  return <td>{value === null ? <UnavailableDash /> : formatMetric(value)}</td>;
}

export function PlaceholderCell({ children }: { children: ReactNode }) {
  return <span className="muted">{children}</span>;
}

// Step 12E: the Partner label links to the Partner Analytics drill-down ONLY when
// the server emitted a link (the actor may open that Partner); otherwise it is
// the same plain text as before - never a link that would be denied.
function PartnerCellLabel({ label, href }: { label: string; href: string | null }) {
  return href ? <Link href={href}>{label}</Link> : <>{label}</>;
}

function PublishedContentTable({ platformLabel, rows }: { platformLabel: string; rows: PlatformContentRowDto[] }) {
  if (rows.length === 0) return <p className="foundationnote">Imported {platformLabel} content records you are authorized to see will appear here.</p>;
  return (
    <div className="tablewrap">
      <table className="compact">
        <caption className="sr">{platformLabel} published content source records</caption>
        <thead>
          <tr>
            <th scope="col">Published</th>
            <th scope="col">Partner</th>
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
                <td>{published ?? (row.reportingPeriod ? <PlaceholderCell>{reportingPeriodLabel(row.reportingPeriod)}</PlaceholderCell> : <PlaceholderCell>Date unavailable</PlaceholderCell>)}</td>
                <td>{row.partnerLabel ? <PartnerCellLabel label={row.partnerLabel} href={row.partnerAnalyticsHref} /> : <PlaceholderCell>{row.matchState === "MATCHED" ? "Unavailable" : "Not linked"}</PlaceholderCell>}</td>
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

// ---- Partner Accounts ----------------------------------------------------------------------

function PartnerAccountsTable({ platformLabel, rows }: { platformLabel: string; rows: PlatformAccountRowDto[] }) {
  if (rows.length === 0) return <p className="foundationnote">Imported {platformLabel} channel snapshots matched to a Partner Account you are authorized to see will appear here.</p>;
  return (
    <div className="tablewrap">
      <table className="compact">
        <caption className="sr">{platformLabel} Partner Account profile-follower snapshots</caption>
        <thead>
          <tr>
            <th scope="col">Partner</th>
            <th scope="col">Account</th>
            <th scope="col">Profile followers (snapshot)</th>
            <th scope="col">Reporting period</th>
            <th scope="col">Snapshot imported</th>
            <th scope="col">Source</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              <td>{row.partnerLabel ? <PartnerCellLabel label={row.partnerLabel} href={row.partnerAnalyticsHref} /> : <PlaceholderCell>Unavailable</PlaceholderCell>}</td>
              <td>
                {row.accountLabel ?? <PlaceholderCell>Unavailable</PlaceholderCell>}
                {row.accountHandle && <small> @{row.accountHandle.replace(/^@/, "")}</small>}
              </td>
              <td>
                {row.profileFollowers === null ? <UnavailableDash /> : formatMetric(row.profileFollowers)}
                {row.snapshotCount > 1 && <small> latest of {row.snapshotCount} snapshots</small>}
              </td>
              <td>{row.reportingPeriod ? reportingPeriodLabel(row.reportingPeriod) : <PlaceholderCell>Unknown period</PlaceholderCell>}</td>
              <td>{absoluteTime(row.snapshotAt)}</td>
              <td>{row.source}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---- Source Quality ------------------------------------------------------------------------

export function linkageRow(label: string, counts: LinkageCounts): { label: string; detail: string; badge: string } {
  if (counts.total === 0) return { label, detail: "No source data yet", badge: "No data" };
  const unresolved = counts.unlinked + counts.ambiguous;
  return {
    label,
    detail: `${counts.linked} linked · ${counts.unlinked} unlinked · ${counts.ambiguous} ambiguous, of ${counts.total} record${counts.total === 1 ? "" : "s"}`,
    badge: unresolved > 0 ? "Partial" : "Current",
  };
}

// Per-metric "reported on all / missing on some / missing on all" coverage rows
// (shared by the platform views and the Partner Analytics drill-down).
export function metricCoverageRows(missingMetrics: MissingMetricEntry[]): { label: string; detail: string; badge: string }[] {
  const rows: { label: string; detail: string; badge: string }[] = [];
  for (const entry of missingMetrics) {
    const kindLabel = entry.kind === "content" ? "content" : "channel";
    if (entry.total === 0) {
      rows.push({ label: `${entry.label} coverage`, detail: `No source ${kindLabel} records yet`, badge: "No data" });
      continue;
    }
    const records = `${kindLabel} record${entry.total === 1 ? "" : "s"}`;
    if (entry.missing === 0) rows.push({ label: `${entry.label} coverage`, detail: `${entry.label} reported on all ${entry.total} ${records}`, badge: "Current" });
    else if (entry.missing === entry.total) rows.push({ label: `${entry.label} coverage`, detail: `${entry.label} missing on all ${entry.total} ${records}`, badge: "Review" });
    else rows.push({ label: `${entry.label} coverage`, detail: `${entry.label} missing on ${entry.missing} of ${entry.total} ${records}`, badge: "Partial" });
  }
  return rows;
}

function buildSourceQualityRows(view: PlatformAnalyticsViewDto): { label: string; detail: string; badge: string }[] {
  const { sourceQuality } = view;
  const rows = [linkageRow("Content linkage", sourceQuality.content), linkageRow("Channel linkage", sourceQuality.channel), ...metricCoverageRows(sourceQuality.missingMetrics)];

  const { latestContentAt, latestChannelAt } = sourceQuality.freshness;
  rows.push({ label: "Content freshness", detail: latestContentAt ? `Latest record ${absoluteTime(latestContentAt)}` : "No source data yet", badge: computeFreshnessBadge(latestContentAt) });
  rows.push({ label: "Channel freshness", detail: latestChannelAt ? `Latest record ${absoluteTime(latestChannelAt)}` : "No source data yet", badge: computeFreshnessBadge(latestChannelAt) });
  return rows;
}
