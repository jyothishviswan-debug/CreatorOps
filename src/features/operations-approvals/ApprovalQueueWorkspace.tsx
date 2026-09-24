"use client";

import { useMemo, useState } from "react";
import Link from "next/link";

import { Toolbar, SearchInput } from "@/ui/Table";
import { Pill } from "@/ui/Badge";
import { EmptyState, Skeleton } from "@/ui/States";
import type { ApprovalItemDto } from "@/server/operations/approval-queue/types";
import { APPROVAL_ACTION_TYPES, APPROVAL_SOURCE_MODULES } from "@/server/operations/approval-queue/types";

import { listApprovalQueue } from "@/features/operations/api-client";
import { APPROVAL_SOURCE_LABEL, displayNameOrRef, formatDateTime } from "@/features/operations/copy";
import { approvalSourceHref } from "@/features/operations/target-links";
import { useNarrowViewport } from "@/features/operations/use-narrow-viewport";

const ALL = "ALL";

// Step 18B: THE ONE UI SURFACE IN THIS ENTIRE FEATURE that is only ever allowed to render a single
// action per row: "Open source". Section 6/11 of the spec, made mechanical here rather than only in
// prose: every `ApprovalItemDto.allowedActions` is always `[]` (there is no `act_on_approval_queue`
// action anywhere in the codebase - see approval-queue-service.ts's own top comment), and this
// component never imports, calls, or renders anything that could mutate a source record. The ONLY
// interactive control besides "Open source" is a read-only "Refresh" that re-runs the identical live
// query - never a cached Operations-owned approval status. Do not add a second action here; the
// approve/finalize/resolve/confirm decision belongs entirely to the linked source screen.
export function ApprovalQueueWorkspace({ initial, canView }: { initial: { items: ApprovalItemDto[]; notices: string[] }; canView: boolean }) {
  const [items, setItems] = useState(initial.items);
  const [notices, setNotices] = useState(initial.notices);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sourceModule, setSourceModule] = useState<typeof ALL | string>(ALL);
  const [actionType, setActionType] = useState<typeof ALL | string>(ALL);
  const [requestedBy, setRequestedBy] = useState("");
  const [search, setSearch] = useState("");
  const narrow = useNarrowViewport();

  async function refresh() {
    setLoading(true);
    setError(null);
    const result = await listApprovalQueue({ sourceModule: sourceModule === ALL ? undefined : sourceModule, limit: 200 });
    setLoading(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setItems(result.data.items);
    setNotices(result.data.notices);
  }

  const filtered = useMemo(
    () =>
      items.filter((item) => {
        if (actionType !== ALL && item.actionType !== actionType) return false;
        if (requestedBy.trim() && !`${item.requestedBy ?? ""} ${item.requestedByDisplayName ?? ""}`.toLowerCase().includes(requestedBy.trim().toLowerCase())) return false;
        if (search.trim()) {
          const q = search.trim().toLowerCase();
          const haystack = `${item.title} ${item.summary} ${item.sourceRef}`.toLowerCase();
          if (!haystack.includes(q)) return false;
        }
        return true;
      }),
    [items, actionType, requestedBy, search],
  );

  function resetFilters() {
    setSourceModule(ALL);
    setActionType(ALL);
    setRequestedBy("");
    setSearch("");
    void refresh();
  }

  if (!canView) {
    return (
      <section className="panel">
        <EmptyState title="You do not have access to the Approval Queue" description="Ask an administrator for the view_approval_queue grant if you believe this is wrong." icon="lock" />
      </section>
    );
  }

  return (
    <section className="panel" aria-busy={loading}>
      <Toolbar>
        <select
          aria-label="Source module"
          style={{ width: 170 }}
          value={sourceModule}
          onChange={(e) => {
            setSourceModule(e.target.value);
            void refresh();
          }}
        >
          <option value={ALL}>All sources</option>
          {APPROVAL_SOURCE_MODULES.map((m) => (
            <option key={m} value={m}>
              {APPROVAL_SOURCE_LABEL[m]}
            </option>
          ))}
        </select>
        <select aria-label="Action needed" style={{ width: 220 }} value={actionType} onChange={(e) => setActionType(e.target.value)}>
          <option value={ALL}>Any action needed</option>
          {APPROVAL_ACTION_TYPES.map((a) => (
            <option key={a} value={a}>
              {a.replaceAll("_", " ")}
            </option>
          ))}
        </select>
        <input type="search" aria-label="Requested by" placeholder="Requested by…" value={requestedBy} onChange={(e) => setRequestedBy(e.target.value)} style={{ minWidth: 150, maxWidth: 200 }} />
        <SearchInput aria-label="Search approvals" placeholder="Search title or ref…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <button type="button" className="btn ghost" onClick={resetFilters} data-testid="reset-approval-filters">
          Reset
        </button>
        <button type="button" className="btn" onClick={() => void refresh()} data-testid="refresh-approval-queue">
          Refresh
        </button>
      </Toolbar>

      {notices.map((notice) => (
        <div key={notice} className="banner" role="status" style={{ margin: "0 18px 10px" }}>
          {notice}
        </div>
      ))}
      {error && (
        <div className="banner" role="alert" style={{ margin: "0 18px 10px" }}>
          {error}
        </div>
      )}

      {loading ? (
        <div style={{ padding: "0 18px 18px" }} aria-hidden="true">
          <Skeleton lines={5} />
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState title="No approvals waiting" description="Items that need your attention will appear here from their source modules." icon="check" />
      ) : narrow ? (
        <ApprovalCards items={filtered} />
      ) : (
        <ApprovalTable items={filtered} />
      )}

      <div className="panelfoot">
        <span>{filtered.length} item(s) shown</span>
        <span>Live read-only projection - no Operations-owned approval status</span>
      </div>
    </section>
  );
}

function OpenSourceLink({ item }: { item: ApprovalItemDto }) {
  const href = approvalSourceHref(item);
  if (!href) {
    return <span className="foundationnote">Source screen unavailable</span>;
  }
  return (
    <Link className="btn" href={href} data-testid="open-source">
      Open source
    </Link>
  );
}

function ApprovalTable({ items }: { items: ApprovalItemDto[] }) {
  return (
    <div className="tablewrap" data-testid="approvals-table">
      <table className="compact">
        <caption className="sr">Approval Queue - live read-only projection</caption>
        <thead>
          <tr>
            <th scope="col">Item</th>
            <th scope="col">Source</th>
            <th scope="col">Action needed</th>
            <th scope="col">Requested by</th>
            <th scope="col">Requested</th>
            <th scope="col">Current status</th>
            <th scope="col">
              <span className="sr">Action</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.approvalItemRef} data-testid="approval-row" data-approval-ref={item.approvalItemRef}>
              <td style={{ maxWidth: 280, overflowWrap: "anywhere" }}>
                <b>{item.title}</b>
                <small style={{ display: "block" }}>{item.summary}</small>
              </td>
              <td>
                <Pill tone="blue">{APPROVAL_SOURCE_LABEL[item.sourceModule]}</Pill>
              </td>
              <td>{item.actionType.replaceAll("_", " ")}</td>
              <td style={{ overflowWrap: "anywhere" }}>{item.requestedBy ? displayNameOrRef(item.requestedByDisplayName, item.requestedBy) : "—"}</td>
              <td>{formatDateTime(item.requestedAt)}</td>
              <td>{item.currentSourceStatus}</td>
              <td>
                <OpenSourceLink item={item} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ApprovalCards({ items }: { items: ApprovalItemDto[] }) {
  return (
    <div className="recordgrid" data-testid="approvals-cards">
      {items.map((item) => (
        <article className="record" key={item.approvalItemRef} data-testid="approval-card" data-approval-ref={item.approvalItemRef}>
          <b>{item.title}</b>
          <small style={{ display: "block", marginBottom: 8 }}>{item.summary}</small>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
            <Pill tone="blue">{APPROVAL_SOURCE_LABEL[item.sourceModule]}</Pill>
          </div>
          <div className="recordmeta">
            <span>{item.actionType.replaceAll("_", " ")}</span>
            <span>{item.currentSourceStatus}</span>
          </div>
          <div style={{ marginTop: 12 }}>
            <OpenSourceLink item={item} />
          </div>
        </article>
      ))}
    </div>
  );
}
