"use client";

import { useState } from "react";

import { Pill } from "@/ui/Badge";
import { EmptyState, Skeleton } from "@/ui/States";
import { SearchInput, Toolbar } from "@/ui/Table";
import { Pager } from "@/features/administration/Pager";
import type { AnalyticsImportBatchListCursor, AnalyticsImportBatchListItemDto } from "@/server/analytics/import-history-service";

import { AnalyticsBatchDetailDialog } from "./AnalyticsBatchDetailDialog";
import { listAnalyticsImportBatches } from "./api-client";
import { absoluteTime, batchStatusLabel, batchStatusTone, targetKindLabel } from "./format";

const PAGE_SIZE = 20;

function sheetsSummary(batch: AnalyticsImportBatchListItemDto): string {
  if (batch.sourceSheetInventory.length === 0) return "No sheet inventory recorded";
  return batch.sourceSheetInventory.map((s) => `${s.sheetName} (${s.rowCount})`).join(", ");
}

function outcomeSummary(batch: AnalyticsImportBatchListItemDto): string {
  return `${batch.matchedRows} matched · ${batch.unmatchedRows} unmatched · ${batch.ambiguousRows} ambiguous · ${batch.invalidRows} invalid`;
}

export function AnalyticsImportHistoryWorkspace({ initialBatches, initialNextCursor }: { initialBatches: AnalyticsImportBatchListItemDto[]; initialNextCursor: AnalyticsImportBatchListCursor | null }) {
  const [pages, setPages] = useState<AnalyticsImportBatchListItemDto[][]>([initialBatches]);
  const [nextCursors, setNextCursors] = useState<(AnalyticsImportBatchListCursor | null)[]>([initialNextCursor]);
  const [currentPage, setCurrentPage] = useState(1);

  const [searchInput, setSearchInput] = useState("");
  const [targetKind, setTargetKind] = useState<"campaign_content" | "channel_account" | "all">("all");
  const [status, setStatus] = useState<string>("all");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openBatchRef, setOpenBatchRef] = useState<string | null>(null);

  async function refetch(nextTargetKind: typeof targetKind, nextStatus: string) {
    setTargetKind(nextTargetKind);
    setStatus(nextStatus);
    setLoading(true);
    setError(null);
    const result = await listAnalyticsImportBatches({ limit: PAGE_SIZE, targetKind: nextTargetKind === "all" ? undefined : nextTargetKind, status: nextStatus === "all" ? undefined : nextStatus });
    setLoading(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setPages([result.data.batches]);
    setNextCursors([result.data.nextCursor]);
    setCurrentPage(1);
  }

  async function goToPage(page: number) {
    if (page < 1 || page === currentPage) return;
    if (page <= pages.length) {
      setCurrentPage(page);
      return;
    }
    const cursor = nextCursors[page - 2];
    if (page > pages.length + 1 || cursor === undefined || cursor === null) return;
    setLoading(true);
    setError(null);
    const result = await listAnalyticsImportBatches({ limit: PAGE_SIZE, cursor, targetKind: targetKind === "all" ? undefined : targetKind, status: status === "all" ? undefined : status });
    setLoading(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setPages((prev) => [...prev, result.data.batches]);
    setNextCursors((prev) => [...prev, result.data.nextCursor]);
    setCurrentPage(page);
  }

  const pageRows = pages[currentPage - 1] ?? [];
  const hasMore = nextCursors[currentPage - 1] != null;

  const searchTerm = searchInput.trim().toLowerCase();
  const rows =
    searchTerm.length === 0
      ? pageRows
      : pageRows.filter((b) => [b.sourceFilename, b.actorDisplayName ?? "", batchStatusLabel(b.status), targetKindLabel(b.targetKind)].join(" ").toLowerCase().includes(searchTerm));

  function clearFilters() {
    setSearchInput("");
    if (targetKind !== "all" || status !== "all") void refetch("all", "all");
  }

  const anyFilterActive = Boolean(searchInput || targetKind !== "all" || status !== "all");

  return (
    <section className="panel" style={{ marginTop: 18 }}>
      <Toolbar>
        <SearchInput placeholder="Search loaded batches…" aria-label="Search import batches" value={searchInput} onChange={(e) => setSearchInput(e.target.value)} />
        <select aria-label="Filter target kind" value={targetKind} onChange={(e) => refetch(e.target.value as typeof targetKind, status)}>
          <option value="all">All targets</option>
          <option value="campaign_content">Campaign content</option>
          <option value="channel_account">Channel account</option>
        </select>
        <select aria-label="Filter status" value={status} onChange={(e) => refetch(targetKind, e.target.value)}>
          <option value="all">All statuses</option>
          <option value="PENDING">Pending</option>
          <option value="DRY_RUN_ONLY">Dry run only</option>
          <option value="COMPLETED">Completed</option>
          <option value="COMPLETED_WITH_ERRORS">Completed with errors</option>
          <option value="FAILED">Failed</option>
        </select>
      </Toolbar>
      <p className="foundationnote" style={{ margin: "0 18px 14px" }}>
        Searches the import batches currently loaded on this page.
      </p>

      {error && (
        <div className="banner" role="alert" style={{ margin: "0 18px 15px" }}>
          <b>Couldn&rsquo;t load import history.</b> {error}
        </div>
      )}

      {loading ? (
        <div style={{ padding: "0 18px 18px" }}>
          <Skeleton lines={5} />
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          title={anyFilterActive ? "No matching batches" : "No import batches yet"}
          description={anyFilterActive ? "Try a different search, or clear filters." : "Analytics import batches you're authorized to see will appear here."}
          icon={anyFilterActive ? "search" : "check"}
          action={
            anyFilterActive ? (
              <button className="btn" type="button" onClick={clearFilters}>
                Clear filters
              </button>
            ) : undefined
          }
        />
      ) : (
        <div className="tablewrap">
          <table>
            <caption className="sr">Import history batches</caption>
            <thead>
              <tr>
                <th>Batch</th>
                <th>Status</th>
                <th>Target</th>
                <th>Sheets</th>
                <th>Rows</th>
                <th>Outcome</th>
                <th>Actor</th>
                <th>Created</th>
                <th>
                  <span className="sr">Action</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((b) => (
                <tr key={b.batchRef}>
                  <td>
                    <button className="rowlink person" type="button" onClick={() => setOpenBatchRef(b.batchRef)}>
                      <span>
                        <b>{b.sourceFilename}</b>
                      </span>
                    </button>
                  </td>
                  <td>
                    <Pill tone={batchStatusTone(b.status)}>{batchStatusLabel(b.status)}</Pill>
                  </td>
                  <td>{targetKindLabel(b.targetKind)}</td>
                  <td>{sheetsSummary(b)}</td>
                  <td>{b.totalRows.toLocaleString("en-GB")}</td>
                  <td>{outcomeSummary(b)}</td>
                  <td>{b.actorDisplayName ?? "Unknown"}</td>
                  <td>{absoluteTime(b.createdAt)}</td>
                  <td>
                    <button className="iconbutton" aria-label={`Inspect ${b.sourceFilename}`} type="button" onClick={() => setOpenBatchRef(b.batchRef)}>
                      &rsaquo;
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="panelfoot">
        <span>
          Page {currentPage} · {rows.length} shown
        </span>
        <Pager currentPage={currentPage} knownPages={pages.length} hasMore={hasMore} busy={loading} onChange={goToPage} />
      </div>

      {openBatchRef && <AnalyticsBatchDetailDialog batchRef={openBatchRef} open={Boolean(openBatchRef)} onClose={() => setOpenBatchRef(null)} />}
    </section>
  );
}
