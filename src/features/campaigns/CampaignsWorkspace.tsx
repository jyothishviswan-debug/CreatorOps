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
import type { CampaignDto } from "@/server/campaigns/client-dto";
import type { CampaignListCursor } from "@/server/campaigns/firestore";
import { CAMPAIGN_STATUSES, type CampaignStatus } from "@/server/campaigns/types";
import { listCampaigns } from "./api-client";
import { dateLabel, platformLabel, STATUS_LABELS, statusTone } from "./format";

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

// Mirrors Vendors'/Partners' own Workspace exactly - only filters the
// real query layer (Step 8A.2 scoped list planner) can safely/correctly
// execute: search, status, platform, region, assigned-to-me. No
// client-side fetch-all-then-filter - every filter round-trips to
// /api/campaigns.
export function CampaignsWorkspace({ initialCampaigns, initialNextCursor }: { initialCampaigns: CampaignDto[]; initialNextCursor: CampaignListCursor | null }) {
  const router = useRouter();
  const [pages, setPages] = useState<CampaignDto[][]>([initialCampaigns]);
  const [nextCursors, setNextCursors] = useState<(CampaignListCursor | null)[]>([initialNextCursor]);
  const [currentPage, setCurrentPage] = useState(1);

  const [searchInput, setSearchInput] = useState("");
  const [regionFilter, setRegionFilter] = useState<string[]>([]);
  const [platformInput, setPlatformInput] = useState("");
  const search = useDebouncedValue(searchInput, DEBOUNCE_MS);
  const platform = useDebouncedValue(platformInput, DEBOUNCE_MS);

  const [status, setStatus] = useState<CampaignStatus | "all">("all");
  const [assignedToMe, setAssignedToMe] = useState(false);
  const [layout, setLayout] = useState<"table" | "cards">("table");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const skippedFirstEffect = useRef(false);

  const filters = {
    status: status === "all" ? undefined : status,
    region: regionFilter.length > 0 ? regionFilter : undefined,
    platform: platform.trim() || undefined,
    assignedToMe: assignedToMe || undefined,
    namePrefix: search.trim() || undefined,
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
    listCampaigns({ limit: PAGE_SIZE, ...filters }).then((result) => {
      if (cancelled) return;
      setLoading(false);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setPages([result.data.campaigns]);
      setNextCursors([result.data.nextCursor]);
      setCurrentPage(1);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, regionFilter, platform, assignedToMe, search]);

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
    const result = await listCampaigns({ limit: PAGE_SIZE, cursor, ...filters });
    setLoading(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setPages((prev) => [...prev, result.data.campaigns]);
    setNextCursors((prev) => [...prev, result.data.nextCursor]);
    setCurrentPage(page);
  }

  const rows = pages[currentPage - 1] ?? [];
  const hasMore = nextCursors[currentPage - 1] != null;

  function openCampaign(campaignRef: string) {
    router.push(`/campaigns/${campaignRef}`);
  }

  function clearFilters() {
    setSearchInput("");
    setRegionFilter([]);
    setPlatformInput("");
    setStatus("all");
    setAssignedToMe(false);
  }

  const anyFilterActive = Boolean(searchInput || regionFilter.length > 0 || platformInput || status !== "all" || assignedToMe);

  return (
    <section className="panel">
      <Toolbar>
        <SearchInput placeholder="Search campaigns by name…" aria-label="Search campaigns by name" value={searchInput} onChange={(e) => setSearchInput(e.target.value)} />
        <select aria-label="Filter status" value={status} onChange={(e) => setStatus(e.target.value as CampaignStatus | "all")}>
          <option value="all">All statuses</option>
          {CAMPAIGN_STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABELS[s]}
            </option>
          ))}
        </select>
        <input type="text" aria-label="Filter platform" placeholder="Platform…" value={platformInput} onChange={(e) => setPlatformInput(e.target.value)} style={{ maxWidth: 140 }} />
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
          <b>Couldn&rsquo;t load campaigns.</b> {error}
        </div>
      )}

      {loading ? (
        <div style={{ padding: "0 18px 18px" }}>
          <Skeleton lines={5} />
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          title={anyFilterActive ? "No matching Campaigns" : "No Campaigns in scope yet"}
          description={anyFilterActive ? "Try a different search, or clear filters." : "Campaigns you're authorized to see will appear here."}
          icon={anyFilterActive ? "search" : "flag"}
          action={
            anyFilterActive ? (
              <button className="btn" type="button" onClick={clearFilters}>
                Clear filters
              </button>
            ) : undefined
          }
        />
      ) : layout === "cards" ? (
        <RecordCards rows={rows} onOpen={openCampaign} />
      ) : (
        <RecordTable rows={rows} onOpen={openCampaign} />
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

function RecordCards({ rows, onOpen }: { rows: CampaignDto[]; onOpen: (campaignRef: string) => void }) {
  return (
    <div className="recordgrid">
      {rows.map((campaign) => (
        <article className="record" key={campaign.campaignRef}>
          <button className="rowlink person" type="button" onClick={() => onOpen(campaign.campaignRef)}>
            <span className="avatar">{initialsOf(campaign.name)}</span>
            <span>
              <b>{campaign.name}</b>
              <small>{dateLabel(campaign.startDate)} – {dateLabel(campaign.endDate)}</small>
            </span>
          </button>
          <div style={{ marginTop: 13 }}>
            <Pill tone={statusTone(campaign.status)}>{STATUS_LABELS[campaign.status]}</Pill>
          </div>
          <div className="recordmeta">
            <span>{campaign.regionIds[0] ?? "No region"}</span>
            <span>{campaign.ownerDisplayName ?? "Unassigned"}</span>
          </div>
        </article>
      ))}
    </div>
  );
}

function RecordTable({ rows, onOpen }: { rows: CampaignDto[]; onOpen: (campaignRef: string) => void }) {
  return (
    <div className="tablewrap">
      <table>
        <caption className="sr">Campaigns workspace</caption>
        <thead>
          <tr>
            <th>Campaign</th>
            <th>Status</th>
            <th>Platforms</th>
            <th>Dates</th>
            <th>Region</th>
            <th>Owner</th>
            <th>
              <span className="sr">Action</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((campaign, i) => (
            <tr key={campaign.campaignRef}>
              <td>
                <button className="rowlink person" type="button" onClick={() => onOpen(campaign.campaignRef)}>
                  <span className="avatar" style={{ background: ROW_TINTS[i % ROW_TINTS.length] }}>
                    {initialsOf(campaign.name)}
                  </span>
                  <span>
                    <b>{campaign.name}</b>
                    <small>{REVIEW_POLICY_SHORT(campaign.defaultReviewPolicy)}</small>
                  </span>
                </button>
              </td>
              <td>
                <Pill tone={statusTone(campaign.status)}>{STATUS_LABELS[campaign.status]}</Pill>
              </td>
              <td>{campaign.platforms.length > 0 ? campaign.platforms.map(platformLabel).join(", ") : "—"}</td>
              <td>
                {dateLabel(campaign.startDate)} – {dateLabel(campaign.endDate)}
              </td>
              <td>{campaign.regionIds[0] ?? "—"}</td>
              <td>{campaign.ownerDisplayName ?? "Unassigned"}</td>
              <td>
                <button className="iconbutton" aria-label={`Inspect ${campaign.name}`} type="button" onClick={() => onOpen(campaign.campaignRef)}>
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

function REVIEW_POLICY_SHORT(policy: CampaignDto["defaultReviewPolicy"]): string {
  return policy === "REVIEW_REQUIRED" ? "Review required" : "No pre/post review";
}
