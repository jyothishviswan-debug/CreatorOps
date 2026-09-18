"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { Toolbar, SearchInput } from "@/ui/Table";
import { Pill } from "@/ui/Badge";
import { EmptyState, Skeleton } from "@/ui/States";
import { Icon } from "@/ui/icons";
import { initialsOf } from "@/features/shared/types";
import { Pager } from "@/features/administration/Pager";
import type { ContentDto } from "@/server/content/client-dto";
import type { ContentListCursor } from "@/server/content/firestore";
import { CONTENT_STATUSES, type ContentStatus } from "@/server/content/types";
import { listContent } from "./api-client";
import { contentDisplayTitle, platformLabel, STATUS_LABELS, statusTone } from "./format";

const PAGE_SIZE = 10;

// Step 11B: the Content Workspace toolbar mirrors
// src/features/assignments/AssignmentsWorkspace.tsx one-for-one (the
// exact frozen golden-master toolbar shape - search / status / density /
// table-cards), per the accepted plan's own explicit "mirror Assignments'
// template" instruction. There is no `/content/new` route and no global
// create button here - Content can only be created contextually, from an
// Assignment's own Content panel (see AssignmentContentPanel.tsx).
//
// Search is real but honestly bounded, same rationale as Assignments' own
// search: no indexed cross-field text search exists server-side for
// Content, so this filters the CURRENTLY-LOADED, already-authorized page
// only (zero extra reads), against title/type/platform/partner/campaign/
// region context already present on the fetched ContentDto rows.
export function ContentWorkspace({ initialContent, initialNextCursor }: { initialContent: ContentDto[]; initialNextCursor: ContentListCursor | null }) {
  const router = useRouter();
  const [pages, setPages] = useState<ContentDto[][]>([initialContent]);
  const [nextCursors, setNextCursors] = useState<(ContentListCursor | null)[]>([initialNextCursor]);
  const [currentPage, setCurrentPage] = useState(1);

  const [searchInput, setSearchInput] = useState("");
  const [status, setStatus] = useState<ContentStatus | "all">("all");
  const [density, setDensity] = useState(false); // false = comfortable, true = compact
  const [layout, setLayout] = useState<"table" | "cards">("table");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const skippedFirstEffect = useRef(false);

  async function refetchForStatus(nextStatus: ContentStatus | "all") {
    setStatus(nextStatus);
    if (!skippedFirstEffect.current) skippedFirstEffect.current = true;
    setLoading(true);
    setError(null);
    const result = await listContent({ limit: PAGE_SIZE, status: nextStatus === "all" ? undefined : nextStatus });
    setLoading(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setPages([result.data.content]);
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
    const result = await listContent({ limit: PAGE_SIZE, cursor, status: status === "all" ? undefined : status });
    setLoading(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setPages((prev) => [...prev, result.data.content]);
    setNextCursors((prev) => [...prev, result.data.nextCursor]);
    setCurrentPage(page);
  }

  const pageRows = pages[currentPage - 1] ?? [];
  const hasMore = nextCursors[currentPage - 1] != null;

  const searchTerm = searchInput.trim().toLowerCase();
  const rows =
    searchTerm.length === 0
      ? pageRows
      : pageRows.filter((c) => {
          const haystack = [contentDisplayTitle(c), c.partnerDisplayName, c.campaignName, ...c.currentLinks.map((l) => platformLabel(l.platform)), ...c.regionIds]
            .filter(Boolean)
            .join(" ")
            .toLowerCase();
          return haystack.includes(searchTerm);
        });

  function openContent(contentRef: string) {
    router.push(`/content/${contentRef}`);
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
        <select aria-label="Filter status" value={status} onChange={(e) => refetchForStatus(e.target.value as ContentStatus | "all")}>
          <option value="all">All statuses</option>
          {CONTENT_STATUSES.map((s) => (
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
        Searches the Content currently loaded on this page.
      </p>

      {error && (
        <div className="banner" role="alert" style={{ margin: "0 18px 15px" }}>
          <b>Couldn&rsquo;t load Content.</b> {error}
        </div>
      )}

      {loading ? (
        <div style={{ padding: "0 18px 18px" }}>
          <Skeleton lines={5} />
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          title={anyFilterActive ? "No matching Content" : "No Content in scope yet"}
          description={anyFilterActive ? "Try a different search, or clear filters." : "Content you're authorized to see will appear here."}
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
        <RecordCards rows={rows} onOpen={openContent} compact={density} />
      ) : (
        <RecordTable rows={rows} onOpen={openContent} compact={density} />
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

function recordLabel(c: ContentDto): string {
  return contentDisplayTitle(c);
}

// Step 11A.1: Content no longer has one fixed platform/contentType at
// its root (links carry their own platform per row) - derive a truthful
// Context column from the current link count + revision number instead
// of inventing fake data.
function contextLabel(c: ContentDto): string {
  if (c.currentLinks.length === 0) return "No links yet";
  const linkWord = c.currentLinks.length === 1 ? "link" : "links";
  return `${c.currentLinks.length} ${linkWord} · rev ${c.currentRevisionNumber}`;
}

function RecordCards({ rows, onOpen, compact }: { rows: ContentDto[]; onOpen: (contentRef: string) => void; compact: boolean }) {
  return (
    <div className="recordgrid">
      {rows.map((c) => (
        <article className="record" key={c.contentRef}>
          <button className="rowlink person" type="button" onClick={() => onOpen(c.contentRef)}>
            <span className="avatar">{initialsOf(recordLabel(c))}</span>
            <span>
              <b>{recordLabel(c)}</b>
              {!compact && <small>{c.partnerDisplayName ?? "Unknown Partner"}</small>}
            </span>
          </button>
          <div style={{ marginTop: 13 }}>
            <Pill tone={statusTone(c.status)}>{STATUS_LABELS[c.status]}</Pill>
          </div>
          <div className="recordmeta">
            <span>{c.regionIds[0] ?? "No region"}</span>
            <span>{c.ownerDisplayName ?? "Unassigned"}</span>
          </div>
        </article>
      ))}
    </div>
  );
}

function RecordTable({ rows, onOpen, compact }: { rows: ContentDto[]; onOpen: (contentRef: string) => void; compact: boolean }) {
  return (
    <div className="tablewrap">
      <table className={compact ? "compact" : ""}>
        <caption className="sr">Content workspace</caption>
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
          {rows.map((c) => (
            <tr key={c.contentRef}>
              <td>
                <button className="rowlink person" type="button" onClick={() => onOpen(c.contentRef)}>
                  <span className="avatar">{initialsOf(recordLabel(c))}</span>
                  <span>
                    <b>{recordLabel(c)}</b>
                    <small>{c.partnerDisplayName ?? "Unknown Partner"}</small>
                  </span>
                </button>
              </td>
              <td>
                <Pill tone={statusTone(c.status)}>{STATUS_LABELS[c.status]}</Pill>
              </td>
              <td>{contextLabel(c)}</td>
              <td>{c.regionIds[0] ?? "—"}</td>
              <td>{c.ownerDisplayName ?? "Unassigned"}</td>
              <td>
                <button className="iconbutton" aria-label={`Inspect ${recordLabel(c)}`} type="button" onClick={() => onOpen(c.contentRef)}>
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
