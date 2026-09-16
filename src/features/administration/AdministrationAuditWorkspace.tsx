"use client";

import { useState } from "react";

import { EmptyState, Skeleton } from "@/ui/States";
import { absoluteTime, changeSummary, operationLabel, relativeTime } from "./format";
import { listAuditEvents } from "./api-client";
import type { AuditEventDto } from "@/server/administration/audit-service";
import type { AuditEventListCursor } from "@/server/authz/audit";

export function AdministrationAuditWorkspace({
  initialEvents,
  initialNextCursor,
}: {
  initialEvents: AuditEventDto[];
  initialNextCursor: AuditEventListCursor | null;
}) {
  const [events, setEvents] = useState(initialEvents);
  const [cursor, setCursor] = useState(initialNextCursor);
  const [operationFilter, setOperationFilter] = useState("all");
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const operations = [...new Set(events.map((event) => event.operation))];
  const filtered = operationFilter === "all" ? events : events.filter((event) => event.operation === operationFilter);

  async function loadMore() {
    if (!cursor) return;
    setLoadingMore(true);
    setError(null);
    const result = await listAuditEvents({ limit: 20, cursor });
    setLoadingMore(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setEvents((prev) => [...prev, ...result.data.events]);
    setCursor(result.data.nextCursor);
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
          <b>Couldn&rsquo;t load more events.</b> {error}
        </div>
      )}

      {filtered.length === 0 ? (
        <EmptyState title="No audit events yet" description="Access-changing mutations will appear here as they happen." />
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

      {loadingMore && (
        <div style={{ padding: "0 18px 18px" }}>
          <Skeleton lines={2} />
        </div>
      )}

      <div className="panelfoot">
        <span>
          {filtered.length} of {events.length} loaded{cursor ? " · more available" : ""}
        </span>
        {cursor && (
          <button className="btn" type="button" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? "Loading…" : "Load more"}
          </button>
        )}
      </div>
    </section>
  );
}
