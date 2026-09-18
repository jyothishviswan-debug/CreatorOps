"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { Toolbar, SearchInput } from "@/ui/Table";
import { Pill } from "@/ui/Badge";
import { EmptyState, Skeleton } from "@/ui/States";
import { Icon } from "@/ui/icons";
import { initialsOf } from "@/features/shared/types";
import { Pager } from "@/features/administration/Pager";
import type { AssignmentDto } from "@/server/assignments/client-dto";
import type { AssignmentListCursor } from "@/server/assignments/firestore";
import { ASSIGNMENT_STATUSES, type AssignmentStatus } from "@/server/assignments/types";
import { listAssignments } from "./api-client";
import { dateLabel, platformLabel, STATUS_LABELS, statusTone } from "./format";

const PAGE_SIZE = 10;

// Step 10B: the Assignment Workspace toolbar is the exact frozen golden-
// master shape (search / status / density / table-cards) - confirmed
// directly from docs/reference/CreatorOps_UI_Golden_Master.html's own
// `workspace()` function, the same toolbar WorkspaceView already renders.
// It is deliberately NOT Campaign's own differently-designed toolbar
// (region/platform/assigned-to-me pickers) - that is Campaign's own
// approved design, not a template every module inherits.
//
// Search is real but honestly bounded: Assignment has no indexed name/
// text field to prefix-search server-side, and building a new cross-
// domain "resolve Campaign/Partner name matches into bounded Assignment
// queries" search service is new backend architecture disproportionate
// to this UI-wiring step (see the accepted plan's own resolution). So the
// search field filters the CURRENTLY-LOADED, already-authorized page
// (using the same resolved campaignName/partnerDisplayName/regionIds
// already fetched for that page - zero extra reads), with explicit
// caption copy so its bound is never a silent lie about scanning the
// whole dataset.
export function AssignmentsWorkspace({ initialAssignments, initialNextCursor }: { initialAssignments: AssignmentDto[]; initialNextCursor: AssignmentListCursor | null }) {
  const router = useRouter();
  const [pages, setPages] = useState<AssignmentDto[][]>([initialAssignments]);
  const [nextCursors, setNextCursors] = useState<(AssignmentListCursor | null)[]>([initialNextCursor]);
  const [currentPage, setCurrentPage] = useState(1);

  const [searchInput, setSearchInput] = useState("");
  const [status, setStatus] = useState<AssignmentStatus | "all">("all");
  const [density, setDensity] = useState(false); // false = comfortable, true = compact
  const [layout, setLayout] = useState<"table" | "cards">("table");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const skippedFirstEffect = useRef(false);

  async function refetchForStatus(nextStatus: AssignmentStatus | "all") {
    setStatus(nextStatus);
    if (!skippedFirstEffect.current) skippedFirstEffect.current = true;
    setLoading(true);
    setError(null);
    const result = await listAssignments({ limit: PAGE_SIZE, status: nextStatus === "all" ? undefined : nextStatus });
    setLoading(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setPages([result.data.assignments]);
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
    const result = await listAssignments({ limit: PAGE_SIZE, cursor, status: status === "all" ? undefined : status });
    setLoading(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setPages((prev) => [...prev, result.data.assignments]);
    setNextCursors((prev) => [...prev, result.data.nextCursor]);
    setCurrentPage(page);
  }

  const pageRows = pages[currentPage - 1] ?? [];
  const hasMore = nextCursors[currentPage - 1] != null;

  const searchTerm = searchInput.trim().toLowerCase();
  const rows =
    searchTerm.length === 0
      ? pageRows
      : pageRows.filter((a) => {
          const haystack = [a.partnerDisplayName, a.campaignName, ...a.regionIds].filter(Boolean).join(" ").toLowerCase();
          return haystack.includes(searchTerm);
        });

  function openAssignment(assignmentRef: string) {
    router.push(`/assignments/${assignmentRef}`);
  }

  function clearFilters() {
    setSearchInput("");
    if (status !== "all") refetchForStatus("all");
  }

  const anyFilterActive = Boolean(searchInput || status !== "all");

  return (
    <section className="panel">
      <Toolbar>
        <SearchInput placeholder="Search names, context or region…" aria-label="Search records" value={searchInput} onChange={(e) => setSearchInput(e.target.value)} />
        <select aria-label="Filter status" value={status} onChange={(e) => refetchForStatus(e.target.value as AssignmentStatus | "all")}>
          <option value="all">All statuses</option>
          {ASSIGNMENT_STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABELS[s]}
            </option>
          ))}
        </select>
        <button type="button" className="btn" aria-pressed={density} onClick={() => setDensity((v) => !v)}>
          {density ? "Comfortable" : "Compact"} rows
        </button>
        <div className="segment">
          <button type="button" className={layout === "table" ? "active" : ""} aria-label="Table view" aria-pressed={layout === "table"} onClick={() => setLayout("table")}>
            <Icon name="table" />
          </button>
          <button type="button" className={layout === "cards" ? "active" : ""} aria-label="Cards view" aria-pressed={layout === "cards"} onClick={() => setLayout("cards")}>
            <Icon name="grid" />
          </button>
        </div>
      </Toolbar>
      <p className="foundationnote" style={{ margin: "0 18px 14px" }}>
        Searches the assignments currently loaded on this page.
      </p>

      {error && (
        <div className="banner" role="alert" style={{ margin: "0 18px 15px" }}>
          <b>Couldn&rsquo;t load assignments.</b> {error}
        </div>
      )}

      {loading ? (
        <div style={{ padding: "0 18px 18px" }}>
          <Skeleton lines={5} />
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          title={anyFilterActive ? "No matching Assignments" : "No Assignments in scope yet"}
          description={anyFilterActive ? "Try a different search, or clear filters." : "Assignments you're authorized to see will appear here."}
          icon={anyFilterActive ? "search" : "check"}
          action={
            anyFilterActive ? (
              <button className="btn" type="button" onClick={clearFilters}>
                Clear filters
              </button>
            ) : undefined
          }
        />
      ) : layout === "cards" ? (
        <RecordCards rows={rows} onOpen={openAssignment} compact={density} />
      ) : (
        <RecordTable rows={rows} onOpen={openAssignment} compact={density} />
      )}

      <div className="panelfoot">
        <span>
          Page {currentPage} · {rows.length} shown
        </span>
        <Pager currentPage={currentPage} knownPages={pages.length} hasMore={hasMore} busy={loading} onChange={goToPage} />
      </div>
    </section>
  );
}

function recordLabel(a: AssignmentDto): string {
  return a.partnerDisplayName ?? "Unknown Partner";
}

function contextLabel(a: AssignmentDto): string {
  const platform = a.brief.platforms.length > 0 ? a.brief.platforms.map(platformLabel).join(", ") : null;
  const due = a.brief.dueAt ? `due ${dateLabel(a.brief.dueAt)}` : null;
  return [platform, due].filter(Boolean).join(" · ") || "—";
}

function RecordCards({ rows, onOpen, compact }: { rows: AssignmentDto[]; onOpen: (assignmentRef: string) => void; compact: boolean }) {
  return (
    <div className="recordgrid">
      {rows.map((a) => (
        <article className="record" key={a.assignmentRef}>
          <button className="rowlink person" type="button" onClick={() => onOpen(a.assignmentRef)}>
            <span className="avatar">{initialsOf(recordLabel(a))}</span>
            <span>
              <b>{recordLabel(a)}</b>
              {!compact && <small>{a.campaignName ?? "Unknown Campaign"}</small>}
            </span>
          </button>
          <div style={{ marginTop: 13 }}>
            <Pill tone={statusTone(a.status)}>{STATUS_LABELS[a.status]}</Pill>
          </div>
          <div className="recordmeta">
            <span>{a.regionIds[0] ?? "No region"}</span>
            <span>{a.ownerDisplayName ?? "Unassigned"}</span>
          </div>
        </article>
      ))}
    </div>
  );
}

function RecordTable({ rows, onOpen, compact }: { rows: AssignmentDto[]; onOpen: (assignmentRef: string) => void; compact: boolean }) {
  return (
    <div className="tablewrap">
      <table className={compact ? "compact" : ""}>
        <caption className="sr">Assignments workspace</caption>
        <thead>
          <tr>
            <th>Record</th>
            <th>Status</th>
            <th>Context</th>
            <th>Region</th>
            <th>Owner</th>
            <th>
              <span className="sr">Action</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((a) => (
            <tr key={a.assignmentRef}>
              <td>
                <button className="rowlink person" type="button" onClick={() => onOpen(a.assignmentRef)}>
                  <span className="avatar">{initialsOf(recordLabel(a))}</span>
                  <span>
                    <b>{recordLabel(a)}</b>
                    <small>{a.campaignName ?? "Unknown Campaign"}</small>
                  </span>
                </button>
              </td>
              <td>
                <Pill tone={statusTone(a.status)}>{STATUS_LABELS[a.status]}</Pill>
              </td>
              <td>{contextLabel(a)}</td>
              <td>{a.regionIds[0] ?? "—"}</td>
              <td>{a.ownerDisplayName ?? "Unassigned"}</td>
              <td>
                <button className="iconbutton" aria-label={`Inspect ${recordLabel(a)}`} type="button" onClick={() => onOpen(a.assignmentRef)}>
                  &rsaquo;
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
