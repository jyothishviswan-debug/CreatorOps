"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { Pill } from "@/ui/Badge";
import { EmptyState, Skeleton } from "@/ui/States";
import { Toolbar } from "@/ui/Table";
import { initialsOf } from "@/features/shared/types";
import { RegionMultiSelect } from "@/features/shared/RegionMultiSelect";
import { Pager } from "@/features/administration/Pager";
import type { PartnerReviewsWorkspaceDto } from "@/server/partner-reviews/partner-review-workspace-service";
import type { ReviewListRowDto } from "@/server/partner-reviews/ui-dto";
import { monthLabel, partnerHistoryHref, reviewHref, workspaceHref, WORKSPACE_FILTERS, WORKSPACE_FILTER_LABELS, type WorkspaceFilter } from "@/server/partner-reviews/ui-params";

import { generateReview, loadWorkspacePage } from "./api-client";
import { COMMERCIAL_EVIDENCE_LABEL, DISABLED_BUTTON_STYLE, dateOnly, EVENT_LABELS, formatCount, FRESHNESS_LABELS, freshnessTone, LIFECYCLE_LABELS, lifecycleTone, relativeTime, SIGNAL_LABELS, TARGET_MONITORING_LABEL } from "./format";
import { ReviewMonthSelect } from "./ReviewMonthSelect";
import { ReviewPartnerFilter } from "./ReviewPartnerFilter";
import { workspaceCountCopy, workspaceEmptyCopy } from "./workspace-copy";
import type { WorkspaceQueryState } from "./workspace-query";

const PAGE_SIZE = 10;

// A dash for a value that does not exist yet (a Partner-month with no review generated) - announced as unavailable, never a bare "—".
function NoReviewDash() {
  return (
    <span role="img" aria-label="Unavailable - no review generated yet">
      —
    </span>
  );
}

const EVALUATION_LABELS: Record<string, string> = { met: "Met", below_requirement: "Below requirement", exceeded: "Exceeded", unavailable: "Unavailable" };

type Generated = { reviewRef: string; outcome: "created" | "existing" };

// Step 13B: the Partner Reviews Workspace. It is the accepted Workspace toolbar family (search-style
// Partner filter, select-style month/region controls, `.segment` filter group) over the accepted
// `tablewrap` + `compact` table. Every filter is URL state re-validated by the SERVER; pages come from
// the server one bounded cursor page at a time - nothing is fetched whole and filtered in the browser.
export function PartnerReviewsWorkspace({ initial, state }: { initial: PartnerReviewsWorkspaceDto; state: WorkspaceQueryState }) {
  const router = useRouter();
  const [pages, setPages] = useState<ReviewListRowDto[][]>([initial.rows]);
  const [nextCursors, setNextCursors] = useState<(string | null)[]>([initial.nextCursor]);
  const [currentPage, setCurrentPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generated, setGenerated] = useState<Record<string, Generated>>({});
  const [busyRow, setBusyRow] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<string | null>(null);

  const { month, mode, permissions } = initial;
  const activeFilter: WorkspaceFilter | null = state.filter ?? (state.signal ? null : "needs-review");

  function go(next: Partial<WorkspaceQueryState>) {
    // A month the URL did not name stays un-named (the server keeps defaulting); anything explicit is carried.
    const merged = { ...state, ...next };
    router.push(
      workspaceHref({ filter: merged.filter ?? undefined, signal: merged.signal, month: merged.month, partnerRef: merged.partnerRef, region: merged.region }),
      { scroll: false },
    );
  }

  async function goToPage(page: number) {
    if (page < 1 || page === currentPage) return;
    if (page <= pages.length) {
      setCurrentPage(page);
      return;
    }
    const cursor = nextCursors[page - 2];
    if (page > pages.length + 1 || !cursor) return;
    setLoading(true);
    setError(null);
    const result = await loadWorkspacePage({ ...state, month: month.resolved, cursor, limit: PAGE_SIZE });
    setLoading(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setPages((previous) => [...previous, result.data.rows]);
    setNextCursors((previous) => [...previous, result.data.nextCursor]);
    setCurrentPage(page);
  }

  async function onGenerate(row: ReviewListRowDto) {
    if (busyRow) return;
    setBusyRow(row.rowKey);
    setRowErrors((previous) => ({ ...previous, [row.rowKey]: "" }));
    const result = await generateReview({ partnerRef: row.partnerRef, periodKey: row.periodKey });
    setBusyRow(null);
    if (!result.ok) {
      setRowErrors((previous) => ({ ...previous, [row.rowKey]: result.error }));
      return;
    }
    // 201 = this call created the review; 200 = it already existed (idempotent) - either way exactly one review.
    const outcome: Generated["outcome"] = result.status === 201 ? "created" : "existing";
    setGenerated((previous) => ({ ...previous, [row.rowKey]: { reviewRef: result.data.head.reviewRef, outcome } }));
    setStatus(outcome === "created" ? `Draft review generated for ${row.partnerDisplayName ?? "this Partner"} · ${monthLabel(row.periodKey)}.` : `A review already existed for ${row.partnerDisplayName ?? "this Partner"} · ${monthLabel(row.periodKey)}.`);
  }

  const pageRows = pages[currentPage - 1] ?? [];
  const hasMore = nextCursors[currentPage - 1] != null;
  const anyFilterActive = Boolean(state.partnerRef || state.region.length > 0 || state.signal);
  const sourceLabel = month.resolved === null ? "No review months yet" : month.source === "explicit" ? "Selected month" : month.source === "latest_review" ? "Latest review month" : "Latest month with Assignments";
  const { disclosure } = initial;
  // Step 13C: a truncated read is an INCOMPLETE list - the count and the empty state say so (never an exact-looking total).
  const bound = { headsRead: disclosure.headsRead, headsTruncated: disclosure.headsTruncated };
  const countCopy = workspaceCountCopy({ total: initial.totalInBoundedSet, ...bound });
  const emptyCopy = workspaceEmptyCopy({ mode, anyFilterActive, monthLabel: month.label, ...bound });

  return (
    <section className="panel">
      <Toolbar>
        <ReviewPartnerFilter selected={initial.partnerFilter} onSelect={(partnerRef) => go({ partnerRef })} />
        <div role="group" aria-label="Region filter" style={{ minWidth: 160, maxWidth: 220, flex: "1 1 160px" }}>
          <RegionMultiSelect compact value={state.region} onChange={(region) => go({ region })} />
        </div>
        <ReviewMonthSelect
          options={month.options.map((option) => ({ ...option, href: workspaceHref({ filter: state.filter ?? undefined, signal: state.signal, month: option.month, partnerRef: state.partnerRef, region: state.region }) }))}
          value={month.resolved}
          sourceLabel={sourceLabel}
          latestHref={month.source === "explicit" ? workspaceHref({ filter: state.filter ?? undefined, signal: state.signal, partnerRef: state.partnerRef, region: state.region }) : null}
        />
        <div className="segment" role="group" aria-label="Review filter">
          {WORKSPACE_FILTERS.map((filter) => (
            <button key={filter} type="button" className={activeFilter === filter ? "active" : ""} aria-pressed={activeFilter === filter} onClick={() => go({ filter })}>
              {WORKSPACE_FILTER_LABELS[filter]}
            </button>
          ))}
        </div>
      </Toolbar>

      {(state.signal || initial.partnerFilter) && (
        <div className="actions" style={{ margin: "0 18px 10px" }}>
          {state.signal && (
            <span className="pill gray" data-testid="signal-chip">
              Signal: {SIGNAL_LABELS[state.signal]}
              <button type="button" aria-label="Clear signal filter" onClick={() => go({ signal: null })} style={{ padding: "0 2px", fontSize: 13, lineHeight: 1, color: "inherit" }}>
                ×
              </button>
            </span>
          )}
          {initial.partnerFilter && (
            <span className="pill gray" data-testid="partner-chip">
              Partner: {initial.partnerFilter.displayName}
              <button type="button" aria-label="Clear Partner filter" onClick={() => go({ partnerRef: null })} style={{ padding: "0 2px", fontSize: 13, lineHeight: 1, color: "inherit" }}>
                ×
              </button>
            </span>
          )}
        </div>
      )}

      <p className="foundationnote" style={{ margin: "0 18px 10px" }}>
        {mode === "needs-review" &&
          `Needs Review is derived, never stored: reviews that were behind upstream at their last recorded check, plus Partner-months found in the most recent ${disclosure.scanLimit} Assignments in your scope that have no review yet.${disclosure.assignmentScanTruncated ? ` The scan stopped after ${disclosure.assignmentsScanned} Assignments - older Partner-months may not be listed.` : ""}`}
        {mode === "drafts" && "Reviews with an open Draft or In Review version, by Partner name."}
        {mode === "finalized" && "Reviews with a current finalized version, by Partner name. Superseded versions stay reachable from each review's Version History."}
        {mode === "signal" && "Reviews matching the selected Needs Attention signal, by Partner name. Freshness is as of the last recorded check - never live."}
        {countCopy && ` ${countCopy}`}
      </p>

      {initial.notices.map((notice) => (
        <div key={notice} className="banner" role="status" style={{ margin: "0 18px 10px" }}>
          {notice}
        </div>
      ))}

      {error && (
        <div className="banner" role="alert" style={{ margin: "0 18px 15px" }}>
          <b>Couldn&rsquo;t load reviews.</b> {error}
        </div>
      )}

      {loading ? (
        <div style={{ padding: "0 18px 18px" }}>
          <Skeleton lines={5} />
        </div>
      ) : month.resolved === null ? (
        <EmptyState title="No review months yet" description="Reviews appear here once a Partner-month has a review or in-period Assignments in your authorized scope." icon="calendar" />
      ) : pageRows.length === 0 ? (
        <EmptyState
          title={emptyCopy.title}
          description={emptyCopy.description}
          icon={anyFilterActive ? "search" : "check"}
          action={
            anyFilterActive ? (
              <button className="btn" type="button" onClick={() => go({ partnerRef: null, region: [], signal: null })}>
                Clear filters
              </button>
            ) : undefined
          }
        />
      ) : (
        <div className="tablewrap">
          <table className="compact">
            <caption className="sr">Partner Reviews workspace</caption>
            <thead>
              <tr>
                <th scope="col">Partner</th>
                <th scope="col">Month · version</th>
                <th scope="col">Status · freshness</th>
                <th scope="col">Production</th>
                <th scope="col">Compliance</th>
                <th scope="col">Performance</th>
                <th scope="col">Commercial evidence</th>
                <th scope="col">Last event</th>
                <th scope="col">
                  <span className="sr">Action</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {pageRows.map((row) => (
                <WorkspaceRow key={row.rowKey} row={row} generated={generated[row.rowKey] ?? null} canGenerate={permissions.canGenerate} busy={busyRow === row.rowKey} anyBusy={busyRow !== null} error={rowErrors[row.rowKey] || null} onGenerate={() => onGenerate(row)} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="panelfoot">
        <span role="status" data-testid="workspace-status">
          {status ?? `Page ${currentPage} · ${pageRows.length} shown`}
        </span>
        <Pager currentPage={currentPage} knownPages={pages.length} hasMore={hasMore} busy={loading} onChange={goToPage} />
      </div>
    </section>
  );
}

function WorkspaceRow({ row, generated, canGenerate, busy, anyBusy, error, onGenerate }: { row: ReviewListRowDto; generated: Generated | null; canGenerate: boolean; busy: boolean; anyBusy: boolean; error: string | null; onGenerate: () => void }) {
  const name = row.partnerDisplayName ?? "Unknown Partner";
  const summary = row.summary;
  const reviewRef = generated?.reviewRef ?? row.reviewRef;
  const lifecycle = generated ? "DRAFT" : row.lifecycle;

  return (
    <tr>
      <td>
        <Link className="rowlink person" href={partnerHistoryHref(row.partnerRef, { month: row.periodKey })} aria-label={`${name} - Partner Reviews history`}>
          <span className="avatar">{initialsOf(name)}</span>
          <span>
            <b>{name}</b>
            <small>Monthly history</small>
          </span>
        </Link>
      </td>
      <td>
        {reviewRef ? (
          <Link href={reviewHref(reviewRef)} aria-label={`${monthLabel(row.periodKey)} review for ${name}`}>
            {monthLabel(row.periodKey)}
          </Link>
        ) : (
          <span>{monthLabel(row.periodKey)}</span>
        )}
        <small style={{ display: "block" }}>{generated ? "Version 1" : row.version ? `Version ${row.version}` : "No review yet"}</small>
      </td>
      <td>
        <Pill tone={lifecycleTone(lifecycle)}>{LIFECYCLE_LABELS[lifecycle]}</Pill>
        {!generated && row.needsReviewReason === "no_review" && <small style={{ display: "block" }}>No review yet</small>}
        {!generated && row.needsReviewReason && row.needsReviewReason !== "no_review" && <small style={{ display: "block" }}>Behind upstream · needs review</small>}
        {!generated && row.revisionOpen && <small style={{ display: "block" }}>Revision of version {row.currentFinalizedVersion}</small>}
        {!generated && row.kind === "review" && (
          <small style={{ display: "block" }}>
            {row.freshnessHint ? (
              <>
                <Pill tone={freshnessTone(row.freshnessHint.state)}>{FRESHNESS_LABELS[row.freshnessHint.state]}</Pill> as of {dateOnly(row.freshnessHint.checkedAt)}
              </>
            ) : (
              "Freshness not yet recorded"
            )}
          </small>
        )}
      </td>
      <td>
        {row.kind === "candidate" ? (
          <span>{row.assignmentsFound} Assignment{row.assignmentsFound === 1 ? "" : "s"} found</span>
        ) : summary ? (
          <span>
            {summary.production.assignmentsIncluded} assignment{summary.production.assignmentsIncluded === 1 ? "" : "s"}
            <small style={{ display: "block" }}>
              {summary.production.approvedContent} approved · {summary.production.underReviewContent} under review · {summary.production.completedAssignments} completed
            </small>
          </span>
        ) : (
          <span>Summary unavailable</span>
        )}
      </td>
      <td>
        {summary && row.kind === "review" ? (
          <span>
            On time {summary.compliance.onTime} · Late {summary.compliance.late}
            {summary.compliance.unknownTiming > 0 && ` · ${summary.compliance.unknownTiming} unknown timing`}
            {summary.completeness.incompleteReasonCount > 0 && <small style={{ display: "block" }}>Evidence incomplete</small>}
          </span>
        ) : (
          <NoReviewDash />
        )}
      </td>
      <td>{summary && row.kind === "review" ? <Pill tone={summary.performance.state === "available" ? "default" : "gray"}>{summary.performance.state === "available" ? "Available" : "Missing"}</Pill> : <NoReviewDash />}</td>
      <td>
        {summary && row.kind === "review" ? (
          <>
            {summary.commercial.governing ? (
              <>
                <span>
                  {EVALUATION_LABELS[summary.commercial.deliverable.evaluation]}
                  {summary.commercial.deliverable.required !== null && ` · ${formatCount(summary.commercial.deliverable.actual)} of ${summary.commercial.deliverable.required}`}
                </span>
                <small style={{ display: "block" }}>{COMMERCIAL_EVIDENCE_LABEL}</small>
              </>
            ) : (
              <span>
                Unavailable
                <small style={{ display: "block" }}>No Agreement requirement</small>
              </span>
            )}
            {summary.commercial.targets.total > 0 && (
              <small style={{ display: "block" }}>
                Targets: {summary.commercial.targets.met} met · {summary.commercial.targets.notMet} not met · {summary.commercial.targets.unavailable} unavailable
                <br />
                {TARGET_MONITORING_LABEL}
              </small>
            )}
          </>
        ) : (
          <NoReviewDash />
        )}
      </td>
      <td>
        {generated ? (
          <span>
            {EVENT_LABELS.generated}
            <small style={{ display: "block" }}>just now</small>
          </span>
        ) : row.lastEvent ? (
          <span>
            {EVENT_LABELS[row.lastEvent.kind]}
            <small style={{ display: "block" }}>{relativeTime(row.lastEvent.at)}</small>
          </span>
        ) : (
          <span role="img" aria-label="No activity recorded yet">
            —
          </span>
        )}
      </td>
      <td>
        {reviewRef ? (
          <Link className="btn" href={reviewHref(reviewRef)} aria-label={`Open review for ${name}, ${monthLabel(row.periodKey)}`}>
            Open review
          </Link>
        ) : canGenerate ? (
          <button
            type="button"
            className="btn primary"
            disabled={anyBusy}
            aria-disabled={anyBusy}
            aria-label={`Generate Review for ${name}, ${monthLabel(row.periodKey)}`}
            onClick={onGenerate}
            style={anyBusy ? DISABLED_BUTTON_STYLE : undefined}
          >
            {busy ? "Generating…" : "Generate Review"}
          </button>
        ) : (
          <span className="foundationnote">Read only</span>
        )}
        {error && (
          <small role="alert" style={{ display: "block", color: "var(--red, #b42318)" }}>
            {error}
          </small>
        )}
      </td>
    </tr>
  );
}
