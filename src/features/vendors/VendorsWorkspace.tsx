"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { Toolbar, SearchInput } from "@/ui/Table";
import { Pill } from "@/ui/Badge";
import { EmptyState, Skeleton } from "@/ui/States";
import { Icon } from "@/ui/icons";
import { initialsOf } from "@/features/shared/types";
import { Pager } from "@/features/administration/Pager";
import { RegionMultiSelect } from "@/features/shared/RegionMultiSelect";
import type { VendorDto } from "@/server/vendors/client-dto";
import type { VendorListCursor } from "@/server/vendors/firestore";
import { VENDOR_STATUSES, VENDOR_TYPES, type VendorStatus, type VendorType } from "@/server/vendors/types";
import { listVendors } from "./api-client";
import { STATUS_LABELS, statusTone, VENDOR_TYPE_LABELS } from "./format";

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

// Mirrors Partners' own PartnersWorkspace exactly - only filters the
// real query layer (Step 8A.2's scoped list planner) can safely/
// correctly execute: search, status, vendor type, region, assigned-to-
// me. No team filter (Partners' own Workspace doesn't expose one either -
// "only if already supported cleanly" from Step 8B section 2). No
// client-side fetch-all-then-filter - every filter round-trips to
// /api/vendors.
export function VendorsWorkspace({ initialVendors, initialNextCursor }: { initialVendors: VendorDto[]; initialNextCursor: VendorListCursor | null }) {
  const router = useRouter();
  const [pages, setPages] = useState<VendorDto[][]>([initialVendors]);
  const [nextCursors, setNextCursors] = useState<(VendorListCursor | null)[]>([initialNextCursor]);
  const [currentPage, setCurrentPage] = useState(1);

  const [searchInput, setSearchInput] = useState("");
  const [regionFilter, setRegionFilter] = useState<string[]>([]);
  const search = useDebouncedValue(searchInput, DEBOUNCE_MS);

  const [status, setStatus] = useState<VendorStatus | "all">("all");
  const [vendorType, setVendorType] = useState<VendorType | "all">("all");
  const [assignedToMe, setAssignedToMe] = useState(false);
  const [layout, setLayout] = useState<"table" | "cards">("table");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const skippedFirstEffect = useRef(false);

  const filters = {
    status: status === "all" ? undefined : status,
    region: regionFilter.length > 0 ? regionFilter : undefined,
    vendorType: vendorType === "all" ? undefined : vendorType,
    assignedToMe: assignedToMe || undefined,
    displayNamePrefix: search.trim() || undefined,
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
    listVendors({ limit: PAGE_SIZE, ...filters }).then((result) => {
      if (cancelled) return;
      setLoading(false);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setPages([result.data.vendors]);
      setNextCursors([result.data.nextCursor]);
      setCurrentPage(1);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, regionFilter, vendorType, assignedToMe, search]);

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
    const result = await listVendors({ limit: PAGE_SIZE, cursor, ...filters });
    setLoading(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setPages((prev) => [...prev, result.data.vendors]);
    setNextCursors((prev) => [...prev, result.data.nextCursor]);
    setCurrentPage(page);
  }

  const rows = pages[currentPage - 1] ?? [];
  const hasMore = nextCursors[currentPage - 1] != null;

  function openVendor(vendorRef: string) {
    router.push(`/vendors/${vendorRef}`);
  }

  function clearFilters() {
    setSearchInput("");
    setRegionFilter([]);
    setStatus("all");
    setVendorType("all");
    setAssignedToMe(false);
  }

  const anyFilterActive = Boolean(searchInput || regionFilter.length > 0 || status !== "all" || vendorType !== "all" || assignedToMe);

  return (
    <section className="panel">
      <Toolbar>
        <SearchInput placeholder="Search vendors by name…" aria-label="Search vendors by name" value={searchInput} onChange={(e) => setSearchInput(e.target.value)} />
        <select aria-label="Filter status" value={status} onChange={(e) => setStatus(e.target.value as VendorStatus | "all")}>
          <option value="all">All statuses</option>
          {VENDOR_STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABELS[s]}
            </option>
          ))}
        </select>
        <select aria-label="Filter vendor type" value={vendorType} onChange={(e) => setVendorType(e.target.value as VendorType | "all")}>
          <option value="all">All vendor types</option>
          {VENDOR_TYPES.map((t) => (
            <option key={t} value={t}>
              {VENDOR_TYPE_LABELS[t]}
            </option>
          ))}
        </select>
        <div style={{ minWidth: 160, maxWidth: 220 }}>
          <RegionMultiSelect value={regionFilter} onChange={setRegionFilter} />
        </div>
        <button type="button" className={assignedToMe ? "btn primary" : "btn"} aria-pressed={assignedToMe} onClick={() => setAssignedToMe((v) => !v)}>
          {assignedToMe && <Icon name="check" />} Assigned to me
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
          <b>Couldn&rsquo;t load vendors.</b> {error}
        </div>
      )}

      {loading ? (
        <div style={{ padding: "0 18px 18px" }}>
          <Skeleton lines={5} />
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          title={anyFilterActive ? "No matching Vendors" : "No Vendors in scope yet"}
          description={anyFilterActive ? "Try a different search, or clear filters." : "Vendors you're authorized to see will appear here."}
          icon={anyFilterActive ? "search" : "brief"}
          action={
            anyFilterActive ? (
              <button className="btn" type="button" onClick={clearFilters}>
                Clear filters
              </button>
            ) : undefined
          }
        />
      ) : layout === "cards" ? (
        <RecordCards rows={rows} onOpen={openVendor} />
      ) : (
        <RecordTable rows={rows} onOpen={openVendor} />
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

function RecordCards({ rows, onOpen }: { rows: VendorDto[]; onOpen: (vendorRef: string) => void }) {
  return (
    <div className="recordgrid">
      {rows.map((vendor) => (
        <article className="record" key={vendor.vendorRef}>
          <button className="rowlink person" type="button" onClick={() => onOpen(vendor.vendorRef)}>
            <span className="avatar">{initialsOf(vendor.displayName)}</span>
            <span>
              <b>{vendor.displayName}</b>
              <small>{VENDOR_TYPE_LABELS[vendor.vendorType]}</small>
            </span>
          </button>
          <div style={{ marginTop: 13 }}>
            <Pill tone={statusTone(vendor.status)}>{STATUS_LABELS[vendor.status]}</Pill>
          </div>
          <div className="recordmeta">
            <span>{vendor.regionIds[0] ?? "No region"}</span>
            <span>{vendor.ownerDisplayName ?? "Unassigned"}</span>
          </div>
        </article>
      ))}
    </div>
  );
}

function RecordTable({ rows, onOpen }: { rows: VendorDto[]; onOpen: (vendorRef: string) => void }) {
  return (
    <div className="tablewrap">
      <table>
        <caption className="sr">Vendors workspace</caption>
        <thead>
          <tr>
            <th>Vendor</th>
            <th>Status</th>
            <th>Type</th>
            <th>Region</th>
            <th>Owner</th>
            <th>
              <span className="sr">Action</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((vendor, i) => (
            <tr key={vendor.vendorRef}>
              <td>
                <button className="rowlink person" type="button" onClick={() => onOpen(vendor.vendorRef)}>
                  <span className="avatar" style={{ background: ROW_TINTS[i % ROW_TINTS.length] }}>
                    {initialsOf(vendor.displayName)}
                  </span>
                  <span>
                    <b>{vendor.displayName}</b>
                    <small>{vendor.legalName ?? "No legal name on file"}</small>
                  </span>
                </button>
              </td>
              <td>
                <Pill tone={statusTone(vendor.status)}>{STATUS_LABELS[vendor.status]}</Pill>
              </td>
              <td>{VENDOR_TYPE_LABELS[vendor.vendorType]}</td>
              <td>{vendor.regionIds[0] ?? "—"}</td>
              <td>{vendor.ownerDisplayName ?? "Unassigned"}</td>
              <td>
                <button className="iconbutton" aria-label={`Inspect ${vendor.displayName}`} type="button" onClick={() => onOpen(vendor.vendorRef)}>
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
