"use client";

// Step 13B: the Partner-wise monthly productivity history. The golden master models NO Partner-wise
// longitudinal page (its Partner Reviews entry has only the Overview, the Workspace records and a generic
// record Detail), so this is a NEW composition built exclusively from accepted foundation pieces: the
// Detail header + `.detailcontext` strip, the local `.workflow role=tablist` strip, `.grid` panels, the
// accepted `tablewrap` + `compact` tables, `.pill`, `.segment`-free links/buttons and the 12D
// PlatformTrendGrid. No new CSS class. It reads ONLY the bounded history DTO: no per-month detail, no
// freshness recomputation - full evidence opens on the monthly review.
import { useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { Panel, PanelBody, PanelGrid, PanelHead } from "@/ui/Panel";
import { Pill } from "@/ui/Badge";
import type { PartnerHistoryDto } from "@/server/partner-reviews/partner-review-history-service";
import type { PartnerHistoryMonthRowDto } from "@/server/partner-reviews/partner-history-model";
import { HISTORY_TABS, HISTORY_TAB_LABELS, monthLabel, partnerHistoryHref, reviewHref, workspaceHref, type HistoryTab } from "@/server/partner-reviews/ui-params";

import { generateReview } from "./api-client";
import { COMMERCIAL_EVIDENCE_LABEL, dateOnly, DISABLED_BUTTON_STYLE, formatCount, FRESHNESS_LABELS, freshnessTone, LIFECYCLE_LABELS, lifecycleTone, platformLabel, TARGET_MONITORING_LABEL } from "./format";
import { buildPlatformTrend, HISTORY_METRIC_LABELS, HISTORY_METRICS, platformsInHistory } from "./history-view-model";
import { ReviewMonthSelect } from "./ReviewMonthSelect";

const EVALUATION_LABELS: Record<string, string> = { met: "Met", below_requirement: "Below requirement", exceeded: "Exceeded", unavailable: "Unavailable" };

function Dash() {
  return (
    <span role="img" aria-label="Unavailable" title="Unavailable">
      —
    </span>
  );
}

function Num({ value }: { value: number | null | undefined }) {
  return value === null || value === undefined ? <Dash /> : <>{value.toLocaleString("en-GB")}</>;
}

// The whole-row state for a month that has no review: "Needs review" (in-period Assignments exist) or
// "No review" - never a zero and never a fabricated value.
function StateCells({ row, colSpan }: { row: PartnerHistoryMonthRowDto; colSpan: number }) {
  return (
    <td colSpan={colSpan}>
      {row.state === "needs_review" ? (
        <>
          <Pill tone="orange">Needs review</Pill> <small>{row.row?.assignmentsFound} Assignment{row.row?.assignmentsFound === 1 ? "" : "s"} found · no review yet</small>
        </>
      ) : (
        <>
          <Pill tone="gray">No review</Pill> <small>No in-period Assignments found</small>
        </>
      )}
    </td>
  );
}

// `trendCharts` are the accepted 12D PlatformTrendGrid charts, RENDERED ON THE SERVER by PartnerHistoryPage (that
// component lives in a server-side Analytics module) and handed over as ready-made elements, one per platform
// (null when a platform has fewer than two months of a metric to plot). They are never combined across platforms.
export function PartnerHistoryView({ view, initialTab, until, trendCharts }: { view: PartnerHistoryDto; initialTab: HistoryTab; until: string | null; trendCharts: Record<string, ReactNode> }) {
  const router = useRouter();
  const [tab, setTab] = useState<HistoryTab>(initialTab);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generated, setGenerated] = useState<{ reviewRef: string; outcome: "created" | "existing" } | null>(null);

  const { partner, selected, rows, window: historyWindow, permissions, freshnessSummary, disclosure } = view;
  const selectedRow = selected?.row ?? null;
  const reviewRef = generated?.reviewRef ?? (selected?.state === "review" ? selectedRow?.reviewRef ?? null : null);

  function selectTab(next: HistoryTab) {
    setTab(next);
    const url = new URL(window.location.href);
    if (next === "trend") url.searchParams.delete("tab");
    else url.searchParams.set("tab", next);
    window.history.replaceState(window.history.state, "", url);
  }

  async function onGenerate() {
    if (!selected || busy) return;
    setBusy(true);
    setError(null);
    const result = await generateReview({ partnerRef: partner.partnerRef, periodKey: selected.periodKey });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setGenerated({ reviewRef: result.data.head.reviewRef, outcome: result.status === 201 ? "created" : "existing" });
    // Re-read the bounded history so the tables show the new Draft (a soft server refresh; no duplicate state).
    router.refresh();
  }

  const monthOptions = historyWindow
    ? historyWindow.months.map((month) => ({ month, label: monthLabel(month), href: partnerHistoryHref(partner.partnerRef, { month, tab, until }) }))
    : selected
      ? [{ month: selected.periodKey, label: selected.label, href: partnerHistoryHref(partner.partnerRef, { month: selected.periodKey, tab }) }]
      : [];
  if (selected && !monthOptions.some((option) => option.month === selected.periodKey)) monthOptions.unshift({ month: selected.periodKey, label: selected.label, href: partnerHistoryHref(partner.partnerRef, { month: selected.periodKey, tab, until }) });

  const sourceLabel = view.month.source === "explicit" ? "Selected month" : view.month.source === "latest_review" ? "Latest review month" : view.month.source === "latest_candidate" ? "Latest month with Assignments" : "No review months yet";
  const platforms = platformsInHistory(rows);

  return (
    <>
      <div className="head">
        <div>
          <div className="eyebrow">PARTNER REVIEWS / PARTNER HISTORY</div>
          <h1>{partner.displayName}</h1>
          <p>Monthly productivity history</p>
        </div>
        <div className="actions">
          <Link href={workspaceHref({ month: selected?.periodKey ?? undefined, partnerRef: partner.partnerRef })} className="btn">
            Back to workspace
          </Link>
        </div>
      </div>

      <div className="detailcontext">
        <div>
          <small>Partner</small>
          <b>{partner.displayName}</b>
          <small style={{ marginTop: 4 }}>{partner.regions.length > 0 ? partner.regions.join(", ") : "No region recorded"}</small>
        </div>
        <div>
          <small>Latest review month</small>
          <b>{view.latestReviewMonth ? monthLabel(view.latestReviewMonth) : "No review yet"}</b>
        </div>
        <div>
          <small>Selected month</small>
          <b>{selected ? selected.label : "None"}</b>
          <small style={{ marginTop: 4 }}>{sourceLabel}</small>
        </div>
        <div>
          <small>Evidence freshness</small>
          <b>
            {freshnessSummary.reviews === 0 ? "No reviews in this window" : `${freshnessSummary.reviews} review${freshnessSummary.reviews === 1 ? "" : "s"} · ${freshnessSummary.behindUpstream} behind upstream`}
          </b>
          <small style={{ marginTop: 4 }}>{freshnessSummary.notRecorded > 0 ? `${freshnessSummary.notRecorded} not yet checked · ` : ""}as of the last recorded check</small>
        </div>
      </div>

      <section className="panel" style={{ marginBottom: 18 }} aria-label="Selected month">
        <div className="panelbody">
          <div className="actions" style={{ alignItems: "center", justifyContent: "space-between" }}>
            <ReviewMonthSelect options={monthOptions} value={selected?.periodKey ?? null} sourceLabel={sourceLabel} latestHref={view.month.source === "explicit" ? partnerHistoryHref(partner.partnerRef, { tab }) : null} />
            <div className="actions">
              {reviewRef ? (
                <Link className="btn primary" href={reviewHref(reviewRef)}>
                  Open monthly review
                </Link>
              ) : selected && permissions.canGenerate ? (
                <button type="button" className="btn primary" disabled={busy} style={busy ? DISABLED_BUTTON_STYLE : undefined} onClick={() => void onGenerate()}>
                  {busy ? "Generating…" : "Generate Review"}
                </button>
              ) : null}
            </div>
          </div>
          <p className="foundationnote" style={{ margin: "8px 0 0" }} role="status">
            {!selected
              ? "No review month exists for this Partner yet."
              : generated
                ? generated.outcome === "created"
                  ? `Draft review generated for ${selected.label}.`
                  : `A review already existed for ${selected.label}.`
                : selected.state === "review" && selectedRow
                  ? `${selected.label} · version ${selectedRow.version} · ${LIFECYCLE_LABELS[selectedRow.lifecycle]}${selected.revised ? ` · revised ${selectedRow.revisionCount} time${selectedRow.revisionCount === 1 ? "" : "s"}` : ""}`
                  : selected.state === "needs_review"
                    ? `${selected.label} has ${selectedRow?.assignmentsFound} in-period Assignment${selectedRow?.assignmentsFound === 1 ? "" : "s"} and no review yet.`
                    : `${selected.label} has no review and no in-period Assignments were found in the bounded read.`}
            {!reviewRef && selected && !permissions.canGenerate && " You have read-only access."}
          </p>
          {error && (
            <div className="banner" role="alert" style={{ marginTop: 8 }}>
              {error}
            </div>
          )}
        </div>
      </section>

      <div className="workflow" role="tablist" aria-label="Partner history sections">
        {HISTORY_TABS.map((key) => {
          const isCurrent = key === tab;
          return (
            <button key={key} type="button" role="tab" aria-selected={isCurrent} className={`step ${isCurrent ? "current" : ""}`} onClick={() => selectTab(key)}>
              {HISTORY_TAB_LABELS[key]}
            </button>
          );
        })}
      </div>

      {view.month.invalidRequested && (
        <div className="banner" role="status" style={{ marginBottom: 12 }}>
          The requested month is not a valid YYYY-MM month, so the default month is shown.
        </div>
      )}

      {rows.length === 0 ? (
        <PanelGrid>
          <Panel span={12}>
            <PanelBody>
              <p className="foundationnote">No review or in-period Assignment was found for this Partner yet, so there is no monthly history to show.</p>
            </PanelBody>
          </Panel>
        </PanelGrid>
      ) : (
        <>
          {tab === "trend" && <TrendSection rows={rows} />}
          {tab === "production" && <ProductionHistory rows={rows} />}
          {tab === "compliance" && <ComplianceHistory rows={rows} />}
          {tab === "performance" && <PerformanceHistory rows={rows} platforms={platforms} trendCharts={trendCharts} />}
          {tab === "commercial" && <CommercialHistory rows={rows} />}
          {tab === "history" && <ReviewHistory rows={rows} partnerRef={partner.partnerRef} />}

          <p className="foundationnote" style={{ margin: "4px 0 0" }}>
            Showing {historyWindow?.months.length} calendar months, {historyWindow ? `${monthLabel(historyWindow.start)} to ${monthLabel(historyWindow.end)}` : ""}, newest first. Months with no review read &ldquo;No review&rdquo; or &ldquo;Needs review&rdquo; - never zero. Months without a review are derived from the {disclosure.assignmentsScanned} most recent Assignment{disclosure.assignmentsScanned === 1 ? "" : "s"} found{disclosure.assignmentScanTruncated ? " (the bounded read stopped early)" : ""}. Freshness is as of the last recorded check, never live.
          </p>
          <div className="actions" style={{ margin: "8px 0 0" }}>
            {historyWindow?.hasOlder && historyWindow.olderUntil && (
              <Link className="btn" href={partnerHistoryHref(partner.partnerRef, { until: historyWindow.olderUntil, tab })}>
                Show older months
              </Link>
            )}
            {until && (
              <Link className="btn ghost" href={partnerHistoryHref(partner.partnerRef, { tab })}>
                Back to the latest months
              </Link>
            )}
          </div>
        </>
      )}
    </>
  );
}

// ---- A. Monthly Trend -------------------------------------------------------------------------------------------------
function TrendSection({ rows }: { rows: PartnerHistoryMonthRowDto[] }) {
  return (
    <PanelGrid>
      <Panel span={12}>
        <PanelHead title="Monthly Trend" description="One row per month · each fact stays separate · there is no overall score or blended line" />
        <PanelBody>
          <div className="tablewrap">
            <table className="compact">
              <caption className="sr">Monthly trend by review month</caption>
              <thead>
                <tr>
                  <th scope="col">Month</th>
                  <th scope="col">Lifecycle</th>
                  <th scope="col">Qualifying content</th>
                  <th scope="col">Required</th>
                  <th scope="col">On time · late</th>
                  <th scope="col">Evidence freshness</th>
                  <th scope="col">Target warnings</th>
                  <th scope="col">Version</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const r = row.row;
                  const summary = r?.summary ?? null;
                  return (
                    <tr key={row.periodKey}>
                      <td>{row.label}</td>
                      {row.state !== "review" || !r ? (
                        <StateCells row={row} colSpan={7} />
                      ) : (
                        <>
                          <td>
                            <Pill tone={lifecycleTone(r.lifecycle)}>{LIFECYCLE_LABELS[r.lifecycle]}</Pill>
                          </td>
                          <td>{summary ? <Num value={summary.commercial.deliverable.actual ?? summary.production.approvedContent} /> : <Dash />}</td>
                          <td>{summary?.commercial.deliverable.required != null ? summary.commercial.deliverable.required : <Dash />}</td>
                          <td>{summary ? `${summary.compliance.onTime} · ${summary.compliance.late}` : <Dash />}</td>
                          <td>
                            {r.freshnessHint ? (
                              <>
                                <Pill tone={freshnessTone(r.freshnessHint.state)}>{FRESHNESS_LABELS[r.freshnessHint.state]}</Pill>
                                <small style={{ display: "block" }}>as of {dateOnly(r.freshnessHint.checkedAt)}</small>
                              </>
                            ) : (
                              <span className="foundationnote">Not yet recorded</span>
                            )}
                          </td>
                          <td>{summary && summary.commercial.targets.total > 0 ? `${summary.commercial.targets.met} met · ${summary.commercial.targets.notMet} not met · ${summary.commercial.targets.unavailable} unavailable` : <Dash />}</td>
                          <td>
                            v{r.version}
                            {r.currentFinalizedVersion !== null && r.currentFinalizedVersion !== r.version && <small style={{ display: "block" }}>finalized v{r.currentFinalizedVersion}</small>}
                            {row.revised && <small style={{ display: "block" }}>revised</small>}
                          </td>
                        </>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="foundationnote" style={{ margin: "8px 0 0" }}>
            Qualifying content is the Agreement-counted actual where one applies, otherwise the provable approved Content. Required is shown only where an Agreement supplies it. {TARGET_MONITORING_LABEL}.
          </p>
        </PanelBody>
      </Panel>
    </PanelGrid>
  );
}

// ---- B. Production -----------------------------------------------------------------------------------------------------
function ProductionHistory({ rows }: { rows: PartnerHistoryMonthRowDto[] }) {
  return (
    <PanelGrid>
      <Panel span={12}>
        <PanelHead title="Production by month" description="Required qualifying content only where an Agreement supplies it · never inferred" />
        <PanelBody>
          <div className="tablewrap">
            <table className="compact">
              <caption className="sr">Production history by month</caption>
              <thead>
                <tr>
                  <th scope="col">Month</th>
                  <th scope="col">Required</th>
                  <th scope="col">Actual qualifying</th>
                  <th scope="col">Completed assignments</th>
                  <th scope="col">Approved Content</th>
                  <th scope="col">Under review</th>
                  <th scope="col">LFC / SFC</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const s = row.row?.summary ?? null;
                  return (
                    <tr key={row.periodKey}>
                      <td>{row.label}</td>
                      {row.state !== "review" || !s ? (
                        <StateCells row={row} colSpan={6} />
                      ) : (
                        <>
                          <td>{s.commercial.deliverable.required === null ? <Dash /> : s.commercial.deliverable.required}</td>
                          <td>
                            <Num value={s.commercial.deliverable.actual} />
                          </td>
                          <td>{s.production.completedAssignments}</td>
                          <td>{s.production.approvedContent}</td>
                          <td>{s.production.underReviewContent}</td>
                          <td>{s.commercial.lfcSfc.status === "evaluated" ? `LFC ${formatCount(s.commercial.lfcSfc.lfc)} · SFC ${formatCount(s.commercial.lfcSfc.sfc)}` : <Dash />}</td>
                        </>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </PanelBody>
      </Panel>
    </PanelGrid>
  );
}

// ---- C. Compliance -----------------------------------------------------------------------------------------------------
function ComplianceHistory({ rows }: { rows: PartnerHistoryMonthRowDto[] }) {
  return (
    <PanelGrid>
      <Panel span={12}>
        <PanelHead title="Compliance by month" description="No compliance score · unknown timing is never counted as late" />
        <PanelBody>
          <div className="tablewrap">
            <table className="compact">
              <caption className="sr">Compliance history by month</caption>
              <thead>
                <tr>
                  <th scope="col">Month</th>
                  <th scope="col">On time</th>
                  <th scope="col">Late</th>
                  <th scope="col">Unknown timing</th>
                  <th scope="col">Revision requests</th>
                  <th scope="col">Missing / incomplete work</th>
                  <th scope="col">Evidence</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const s = row.row?.summary ?? null;
                  return (
                    <tr key={row.periodKey}>
                      <td>{row.label}</td>
                      {row.state !== "review" || !s ? (
                        <StateCells row={row} colSpan={6} />
                      ) : (
                        <>
                          <td>{s.compliance.onTime}</td>
                          <td>{s.compliance.late}</td>
                          <td>{s.compliance.unknownTiming}</td>
                          <td>{s.compliance.revisionRequests}</td>
                          <td>{s.compliance.missingOrIncompleteWork}</td>
                          <td>{s.completeness.incompleteReasonCount > 0 ? "Incomplete" : "Complete"}</td>
                        </>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </PanelBody>
      </Panel>
    </PanelGrid>
  );
}

// ---- D. Performance (native platform separation) ---------------------------------------------------------------------------
function PerformanceHistory({ rows, platforms, trendCharts }: { rows: PartnerHistoryMonthRowDto[]; platforms: string[]; trendCharts: Record<string, ReactNode> }) {
  return (
    <>
      {platforms.length === 0 && (
        <PanelGrid>
          <Panel span={12}>
            <PanelHead title="Performance by month" description="Verified Analytics-backed facts only · Instagram and YouTube are never combined" />
            <PanelBody>
              <p className="foundationnote">
                <b>Unavailable</b> - no verified Analytics evidence is matched to this Partner in these months. Missing is not zero and not a failure. Reach is unavailable unless a verified source supplies it.
              </p>
            </PanelBody>
          </Panel>
        </PanelGrid>
      )}
      {platforms.map((platform) => {
        const trend = buildPlatformTrend(rows, platform);
        return (
          <PanelGrid key={platform}>
            <Panel span={12}>
              <PanelHead title={`${platformLabel(platform)} performance`} description="Native platform measures by month · a gap means nothing was reported" />
              <PanelBody>
                {trend.series.length > 0 && trendCharts[platform] ? trendCharts[platform] : <p className="foundationnote">A trend needs a source-reported value in at least two months. The month table below carries every value.</p>}
                {trend.omittedMetrics.length > 0 && <p className="foundationnote">Not plotted (reported in only one month): {trend.omittedMetrics.map((metric) => HISTORY_METRIC_LABELS[metric]).join(", ")}.</p>}
                <div className="tablewrap" style={{ marginTop: 10 }}>
                  <table className="compact">
                    <caption className="sr">{platformLabel(platform)} performance by month</caption>
                    <thead>
                      <tr>
                        <th scope="col">Month</th>
                        {HISTORY_METRICS.map((metric) => (
                          <th key={metric} scope="col">
                            {HISTORY_METRIC_LABELS[metric]}
                          </th>
                        ))}
                        <th scope="col">Follower snapshots</th>
                        <th scope="col">Targets</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row) => {
                        const s = row.row?.summary ?? null;
                        const metrics = s?.performance.perPlatform[platform] ?? null;
                        return (
                          <tr key={row.periodKey}>
                            <td>{row.label}</td>
                            {row.state !== "review" || !s ? (
                              <StateCells row={row} colSpan={HISTORY_METRICS.length + 2} />
                            ) : (
                              <>
                                {HISTORY_METRICS.map((metric) => (
                                  <td key={metric}>
                                    <Num value={metrics ? metrics[metric] : null} />
                                  </td>
                                ))}
                                <td>{s.performance.followerSnapshotRecords > 0 ? `${s.performance.followerSnapshotRecords} snapshot${s.performance.followerSnapshotRecords === 1 ? "" : "s"} · ${s.performance.followerSnapshotAccounts} account${s.performance.followerSnapshotAccounts === 1 ? "" : "s"}` : <Dash />}</td>
                                <td>{s.commercial.targets.total > 0 ? `${s.commercial.targets.met} met · ${s.commercial.targets.notMet} not met · ${s.commercial.targets.unavailable} unavailable` : <Dash />}</td>
                              </>
                            )}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </PanelBody>
            </Panel>
          </PanelGrid>
        );
      })}
      {platforms.length > 0 && (
        <p className="foundationnote" style={{ margin: "0 0 8px" }}>
          Engagement is source-reported only. Follower snapshots are counted per month and account - never summed across accounts, and one snapshot is not growth. Reach is unavailable unless a verified source supplies it.
        </p>
      )}
    </>
  );
}

// ---- E. Commercial Evidence ------------------------------------------------------------------------------------------------
function CommercialHistory({ rows }: { rows: PartnerHistoryMonthRowDto[] }) {
  return (
    <PanelGrid>
      <Panel span={12}>
        <PanelHead title="Commercial evidence by month" description="Evidence supplied by the governing Agreement · no money is calculated · revised months keep their earlier versions" />
        <PanelBody>
          <div className="tablewrap">
            <table className="compact">
              <caption className="sr">Commercial evidence history by month</caption>
              <thead>
                <tr>
                  <th scope="col">Month</th>
                  <th scope="col">Governing Agreement</th>
                  <th scope="col">Required vs actual</th>
                  <th scope="col">Evaluation</th>
                  <th scope="col">LFC / SFC</th>
                  <th scope="col">Warning-only targets</th>
                  <th scope="col">Revision</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const s = row.row?.summary ?? null;
                  return (
                    <tr key={row.periodKey}>
                      <td>{row.label}</td>
                      {row.state !== "review" || !s || !row.row ? (
                        <StateCells row={row} colSpan={6} />
                      ) : (
                        <>
                          <td>{s.commercial.governing ? `${s.commercial.governing.ref} · version ${s.commercial.governing.version}` : <span>Unavailable · none governs</span>}</td>
                          <td>
                            {s.commercial.deliverable.required === null ? <span>Required: Unavailable</span> : <span>Required {s.commercial.deliverable.required}</span>}
                            <small style={{ display: "block" }}>Actual: {formatCount(s.commercial.deliverable.actual)}</small>
                          </td>
                          <td>
                            {EVALUATION_LABELS[s.commercial.deliverable.evaluation]}
                            {s.commercial.deliverable.variance !== null && ` (${s.commercial.deliverable.variance > 0 ? "+" : ""}${s.commercial.deliverable.variance})`}
                            {(s.commercial.deliverable.affectsPayment || s.commercial.lfcSfc.affectsPayment) && <small style={{ display: "block" }}>{COMMERCIAL_EVIDENCE_LABEL}</small>}
                          </td>
                          <td>{s.commercial.lfcSfc.status === "evaluated" ? `LFC ${formatCount(s.commercial.lfcSfc.lfc)} · SFC ${formatCount(s.commercial.lfcSfc.sfc)} · Unclassified ${formatCount(s.commercial.lfcSfc.unclassified)}` : <span>Unavailable</span>}</td>
                          <td>
                            {s.commercial.targets.total > 0 ? (
                              <>
                                {s.commercial.targets.met} met · {s.commercial.targets.notMet} not met · {s.commercial.targets.unavailable} unavailable
                                <small style={{ display: "block" }}>{TARGET_MONITORING_LABEL}</small>
                              </>
                            ) : (
                              <Dash />
                            )}
                          </td>
                          <td>
                            {row.revised ? (
                              <>
                                Revised · {row.row.revisionCount} revision{row.row.revisionCount === 1 ? "" : "s"}
                                <small style={{ display: "block" }}>Earlier versions are preserved - open the review&rsquo;s Version History</small>
                              </>
                            ) : (
                              <span>Original version</span>
                            )}
                          </td>
                        </>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </PanelBody>
      </Panel>
    </PanelGrid>
  );
}

// ---- F. Review History -------------------------------------------------------------------------------------------------------
function ReviewHistory({ rows, partnerRef }: { rows: PartnerHistoryMonthRowDto[]; partnerRef: string }) {
  return (
    <PanelGrid>
      <Panel span={12}>
        <PanelHead title="Review History" description="The Partner's monthly reviews across time, newest first" />
        <PanelBody>
          <div className="tablewrap">
            <table className="compact">
              <caption className="sr">Review history by month</caption>
              <thead>
                <tr>
                  <th scope="col">Month</th>
                  <th scope="col">Current version</th>
                  <th scope="col">Lifecycle</th>
                  <th scope="col">Freshness</th>
                  <th scope="col">Finalized</th>
                  <th scope="col">Revisions</th>
                  <th scope="col">Commercial evidence</th>
                  <th scope="col">Warning-only targets</th>
                  <th scope="col">
                    <span className="sr">Action</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const r = row.row;
                  const s = r?.summary ?? null;
                  if (row.state !== "review" || !r) {
                    return (
                      <tr key={row.periodKey}>
                        <td>{row.label}</td>
                        <StateCells row={row} colSpan={7} />
                        <td>
                          <Link className="btn" href={partnerHistoryHref(partnerRef, { month: row.periodKey, tab: "history" })} aria-label={`Select ${row.label}`}>
                            Select month
                          </Link>
                        </td>
                      </tr>
                    );
                  }
                  return (
                    <tr key={row.periodKey}>
                      <td>{row.label}</td>
                      <td>Version {r.version}</td>
                      <td>
                        <Pill tone={lifecycleTone(r.lifecycle)}>{LIFECYCLE_LABELS[r.lifecycle]}</Pill>
                      </td>
                      <td>
                        {r.freshnessHint ? (
                          <>
                            <Pill tone={freshnessTone(r.freshnessHint.state)}>{FRESHNESS_LABELS[r.freshnessHint.state]}</Pill>
                            <small style={{ display: "block" }}>as of {dateOnly(r.freshnessHint.checkedAt)}</small>
                          </>
                        ) : (
                          <span className="foundationnote">Not yet recorded</span>
                        )}
                      </td>
                      <td>{r.finalizedAt ? dateOnly(r.finalizedAt) : r.currentFinalizedVersion !== null ? `Version ${r.currentFinalizedVersion}` : "Not finalized"}</td>
                      <td>{r.revisionCount}</td>
                      <td>{s ? (s.commercial.governing ? `${EVALUATION_LABELS[s.commercial.deliverable.evaluation]} · ${COMMERCIAL_EVIDENCE_LABEL}` : "Unavailable · no governing Agreement") : <Dash />}</td>
                      <td>{s && s.commercial.targets.total > 0 ? `${s.commercial.targets.met} met · ${s.commercial.targets.notMet} not met · ${s.commercial.targets.unavailable} unavailable` : <Dash />}</td>
                      <td>
                        <Link className="btn" href={reviewHref(r.reviewRef!)} aria-label={`Open review for ${row.label}`}>
                          Open review
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </PanelBody>
      </Panel>
    </PanelGrid>
  );
}
