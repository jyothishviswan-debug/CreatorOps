"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { Toolbar, SearchInput } from "@/ui/Table";
import { Pill } from "@/ui/Badge";
import { EmptyState, Skeleton } from "@/ui/States";
import { Icon } from "@/ui/icons";
import { initialsOf } from "@/features/shared/types";
import { Pager } from "@/features/administration/Pager";
import type { LeadDto } from "@/server/discovery/client-dto";
import type { LeadListCursor } from "@/server/discovery/firestore";
import { LEAD_LIFECYCLE_STATES, type LeadLifecycle } from "@/server/discovery/types";
import { listLeads } from "./api-client";
import { LIFECYCLE_LABELS, lifecycleTone } from "./format";

const ROW_TINTS = ["#f5e9e1", "#e6edf5", "#f0eafa"];
const PAGE_SIZE = 10;
const DEBOUNCE_MS = 300;

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timeout = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timeout);
  }, [value, delayMs]);
  return debounced;
}

export function DiscoveryWorkspace({ initialLeads, initialNextCursor }: { initialLeads: LeadDto[]; initialNextCursor: LeadListCursor | null }) {
  const router = useRouter();
  // pages[i] is page i+1's rows; nextCursors[i] is the cursor to fetch
  // page i+2 - same cache/pagination discipline as
  // AdministrationUsersWorkspace.tsx.
  const [pages, setPages] = useState<LeadDto[][]>([initialLeads]);
  const [nextCursors, setNextCursors] = useState<(LeadListCursor | null)[]>([initialNextCursor]);
  const [currentPage, setCurrentPage] = useState(1);

  const [searchInput, setSearchInput] = useState("");
  const [regionInput, setRegionInput] = useState("");
  const [platformInput, setPlatformInput] = useState("");
  const search = useDebouncedValue(searchInput, DEBOUNCE_MS);
  const region = useDebouncedValue(regionInput, DEBOUNCE_MS);
  const platform = useDebouncedValue(platformInput, DEBOUNCE_MS);

  const [lifecycle, setLifecycle] = useState<LeadLifecycle | "all">("all");
  const [assignedToMe, setAssignedToMe] = useState(false);
  const [followUpDue, setFollowUpDue] = useState(false);
  const [layout, setLayout] = useState<"table" | "cards">("table");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const skippedFirstEffect = useRef(false);

  const filters = {
    lifecycle: lifecycle === "all" ? undefined : lifecycle,
    region: region.trim() || undefined,
    platform: platform.trim() || undefined,
    assignedToMe: assignedToMe || undefined,
    search: search.trim() || undefined,
    followUpDue: followUpDue || undefined,
  };

  useEffect(() => {
    // The initial page already arrived server-rendered as props (no
    // protected-data flash) - skip the redundant first fetch and only
    // re-query when a filter actually changes. Every filter here
    // auto-applies (search/region/platform debounced above) - there is
    // no separate Apply button.
    if (!skippedFirstEffect.current) {
      skippedFirstEffect.current = true;
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    listLeads({ limit: PAGE_SIZE, ...filters }).then((result) => {
      if (cancelled) return;
      setLoading(false);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setPages([result.data.leads]);
      setNextCursors([result.data.nextCursor]);
      setCurrentPage(1);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lifecycle, region, platform, assignedToMe, search, followUpDue]);

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
    const result = await listLeads({ limit: PAGE_SIZE, cursor, ...filters });
    setLoading(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setPages((prev) => [...prev, result.data.leads]);
    setNextCursors((prev) => [...prev, result.data.nextCursor]);
    setCurrentPage(page);
  }

  const rows = pages[currentPage - 1] ?? [];
  const hasMore = nextCursors[currentPage - 1] != null;

  function openLead(leadRef: string) {
    router.push(`/discovery/${leadRef}`);
  }

  function clearFilters() {
    setSearchInput("");
    setRegionInput("");
    setPlatformInput("");
    setLifecycle("all");
    setAssignedToMe(false);
    setFollowUpDue(false);
  }

  const anyFilterActive = Boolean(searchInput || regionInput || platformInput || lifecycle !== "all" || assignedToMe || followUpDue);

  return (
    <section className="panel">
      <Toolbar>
        <SearchInput placeholder="Search leads by name…" aria-label="Search leads by name" value={searchInput} onChange={(e) => setSearchInput(e.target.value)} />
        <select aria-label="Filter lifecycle" value={lifecycle} onChange={(e) => setLifecycle(e.target.value as LeadLifecycle | "all")}>
          <option value="all">All lifecycle states</option>
          {LEAD_LIFECYCLE_STATES.map((state) => (
            <option key={state} value={state}>
              {LIFECYCLE_LABELS[state]}
            </option>
          ))}
        </select>
        <input type="text" aria-label="Filter region" placeholder="Region…" value={regionInput} onChange={(e) => setRegionInput(e.target.value)} style={{ maxWidth: 140 }} />
        <input type="text" aria-label="Filter platform" placeholder="Platform…" value={platformInput} onChange={(e) => setPlatformInput(e.target.value)} style={{ maxWidth: 140 }} />
        <button type="button" className="btn" aria-pressed={assignedToMe} onClick={() => setAssignedToMe((v) => !v)}>
          Assigned to me
        </button>
        <button type="button" className="btn" aria-pressed={followUpDue} onClick={() => setFollowUpDue((v) => !v)}>
          Follow-up due
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

      {error && (
        <div className="banner" role="alert" style={{ margin: "0 18px 15px" }}>
          <b>Couldn&rsquo;t load leads.</b> {error}
        </div>
      )}

      {loading ? (
        <div style={{ padding: "0 18px 18px" }}>
          <Skeleton lines={5} />
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          title={anyFilterActive ? "No matching Leads" : "No Leads in scope yet"}
          description={anyFilterActive ? "Try a different search, or clear filters." : "Leads you're authorized to see will appear here."}
          action={
            anyFilterActive ? (
              <button className="btn" type="button" onClick={clearFilters}>
                Clear filters
              </button>
            ) : undefined
          }
        />
      ) : layout === "cards" ? (
        <RecordCards rows={rows} onOpen={openLead} />
      ) : (
        <RecordTable rows={rows} onOpen={openLead} />
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

function RecordCards({ rows, onOpen }: { rows: LeadDto[]; onOpen: (leadRef: string) => void }) {
  return (
    <div className="recordgrid">
      {rows.map((lead) => (
        <article className="record" key={lead.leadRef}>
          <button className="rowlink person" type="button" onClick={() => onOpen(lead.leadRef)}>
            <span className="avatar">{initialsOf(lead.displayName)}</span>
            <span>
              <b>{lead.displayName}</b>
              <small>{lead.platform ?? "No platform on file"}</small>
            </span>
          </button>
          <div style={{ marginTop: 13 }}>
            <Pill tone={lifecycleTone(lead.lifecycle)}>{LIFECYCLE_LABELS[lead.lifecycle]}</Pill>
          </div>
          <div className="recordmeta">
            <span>{lead.region ?? "No region"}</span>
            <span>{lead.ownerDisplayName ?? "Unassigned"}</span>
          </div>
        </article>
      ))}
    </div>
  );
}

function RecordTable({ rows, onOpen }: { rows: LeadDto[]; onOpen: (leadRef: string) => void }) {
  return (
    <div className="tablewrap">
      <table>
        <caption className="sr">Discovery leads workspace</caption>
        <thead>
          <tr>
            <th>Lead</th>
            <th>Lifecycle</th>
            <th>Region</th>
            <th>Owner</th>
            <th>
              <span className="sr">Action</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((lead, i) => (
            <tr key={lead.leadRef}>
              <td>
                <button className="rowlink person" type="button" onClick={() => onOpen(lead.leadRef)}>
                  <span className="avatar" style={{ background: ROW_TINTS[i % ROW_TINTS.length] }}>
                    {initialsOf(lead.displayName)}
                  </span>
                  <span>
                    <b>{lead.displayName}</b>
                    <small>{lead.platform ?? "No platform on file"}</small>
                  </span>
                </button>
              </td>
              <td>
                <Pill tone={lifecycleTone(lead.lifecycle)}>{LIFECYCLE_LABELS[lead.lifecycle]}</Pill>
              </td>
              <td>{lead.region ?? "—"}</td>
              <td>{lead.ownerDisplayName ?? "Unassigned"}</td>
              <td>
                <button className="iconbutton" aria-label={`Inspect ${lead.displayName}`} type="button" onClick={() => onOpen(lead.leadRef)}>
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
