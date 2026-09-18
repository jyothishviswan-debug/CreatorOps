"use client";

import { useState } from "react";

import { Pill } from "@/ui/Badge";
import { Icon } from "@/ui/icons";
import { EmptyState, Skeleton } from "@/ui/States";
import { SearchInput, Toolbar } from "@/ui/Table";
import { Pager } from "@/features/administration/Pager";
import type { AnalyticsLabelMaps } from "@/server/analytics/label-resolution";
import type { AnalyticsSourceRecordListCursor } from "@/server/analytics/firestore";
import type { AnalyticsChannelSourceRecordDoc, AnalyticsContentSourceRecordDoc, AnalyticsMatchState } from "@/server/analytics/types";

import { AnalyticsRecordDialog } from "./AnalyticsRecordDialog";
import { AnalyticsResolveMatchDialog } from "./AnalyticsResolveMatchDialog";
import { listAnalyticsRecords, resolveAnalyticsLabels } from "./api-client";
import { channelRecordLabel, channelScopeLabel, collectChannelLabelRefs, collectContentLabelRefs, contentRecordLabel, contentScopeLabel, sourceLabel } from "./explorer-helpers";
import { matchStateLabel, matchStateTone, platformLabel } from "./format";

const PAGE_SIZE = 20;
const PLATFORM_OPTIONS = ["instagram", "youtube", "tiktok"];

export type ExplorerRecord = AnalyticsContentSourceRecordDoc | AnalyticsChannelSourceRecordDoc;

type Filters = { matchState?: AnalyticsMatchState; platform?: string; batchRef?: string; matchedCampaignRef?: string; matchedPartnerRef?: string; matchedPartnerAccountRef?: string; matchedContentRef?: string };

function mergeLabels(a: AnalyticsLabelMaps, b: AnalyticsLabelMaps): AnalyticsLabelMaps {
  return {
    content: { ...a.content, ...b.content },
    campaigns: { ...a.campaigns, ...b.campaigns },
    partners: { ...a.partners, ...b.partners },
    partnerAccounts: { ...a.partnerAccounts, ...b.partnerAccounts },
    batches: { ...a.batches, ...b.batches },
  };
}

export function AnalyticsExplorerWorkspace({
  initialRecordKind,
  initialRecords,
  initialNextCursor,
  initialFilters,
  initialLabels,
  actorCanResolve,
}: {
  initialRecordKind: "content" | "channel";
  initialRecords: ExplorerRecord[];
  initialNextCursor: AnalyticsSourceRecordListCursor | null;
  initialFilters: Filters;
  initialLabels: AnalyticsLabelMaps;
  actorCanResolve: boolean;
}) {
  const [recordKind, setRecordKind] = useState(initialRecordKind);
  const [pages, setPages] = useState<ExplorerRecord[][]>([initialRecords]);
  const [nextCursors, setNextCursors] = useState<(AnalyticsSourceRecordListCursor | null)[]>([initialNextCursor]);
  const [currentPage, setCurrentPage] = useState(1);
  const [labels, setLabels] = useState<AnalyticsLabelMaps>(initialLabels);

  const [filters, setFilters] = useState<Filters>(initialFilters);
  const [showSecondary, setShowSecondary] = useState(false);
  const [searchInput, setSearchInput] = useState("");
  const [density, setDensity] = useState(false);
  const [layout, setLayout] = useState<"table" | "cards">("table");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [inspectRecord, setInspectRecord] = useState<ExplorerRecord | null>(null);
  const [resolveRecord, setResolveRecord] = useState<ExplorerRecord | null>(null);

  async function fetchLabelsFor(kind: "content" | "channel", records: ExplorerRecord[]) {
    const refs = kind === "content" ? collectContentLabelRefs(records as AnalyticsContentSourceRecordDoc[]) : collectChannelLabelRefs(records as AnalyticsChannelSourceRecordDoc[]);
    const result = await resolveAnalyticsLabels(refs);
    if (result.ok) setLabels((prev) => mergeLabels(prev, result.data));
  }

  async function runQuery(kind: "content" | "channel", nextFilters: Filters, cursor?: AnalyticsSourceRecordListCursor) {
    setLoading(true);
    setError(null);
    const result = await listAnalyticsRecords({ recordKind: kind, limit: PAGE_SIZE, cursor, ...nextFilters });
    setLoading(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    return result.data;
  }

  async function refetchFromStart(kind: "content" | "channel", nextFilters: Filters) {
    setRecordKind(kind);
    setFilters(nextFilters);
    const data = await runQuery(kind, nextFilters);
    if (!data) return;
    setPages([data.records]);
    setNextCursors([data.nextCursor]);
    setCurrentPage(1);
    void fetchLabelsFor(kind, data.records);
  }

  async function goToPage(page: number) {
    if (page < 1 || page === currentPage) return;
    if (page <= pages.length) {
      setCurrentPage(page);
      return;
    }
    const cursor = nextCursors[page - 2];
    if (page > pages.length + 1 || cursor === undefined || cursor === null) return;
    const data = await runQuery(recordKind, filters, cursor);
    if (!data) return;
    setPages((prev) => [...prev, data.records]);
    setNextCursors((prev) => [...prev, data.nextCursor]);
    setCurrentPage(page);
    void fetchLabelsFor(recordKind, data.records);
  }

  function clearFilters() {
    setSearchInput("");
    void refetchFromStart(recordKind, {});
  }

  const pageRows = pages[currentPage - 1] ?? [];
  const hasMore = nextCursors[currentPage - 1] != null;

  const searchTerm = searchInput.trim().toLowerCase();
  const rows =
    searchTerm.length === 0
      ? pageRows
      : pageRows.filter((r) => {
          const label = recordKind === "content" ? contentRecordLabel(r as AnalyticsContentSourceRecordDoc, labels) : channelRecordLabel(r as AnalyticsChannelSourceRecordDoc, labels);
          const scope = recordKind === "content" ? contentScopeLabel(r as AnalyticsContentSourceRecordDoc, labels) : channelScopeLabel(r as AnalyticsChannelSourceRecordDoc, labels);
          const haystack = [label, scope, platformLabel(r.platform), matchStateLabel(r.matchState), r.sheetName].join(" ").toLowerCase();
          return haystack.includes(searchTerm);
        });

  const anyFilterActive = Boolean(searchInput || filters.matchState || filters.platform || filters.batchRef || filters.matchedCampaignRef || filters.matchedPartnerRef || filters.matchedPartnerAccountRef || filters.matchedContentRef);

  function recordKey(r: ExplorerRecord): string {
    return r.sourceRef;
  }

  return (
    <section className="panel" style={{ marginTop: 18 }}>
      <Toolbar>
        <div className="segment">
          <button type="button" className={recordKind === "content" ? "active" : ""} aria-pressed={recordKind === "content"} onClick={() => refetchFromStart("content", filters)}>
            Content analytics
          </button>
          <button type="button" className={recordKind === "channel" ? "active" : ""} aria-pressed={recordKind === "channel"} onClick={() => refetchFromStart("channel", filters)}>
            Channel analytics
          </button>
        </div>
        <SearchInput placeholder="Search loaded records…" aria-label="Search records" value={searchInput} onChange={(e) => setSearchInput(e.target.value)} />
        <select aria-label="Filter platform" value={filters.platform ?? "all"} onChange={(e) => refetchFromStart(recordKind, { ...filters, platform: e.target.value === "all" ? undefined : e.target.value })}>
          <option value="all">All platforms</option>
          {PLATFORM_OPTIONS.map((p) => (
            <option key={p} value={p}>
              {platformLabel(p)}
            </option>
          ))}
        </select>
        <select
          aria-label="Filter match state"
          value={filters.matchState ?? "all"}
          onChange={(e) => refetchFromStart(recordKind, { ...filters, matchState: e.target.value === "all" ? undefined : (e.target.value as AnalyticsMatchState) })}
        >
          <option value="all">All match states</option>
          <option value="MATCHED">Matched</option>
          <option value="UNMATCHED">Unmatched</option>
          <option value="AMBIGUOUS">Ambiguous</option>
        </select>
        <button type="button" className="btn" aria-expanded={showSecondary} onClick={() => setShowSecondary((v) => !v)}>
          More filters
        </button>
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

      {showSecondary && (
        <div className="panelbody" style={{ paddingTop: 0, paddingBottom: 14 }}>
          <p className="foundationnote" style={{ margin: "0 0 8px" }}>
            Additional server filters - reporting period isn&rsquo;t supported by the current Analytics list contract, so it isn&rsquo;t offered here.
          </p>
          <SecondaryFilterForm filters={filters} onApply={(next) => refetchFromStart(recordKind, next)} />
        </div>
      )}

      <p className="foundationnote" style={{ margin: "0 18px 14px" }}>
        Searches the Analytics records currently loaded on this page.
      </p>

      {error && (
        <div className="banner" role="alert" style={{ margin: "0 18px 15px" }}>
          <b>Couldn&rsquo;t load Analytics records.</b> {error}
        </div>
      )}

      {loading ? (
        <div style={{ padding: "0 18px 18px" }}>
          <Skeleton lines={5} />
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          title={anyFilterActive ? "No matching records" : "No source records in scope yet"}
          description={anyFilterActive ? "Try a different search, or clear filters." : "Analytics source records you're authorized to see will appear here once imported."}
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
        <RecordCards rows={rows} recordKind={recordKind} labels={labels} compact={density} onOpen={setInspectRecord} />
      ) : (
        <RecordTable rows={rows} recordKind={recordKind} labels={labels} compact={density} onOpen={setInspectRecord} />
      )}

      <div className="panelfoot">
        <span>
          Page {currentPage} · {rows.length} shown
        </span>
        <Pager currentPage={currentPage} knownPages={pages.length} hasMore={hasMore} busy={loading} onChange={goToPage} />
      </div>

      {inspectRecord && (
        <AnalyticsRecordDialog
          record={inspectRecord}
          recordKind={recordKind}
          labels={labels}
          open={Boolean(inspectRecord)}
          onClose={() => setInspectRecord(null)}
          actorCanResolve={actorCanResolve}
          onResolve={
            actorCanResolve && inspectRecord.matchState !== "MATCHED"
              ? () => {
                  setResolveRecord(inspectRecord);
                  setInspectRecord(null);
                }
              : undefined
          }
        />
      )}

      {resolveRecord && (
        <AnalyticsResolveMatchDialog
          key={resolveRecord.sourceRef}
          record={resolveRecord}
          recordKind={recordKind}
          open={Boolean(resolveRecord)}
          onClose={() => setResolveRecord(null)}
          onResolved={(updated) => {
            setPages((prev) => prev.map((page) => page.map((r) => (recordKey(r) === recordKey(resolveRecord) ? ({ ...r, matchState: updated.matchState, correctionRevision: updated.correctionRevision } as ExplorerRecord) : r))));
            setResolveRecord(null);
          }}
        />
      )}
    </section>
  );
}

function SecondaryFilterForm({ filters, onApply }: { filters: Filters; onApply: (next: Filters) => void }) {
  const [campaignRef, setCampaignRef] = useState(filters.matchedCampaignRef ?? "");
  const [partnerRef, setPartnerRef] = useState(filters.matchedPartnerRef ?? "");
  const [partnerAccountRef, setPartnerAccountRef] = useState(filters.matchedPartnerAccountRef ?? "");
  const [contentRef, setContentRef] = useState(filters.matchedContentRef ?? "");
  const [batchRef, setBatchRef] = useState(filters.batchRef ?? "");

  return (
    <form
      className="formgrid"
      onSubmit={(e) => {
        e.preventDefault();
        onApply({ ...filters, matchedCampaignRef: campaignRef || undefined, matchedPartnerRef: partnerRef || undefined, matchedPartnerAccountRef: partnerAccountRef || undefined, matchedContentRef: contentRef || undefined, batchRef: batchRef || undefined });
      }}
    >
      <label>
        Campaign ref
        <input value={campaignRef} onChange={(e) => setCampaignRef(e.target.value)} placeholder="campaignRef" />
      </label>
      <label>
        Partner ref
        <input value={partnerRef} onChange={(e) => setPartnerRef(e.target.value)} placeholder="partnerRef" />
      </label>
      <label>
        Partner Account ref
        <input value={partnerAccountRef} onChange={(e) => setPartnerAccountRef(e.target.value)} placeholder="partnerAccountRef" />
      </label>
      <label>
        Content ref
        <input value={contentRef} onChange={(e) => setContentRef(e.target.value)} placeholder="contentRef" />
      </label>
      <label>
        Import batch ref
        <input value={batchRef} onChange={(e) => setBatchRef(e.target.value)} placeholder="batchRef" />
      </label>
      <button type="submit" className="btn">
        Apply
      </button>
    </form>
  );
}

function RecordTable({
  rows,
  recordKind,
  labels,
  compact,
  onOpen,
}: {
  rows: ExplorerRecord[];
  recordKind: "content" | "channel";
  labels: AnalyticsLabelMaps;
  compact: boolean;
  onOpen: (r: ExplorerRecord) => void;
}) {
  return (
    <div className="tablewrap">
      <table className={compact ? "compact" : ""}>
        <caption className="sr">Analytics Explorer records</caption>
        <thead>
          <tr>
            <th>Record</th>
            <th>Match state</th>
            <th>Context</th>
            <th>Scope</th>
            <th>Source</th>
            <th>
              <span className="sr">Action</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const isContent = recordKind === "content";
            const label = isContent ? contentRecordLabel(r as AnalyticsContentSourceRecordDoc, labels) : channelRecordLabel(r as AnalyticsChannelSourceRecordDoc, labels);
            const scope = isContent ? contentScopeLabel(r as AnalyticsContentSourceRecordDoc, labels) : channelScopeLabel(r as AnalyticsChannelSourceRecordDoc, labels);
            return (
              <tr key={r.sourceRef}>
                <td>
                  <button className="rowlink person" type="button" onClick={() => onOpen(r)}>
                    <span>
                      <b>{label}</b>
                    </span>
                  </button>
                </td>
                <td>
                  <Pill tone={matchStateTone(r.matchState)}>{matchStateLabel(r.matchState)}</Pill>
                </td>
                <td>
                  {platformLabel(r.platform)} · {isContent ? "Content" : "Channel"} · {r.reportingPeriod ? `${r.reportingPeriod.start} – ${r.reportingPeriod.end}` : "Unknown period"}
                </td>
                <td>{scope}</td>
                <td>{sourceLabel(r, labels)}</td>
                <td>
                  <button className="iconbutton" aria-label={`Inspect ${label}`} type="button" onClick={() => onOpen(r)}>
                    &rsaquo;
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function RecordCards({
  rows,
  recordKind,
  labels,
  compact,
  onOpen,
}: {
  rows: ExplorerRecord[];
  recordKind: "content" | "channel";
  labels: AnalyticsLabelMaps;
  compact: boolean;
  onOpen: (r: ExplorerRecord) => void;
}) {
  return (
    <div className="recordgrid">
      {rows.map((r) => {
        const isContent = recordKind === "content";
        const label = isContent ? contentRecordLabel(r as AnalyticsContentSourceRecordDoc, labels) : channelRecordLabel(r as AnalyticsChannelSourceRecordDoc, labels);
        const metricLine = isContent
          ? (() => {
              const c = r as AnalyticsContentSourceRecordDoc;
              return c.likes !== null ? `${c.likes.toLocaleString("en-GB")} likes` : c.views !== null ? `${c.views.toLocaleString("en-GB")} views` : "No supported metric yet";
            })()
          : (() => {
              const c = r as AnalyticsChannelSourceRecordDoc;
              return c.profileFollowers !== null ? `${c.profileFollowers.toLocaleString("en-GB")} followers` : "No supported metric yet";
            })();
        return (
          <article className="record" key={r.sourceRef}>
            <button className="rowlink person" type="button" onClick={() => onOpen(r)}>
              <span>
                <b>{label}</b>
                {!compact && <small>{platformLabel(r.platform)}</small>}
              </span>
            </button>
            <div style={{ marginTop: 13 }}>
              <Pill tone={matchStateTone(r.matchState)}>{matchStateLabel(r.matchState)}</Pill>
            </div>
            <div className="recordmeta">
              <span>{r.reportingPeriod ? `${r.reportingPeriod.start} – ${r.reportingPeriod.end}` : "Unknown period"}</span>
              <span>{metricLine}</span>
            </div>
          </article>
        );
      })}
    </div>
  );
}
