// Step 12F: the presentational Partners Analytics workspace (/analytics/partners).
//
// The golden master (docs/reference/CreatorOps_UI_Golden_Master.html) models ONLY
// the combined Analytics Overview (its `.tabsbar > .tabs > .tab` row, the
// `.segment` toggle, the `.pill` chips and the panel/table foundation) - there is
// no Partner selector, comparison or month view in it - so this is a NEW
// composition built exclusively from accepted foundation pieces: the Overview's
// `ov-page` wrapper (via AnalyticsPageShell), ContextBanner, OverviewRow /
// OverviewPanel, the Explorer's own `panel` + `toolbar` + `panelfoot` strip, the
// Explorer/12D/12E `tablewrap` + `compact` table, Pill, the
// `.segment` group of `.btn` links (12E's platform switch), `.btn`, the existing
// TargetAudience / Region multi-selects and `PlatformTrendGrid` (through the
// embedded 12E Partner view). No new CSS class is introduced.
import Link from "next/link";

import { Pill } from "@/ui/Badge";
import { ContextBanner, OverviewPanel, OverviewRow } from "@/ui/Overview";
import { EmptyState } from "@/ui/States";
import { absoluteTime } from "@/features/administration/format";
import type { PartnersWorkspaceDto, WorkspaceMetricSwitchItem } from "@/server/analytics/partners-workspace-dto";
import type { ComparisonMetricCell, ComparisonRowDto, TrendMatrixDto } from "@/server/analytics/partners-workspace-metrics";
import type { PartnerPlatformSwitchItem } from "@/server/analytics/partner-view-dto";

import { AnalyticsPartnerView } from "./AnalyticsPartnerView";
import { UnavailableDash } from "./AnalyticsPlatformView";
import { formatMetric, reportingPeriodLabel } from "./format";
import { MonthSelect, PartnerSelectorPanel } from "./PartnersWorkspaceControls";
import { formatPublishedDate } from "./platform-view-helpers";

export function AnalyticsPartnersWorkspace({ view }: { view: PartnersWorkspaceDto }) {
  const { selector, month, coverage } = view;
  const chips = ["Authorized scope preview"];
  if (coverage.truncatedNote) chips.push("Bounded read window");

  return (
    <>
      <OverviewRow>
        <OverviewPanel
          span={12}
          icon="users"
          tone={2}
          title="Choose Partners"
          note="Target Audience and region filters, then search and select one Partner (full monthly view) or several (side-by-side comparison)"
          foot="Selection is limited to Partners inside your authorized scope. Filters only narrow the search - nothing here changes or infers Analytics data."
        >
          <PartnerSelectorPanel selected={selector.selected} limit={selector.limit} state={selector.state} />
        </OverviewPanel>
      </OverviewRow>

      {view.notices.map((notice) => (
        <div key={notice} className="banner" role="status" style={{ marginBottom: 8 }}>
          {notice}
        </div>
      ))}

      {/* The month + platform controls are one compact strip (the Explorer's own `panel` + `toolbar` + `panelfoot` foundation pieces), not a tall panel. */}
      <section className="panel" style={{ marginBottom: 8 }}>
        <div className="toolbar" style={{ gap: 16 }}>
          <MonthSelect month={month} state={selector.state} />
          <PlatformSwitch items={view.links.platformSwitch} />
          {view.links.openFullPartnerHref && (
            <Link href={view.links.openFullPartnerHref} className="btn primary">
              Open full Partner Analytics
            </Link>
          )}
        </div>
        <div className="panelfoot">
          <span>The month follows the latest imported reporting month with data until you choose one - your choice is never changed for you. A month is drawn only from records whose reporting period lies entirely within it; records without a usable single-month period are never forced into a month.</span>
        </div>
      </section>

      <ContextBanner
        icon="chart"
        title={month.label ? `${month.label} · ${month.sourceLabel}` : "No reporting month with data yet"}
        description={coverage.text ?? (view.mode === "empty" ? "Select one or more Partners to see their source-reported Analytics for this month." : "No reporting month with data yet.")}
        chips={chips}
      />
      {coverage.truncatedNote && (
        <p className="foundationnote" style={{ margin: "0 0 8px" }}>
          {coverage.truncatedNote}
        </p>
      )}
      {coverage.exclusionNote && (
        <p className="foundationnote" style={{ margin: "0 0 8px" }}>
          {coverage.exclusionNote}
        </p>
      )}

      {view.mode === "empty" && (
        <section className="panel">
          <div className="panelbody">
            <EmptyState title="Select Partners to see Analytics" description="Search for a Partner above. One Partner opens its full month view; two or more open a side-by-side comparison. Nothing is shown for Partners outside your authorized scope." icon="users" />
          </div>
        </section>
      )}

      {view.mode === "single" && view.single && <AnalyticsPartnerView view={view.single} embedded />}

      {view.mode === "comparison" && view.comparison && (
        <>
          <OverviewRow>
            <OverviewPanel
              span={12}
              icon="table"
              tone={1}
              title="Partner comparison"
              note={month.label ? `${month.label} · one row per selected Partner, each from its own source records` : "No reporting month with data yet"}
              foot="No overall score, blended ranking or cross-Partner total exists. A dash means the source did not report the value - never zero. Instagram and YouTube Views are native counts and are never combined."
            >
              <ComparisonTable table={view.comparison.table} monthLabel={month.label} />
            </OverviewPanel>
          </OverviewRow>

          <OverviewRow>
            <OverviewPanel span={12} icon="chart" tone={4} title={`Monthly trend · ${view.comparison.metricLabel}`} note={view.comparison.matrixNote} foot="Gaps stay gaps: a month without a source-reported value is a dash, never zero and never interpolated.">
              {view.links.metricSwitch && <MetricSwitch items={view.links.metricSwitch} />}
              {view.comparison.matrices.map((matrix) => (
                <TrendMatrix key={matrix.title} matrix={matrix} />
              ))}
            </OverviewPanel>
          </OverviewRow>
        </>
      )}
    </>
  );
}

// ---- Platform switch (real links; the platform filter is applied by the server) --------------------------

function PlatformSwitch({ items }: { items: PartnerPlatformSwitchItem[] }) {
  return (
    <div className="actions">
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

function MetricSwitch({ items }: { items: WorkspaceMetricSwitchItem[] }) {
  return (
    <div className="actions" style={{ marginBottom: 10 }}>
      <span className="foundationnote">Trend metric</span>
      <div className="segment" role="group" aria-label="Trend metric" style={{ marginLeft: 0 }}>
        {items.map((item) => (
          <Link key={item.metric} href={item.href} className={item.active ? "btn primary" : "btn ghost"} aria-current={item.active ? "page" : undefined}>
            {item.label}
          </Link>
        ))}
      </div>
    </div>
  );
}

// ---- Comparison table -------------------------------------------------------------------------------------

function MetricValueCell({ cell, label }: { cell: ComparisonMetricCell | null; label: string }) {
  if (cell === null || cell.total === null) return <td>{<UnavailableDash />}</td>;
  const partial = cell.recordsWithValue < cell.recordsTotal;
  return (
    <td title={`${label}: source-reported on ${cell.recordsWithValue} of ${cell.recordsTotal} record${cell.recordsTotal === 1 ? "" : "s"}`}>
      {formatMetric(cell.total)}
      {partial && (
        <small className="muted">
          {" "}
          {cell.recordsWithValue} of {cell.recordsTotal}
        </small>
      )}
    </td>
  );
}

function CoverageCell({ row }: { row: ComparisonRowDto }) {
  const tone = row.coverage.state === "no_data" ? "gray" : row.coverage.state === "channel_only" ? "orange" : "default";
  return (
    <td>
      <Pill tone={tone}>{row.coverage.label}</Pill>
      <small className="muted"> {row.coverage.state === "no_data" ? "no data this month" : `${row.coverage.contentRecords} content · ${row.coverage.channelRecords} channel`}</small>
      {row.coverage.truncated && <small className="muted"> · bounded window</small>}
    </td>
  );
}

function SnapshotCell({ row }: { row: ComparisonRowDto }) {
  const snapshot = row.latestSnapshot;
  if (!snapshot) return <td>{<UnavailableDash />}</td>;
  return (
    <td>
      {formatPublishedDate(snapshot.importedAt) ?? absoluteTime(snapshot.importedAt)}
      <small className="muted"> · {reportingPeriodLabel(snapshot.reportingPeriod)}</small>
    </td>
  );
}

function ComparisonTable({ table, monthLabel }: { table: NonNullable<PartnersWorkspaceDto["comparison"]>["table"]; monthLabel: string | null }) {
  return (
    <div className="tablewrap">
      <table className="compact" aria-label={`Partner comparison${monthLabel ? ` for ${monthLabel}` : ""}`}>
        <thead>
          <tr>
            <th scope="col">Partner</th>
            <th scope="col">Coverage</th>
            <th scope="col">Published content</th>
            {table.viewsPlatforms.includes("instagram") && <th scope="col">Instagram Views</th>}
            {table.viewsPlatforms.includes("youtube") && <th scope="col">YouTube Views</th>}
            <th scope="col">Engagement</th>
            <th scope="col">Likes</th>
            <th scope="col">Comments</th>
            <th scope="col">Latest channel snapshot</th>
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, index) => (
            <tr key={index}>
              <td>
                <Link href={row.analyticsHref}>{row.displayName}</Link>
              </td>
              <CoverageCell row={row} />
              <td>{row.publishedContent === null ? <UnavailableDash /> : row.publishedContent}</td>
              {table.viewsPlatforms.includes("instagram") && <MetricValueCell cell={row.instagramViews} label="Instagram Views" />}
              {table.viewsPlatforms.includes("youtube") && <MetricValueCell cell={row.youtubeViews} label="YouTube Views" />}
              <MetricValueCell cell={row.engagement} label="Engagement" />
              <MetricValueCell cell={row.likes} label="Likes" />
              <MetricValueCell cell={row.comments} label="Comments" />
              <SnapshotCell row={row} />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---- Monthly matrix -----------------------------------------------------------------------------------------

function TrendMatrix({ matrix }: { matrix: TrendMatrixDto }) {
  if (matrix.months.length === 0) return <p className="foundationnote">No reporting month with data yet. Nothing is estimated in the meantime.</p>;
  return (
    <div style={{ marginBottom: 12 }}>
      <p className="foundationnote" style={{ margin: "0 0 6px" }}>
        <b>{matrix.title}</b>
      </p>
      <div className="tablewrap">
        <table className="compact" aria-label={`${matrix.title} by month and Partner`}>
          <thead>
            <tr>
              <th scope="col">Month</th>
              {matrix.partners.map((partner, index) => (
                <th key={index} scope="col">
                  {partner.displayName}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {matrix.months.map((month, monthIndex) => (
              <tr key={month.month}>
                <th scope="row">{month.label}</th>
                {matrix.cells[monthIndex]!.map((value, partnerIndex) => (
                  <td key={partnerIndex}>{value === null ? <UnavailableDash /> : formatMetric(value)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
