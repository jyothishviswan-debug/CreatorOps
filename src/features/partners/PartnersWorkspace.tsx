"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { Toolbar, SearchInput } from "@/ui/Table";
import { Pill } from "@/ui/Badge";
import { EmptyState, Skeleton } from "@/ui/States";
import { Icon } from "@/ui/icons";
import { initialsOf } from "@/features/shared/types";
import { Pager } from "@/features/administration/Pager";
import type { PartnerDto } from "@/server/partners/client-dto";
import type { PartnerListCursor } from "@/server/partners/firestore";
import { PARTNER_STATUSES, type PartnerStatus } from "@/server/partners/types";
import { TARGET_AUDIENCES, type TargetAudience } from "@/server/discovery/types";
import { listPartners } from "./api-client";
import { STATUS_LABELS, statusTone } from "./format";

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

export function PartnersWorkspace({ initialPartners, initialNextCursor }: { initialPartners: PartnerDto[]; initialNextCursor: PartnerListCursor | null }) {
  const router = useRouter();
  const [pages, setPages] = useState<PartnerDto[][]>([initialPartners]);
  const [nextCursors, setNextCursors] = useState<(PartnerListCursor | null)[]>([initialNextCursor]);
  const [currentPage, setCurrentPage] = useState(1);

  const [searchInput, setSearchInput] = useState("");
  const [regionInput, setRegionInput] = useState("");
  const [tierInput, setTierInput] = useState("");
  const search = useDebouncedValue(searchInput, DEBOUNCE_MS);
  const region = useDebouncedValue(regionInput, DEBOUNCE_MS);
  const tier = useDebouncedValue(tierInput, DEBOUNCE_MS);

  const [status, setStatus] = useState<PartnerStatus | "all">("all");
  const [targetAudience, setTargetAudience] = useState<TargetAudience | "all">("all");
  const [assignedToMe, setAssignedToMe] = useState(false);
  const [pendingSetup, setPendingSetup] = useState(false);
  const [layout, setLayout] = useState<"table" | "cards">("table");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const skippedFirstEffect = useRef(false);

  const filters = {
    status: status === "all" ? undefined : status,
    region: region.trim() || undefined,
    tier: tier.trim() || undefined,
    targetAudience: targetAudience === "all" ? undefined : targetAudience,
    assignedToMe: assignedToMe || undefined,
    displayNamePrefix: search.trim() || undefined,
    pendingPartnerAccountSetup: pendingSetup || undefined,
  };

  useEffect(() => {
    // The initial page already arrived server-rendered as props (no
    // protected-data flash) - skip the redundant first fetch and only
    // re-query when a filter actually changes. Every filter here
    // auto-applies - there is no separate Apply button.
    if (!skippedFirstEffect.current) {
      skippedFirstEffect.current = true;
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    listPartners({ limit: PAGE_SIZE, ...filters }).then((result) => {
      if (cancelled) return;
      setLoading(false);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setPages([result.data.partners]);
      setNextCursors([result.data.nextCursor]);
      setCurrentPage(1);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, region, tier, targetAudience, assignedToMe, search, pendingSetup]);

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
    const result = await listPartners({ limit: PAGE_SIZE, cursor, ...filters });
    setLoading(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setPages((prev) => [...prev, result.data.partners]);
    setNextCursors((prev) => [...prev, result.data.nextCursor]);
    setCurrentPage(page);
  }

  const rows = pages[currentPage - 1] ?? [];
  const hasMore = nextCursors[currentPage - 1] != null;

  function openPartner(partnerRef: string) {
    router.push(`/partners/${partnerRef}`);
  }

  function clearFilters() {
    setSearchInput("");
    setRegionInput("");
    setTierInput("");
    setStatus("all");
    setTargetAudience("all");
    setAssignedToMe(false);
    setPendingSetup(false);
  }

  const anyFilterActive = Boolean(searchInput || regionInput || tierInput || status !== "all" || targetAudience !== "all" || assignedToMe || pendingSetup);

  return (
    <section className="panel">
      <Toolbar>
        <SearchInput placeholder="Search partners by name…" aria-label="Search partners by name" value={searchInput} onChange={(e) => setSearchInput(e.target.value)} />
        <select aria-label="Filter status" value={status} onChange={(e) => setStatus(e.target.value as PartnerStatus | "all")}>
          <option value="all">All statuses</option>
          {PARTNER_STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABELS[s]}
            </option>
          ))}
        </select>
        <select aria-label="Filter target audience" value={targetAudience} onChange={(e) => setTargetAudience(e.target.value as TargetAudience | "all")}>
          <option value="all">All target audiences</option>
          {TARGET_AUDIENCES.map((ta) => (
            <option key={ta} value={ta}>
              {ta}
            </option>
          ))}
        </select>
        <input type="text" aria-label="Filter region" placeholder="Region…" value={regionInput} onChange={(e) => setRegionInput(e.target.value)} style={{ maxWidth: 140 }} />
        <input type="text" aria-label="Filter tier" placeholder="Tier…" value={tierInput} onChange={(e) => setTierInput(e.target.value)} style={{ maxWidth: 140 }} />
        <button type="button" className={assignedToMe ? "btn primary" : "btn"} aria-pressed={assignedToMe} onClick={() => setAssignedToMe((v) => !v)}>
          {assignedToMe && <Icon name="check" />} Assigned to me
        </button>
        <button type="button" className={pendingSetup ? "btn primary" : "btn"} aria-pressed={pendingSetup} onClick={() => setPendingSetup((v) => !v)}>
          {pendingSetup && <Icon name="check" />} Needs account setup
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
          <b>Couldn&rsquo;t load partners.</b> {error}
        </div>
      )}

      {loading ? (
        <div style={{ padding: "0 18px 18px" }}>
          <Skeleton lines={5} />
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          title={anyFilterActive ? "No matching Partners" : "No Partners in scope yet"}
          description={anyFilterActive ? "Try a different search, or clear filters." : "Partners you're authorized to see will appear here."}
          icon={anyFilterActive ? "search" : "users"}
          action={
            anyFilterActive ? (
              <button className="btn" type="button" onClick={clearFilters}>
                Clear filters
              </button>
            ) : undefined
          }
        />
      ) : layout === "cards" ? (
        <RecordCards rows={rows} onOpen={openPartner} />
      ) : (
        <RecordTable rows={rows} onOpen={openPartner} />
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

function RecordCards({ rows, onOpen }: { rows: PartnerDto[]; onOpen: (partnerRef: string) => void }) {
  return (
    <div className="recordgrid">
      {rows.map((partner) => (
        <article className="record" key={partner.partnerRef}>
          <button className="rowlink person" type="button" onClick={() => onOpen(partner.partnerRef)}>
            <span className="avatar">{initialsOf(partner.displayName)}</span>
            <span>
              <b>{partner.displayName}</b>
              <small>{partner.targetAudience ?? "Target Audience not tagged"}</small>
            </span>
          </button>
          <div style={{ marginTop: 13 }}>
            <Pill tone={statusTone(partner.status)}>{STATUS_LABELS[partner.status]}</Pill>
            {partner.pendingPartnerAccountSetup && <Pill tone="orange"> Setup pending</Pill>}
          </div>
          <div className="recordmeta">
            <span>{partner.regionIds[0] ?? "No region"}</span>
            <span>{partner.ownerDisplayName ?? "Unassigned"}</span>
          </div>
        </article>
      ))}
    </div>
  );
}

function RecordTable({ rows, onOpen }: { rows: PartnerDto[]; onOpen: (partnerRef: string) => void }) {
  return (
    <div className="tablewrap">
      <table>
        <caption className="sr">Partners workspace</caption>
        <thead>
          <tr>
            <th>Partner</th>
            <th>Status</th>
            <th>Target Audience</th>
            <th>Region</th>
            <th>Owner</th>
            <th>
              <span className="sr">Action</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((partner, i) => (
            <tr key={partner.partnerRef}>
              <td>
                <button className="rowlink person" type="button" onClick={() => onOpen(partner.partnerRef)}>
                  <span className="avatar" style={{ background: ROW_TINTS[i % ROW_TINTS.length] }}>
                    {initialsOf(partner.displayName)}
                  </span>
                  <span>
                    <b>{partner.displayName}</b>
                    <small>{partner.tier ?? "No tier on file"}{partner.pendingPartnerAccountSetup ? " · setup pending" : ""}</small>
                  </span>
                </button>
              </td>
              <td>
                <Pill tone={statusTone(partner.status)}>{STATUS_LABELS[partner.status]}</Pill>
              </td>
              <td>
                <Pill tone={partner.targetAudience ? "default" : "red"}>{partner.targetAudience ?? "Not tagged"}</Pill>
              </td>
              <td>{partner.regionIds[0] ?? "—"}</td>
              <td>{partner.ownerDisplayName ?? "Unassigned"}</td>
              <td>
                <button className="iconbutton" aria-label={`Inspect ${partner.displayName}`} type="button" onClick={() => onOpen(partner.partnerRef)}>
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
