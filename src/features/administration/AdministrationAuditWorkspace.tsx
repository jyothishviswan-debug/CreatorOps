"use client";

import { useState } from "react";

import { EmptyState, Skeleton } from "@/ui/States";
import { absoluteTime, changeSummary, operationLabel, relativeTime } from "./format";
import { Pager } from "./Pager";
import { listAuditEvents } from "./api-client";
import type { AuditEventDto } from "@/server/administration/audit-service";
import type { AuditEventListCursor } from "@/server/authz/audit";

const PAGE_SIZE = 10;

export function AdministrationAuditWorkspace({
  initialEvents,
  initialNextCursor,
}: {
  initialEvents: AuditEventDto[];
  initialNextCursor: AuditEventListCursor | null;
}) {
  // pages[i] is page i+1's events; nextCursors[i] is the cursor to fetch
  // page i+2 - same cursor-cache pattern as AdministrationUsersWorkspace.
  const [pages, setPages] = useState<AuditEventDto[][]>([initialEvents]);
  const [nextCursors, setNextCursors] = useState<(AuditEventListCursor | null)[]>([initialNextCursor]);
  const [currentPage, setCurrentPage] = useState(1);
  const [operationFilter, setOperationFilter] = useState("all");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rows = pages[currentPage - 1] ?? [];
  const operations = [...new Set(rows.map((event) => event.operation))];
  const filtered = operationFilter === "all" ? rows : rows.filter((event) => event.operation === operationFilter);
  const hasMore = nextCursors[currentPage - 1] != null;

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
    const result = await listAuditEvents({ limit: PAGE_SIZE, cursor });
    setLoading(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setPages((prev) => [...prev, result.data.events]);
    setNextCursors((prev) => [...prev, result.data.nextCursor]);
    setCurrentPage(page);
  }

  return (
    <section className="panel">
      <div className="toolbar">
        <select aria-label="Filter operation" value={operationFilter} onChange={(e) => setOperationFilter(e.target.value)}>
          <option value="all">All operations</option>
          {operations.map((op) => (
            <option key={op} value={op}>
              {operationLabel(op)}
            </option>
          ))}
        </select>
      </div>

      {error && (
        <div className="banner" role="alert" style={{ margin: "0 18px 15px" }}>
          <b>Couldn&rsquo;t load that page.</b> {error}
        </div>
      )}

      {loading ? (
        <div style={{ padding: "0 18px 18px" }}>
          <Skeleton lines={5} />
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState title="No audit events on this page" description="Access-changing mutations will appear here as they happen." icon="clock" />
      ) : (
        <div className="tablewrap">
          <table>
            <caption className="sr">Administration audit trail</caption>
            <thead>
              <tr>
                <th>Timestamp</th>
                <th>Actor</th>
                <th>Target</th>
                <th>Operation</th>
                <th>Change</th>
                <th>Request</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((event, i) => (
                <tr key={`${event.requestId}-${i}`}>
                  <td title={absoluteTime(event.createdAt)}>{relativeTime(event.createdAt)}</td>
                  <td>{event.actorEmail}</td>
                  <td>{event.targetEmail ?? (event.targetRole ? `role: ${event.targetRole}` : "—")}</td>
                  <td>{operationLabel(event.operation)}</td>
                  <td style={{ whiteSpace: "normal", maxWidth: 320 }}>{changeSummary(event.before, event.after)}</td>
                  <td style={{ fontFamily: "monospace", fontSize: 10 }}>{event.requestId}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="panelfoot">
        <span>
          Page {currentPage} · {filtered.length} shown
        </span>
        <Pager currentPage={currentPage} knownPages={pages.length} hasMore={hasMore} busy={loading} onChange={goToPage} />
      </div>
    </section>
  );
}
