"use client";

// Step 12F: the interactive controls of the Partners Analytics workspace - the
// Partner selector (filters, searchable combobox, selected chips) and the month
// selector. Both only ever change the URL (router push / replace): the URL is the
// one source of truth and the SERVER re-validates every value on every render, so
// nothing here is trusted and nothing is filtered in the browser.
//
// Built only from accepted foundation pieces: the shared TargetAudienceMultiSelect
// / RegionMultiSelect (canonical values, unchanged), the Explorer's `inputwrap`
// search field, `.searchresults` (a bounded, internally scrolling list), `.pill`
// chips, `.btn`, `.foundationnote` - no new CSS class.
//
// Keyboard: type to search (debounced, stale requests aborted); ArrowDown /
// ArrowUp move through the results (focus stays in the input via
// aria-activedescendant); Enter toggles the highlighted Partner; Escape closes
// the list with focus still in the input.
import { useEffect, useId, useOptimistic, useRef, useState, useTransition, type KeyboardEvent } from "react";
import { useRouter } from "next/navigation";

import { Icon } from "@/ui/icons";
import { SearchInput } from "@/ui/Table";
import { RegionMultiSelect } from "@/features/shared/RegionMultiSelect";
import { TargetAudienceMultiSelect } from "@/features/shared/TargetAudienceMultiSelect";
import type { TargetAudience } from "@/server/discovery/types";
import type { PartnerSearchResultDto, SelectedPartnerDto, WorkspaceMonthDto } from "@/server/analytics/partners-workspace-dto";
import { partnersWorkspacePath, type WorkspaceHrefState } from "@/server/analytics/partners-workspace-links";

import { searchAnalyticsWorkspacePartners } from "./api-client";

const SEARCH_DEBOUNCE_MS = 250;
const SEARCH_LIMIT = 10;

function identityLine(partner: { regions: string[]; targetAudience: string[] }): string {
  const parts = [partner.regions.length > 0 ? partner.regions.join(", ") : null, partner.targetAudience.length > 0 ? partner.targetAudience.join(", ") : null].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : "No region or Target Audience recorded";
}

export function PartnerSelectorPanel({ selected, limit, state }: { selected: SelectedPartnerDto[]; limit: number; state: WorkspaceHrefState }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [targetAudience, setTargetAudience] = useOptimistic<readonly TargetAudience[], readonly TargetAudience[]>(state.targetAudience, (_, next) => next);
  const [regions, setRegions] = useOptimistic<readonly string[], readonly string[]>(state.regions, (_, next) => next);

  const listId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<PartnerSearchResultDto[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [active, setActive] = useState(-1);

  const selectedRefs = state.partnerRefs;
  const atLimit = selectedRefs.length >= limit;
  const filterKey = `${targetAudience.join("|")}#${regions.join("|")}`;

  // Debounced, abortable, bounded server search. Every keystroke / filter change
  // cancels the previous request; state is only ever set from the async callback.
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setStatus("loading");
      const result = await searchAnalyticsWorkspacePartners({ q: query.trim() || undefined, targetAudience: [...targetAudience], region: [...regions], limit: SEARCH_LIMIT, signal: controller.signal });
      if (controller.signal.aborted) return;
      if (!result.ok) {
        setResults([]);
        setHasMore(false);
        setStatus("error");
        return;
      }
      setResults(result.data.partners);
      setHasMore(result.data.hasMore);
      setActive(-1);
      setStatus("ready");
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
    // filterKey stands for targetAudience + regions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, query, filterKey]);

  // Outside click closes the list.
  useEffect(() => {
    if (!open) return;
    function onOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, [open]);

  function go(next: Partial<WorkspaceHrefState>, mode: "push" | "replace" = "push") {
    const href = partnersWorkspacePath({ ...state, targetAudience, regions, ...next });
    startTransition(() => {
      if (next.targetAudience) setTargetAudience(next.targetAudience);
      if (next.regions) setRegions(next.regions);
      if (mode === "replace") router.replace(href, { scroll: false });
      else router.push(href, { scroll: false });
    });
  }

  function toggle(partner: PartnerSearchResultDto) {
    if (selectedRefs.includes(partner.ref)) go({ partnerRefs: selectedRefs.filter((ref) => ref !== partner.ref) });
    else if (!atLimit) go({ partnerRefs: [...selectedRefs, partner.ref] });
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!open) setOpen(true);
      else setActive((index) => Math.min(index + 1, results.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) => Math.max(index - 1, 0));
    } else if (event.key === "Enter") {
      if (open && active >= 0 && results[active]) {
        event.preventDefault();
        toggle(results[active]);
      }
    } else if (event.key === "Escape") {
      if (open) {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        setActive(-1);
      }
    }
  }

  const optionId = (index: number) => `${listId}-option-${index}`;
  const statusText =
    status === "loading" ? "Searching…" : status === "error" ? "Couldn’t search Partners. Try again." : status === "ready" && results.length === 0 ? "No matching Partners in your authorized scope" : status === "ready" && hasMore ? `Showing the first ${results.length} matches — keep typing to narrow` : status === "ready" ? `${results.length} Partner${results.length === 1 ? "" : "s"} found` : "";

  return (
    <div ref={containerRef}>
      <div className="actions" style={{ alignItems: "flex-start", marginBottom: 10 }}>
        <div role="group" aria-label="Target Audience filter" style={{ minWidth: 160, maxWidth: 220, flex: "1 1 160px" }}>
          <TargetAudienceMultiSelect value={[...targetAudience]} onChange={(next) => go({ targetAudience: next }, "replace")} />
        </div>
        <div role="group" aria-label="Region filter" style={{ minWidth: 160, maxWidth: 220, flex: "1 1 160px" }}>
          <RegionMultiSelect value={[...regions]} onChange={(next) => go({ regions: next }, "replace")} />
        </div>
        <SearchInput
          placeholder="Search Partners by name…"
          aria-label="Search Partners by name"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && active >= 0 ? optionId(active) : undefined}
          autoComplete="off"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
        />
      </div>
      <p className="foundationnote" style={{ margin: "0 0 8px" }}>
        Target Audience and region only narrow this Partner search. They never select Partners, change Analytics data or widen what you are authorized to see.
      </p>

      {open && (
        <div style={{ marginBottom: 10 }}>
          <div id={listId} role="listbox" aria-label="Partner search results" aria-multiselectable="true" className="searchresults" style={{ marginTop: 0, maxHeight: 240 }}>
            {results.map((partner, index) => {
              const isSelected = selectedRefs.includes(partner.ref);
              const blocked = !isSelected && atLimit;
              return (
                <button
                  key={partner.ref}
                  id={optionId(index)}
                  type="button"
                  role="option"
                  tabIndex={-1}
                  aria-selected={isSelected}
                  aria-disabled={blocked || undefined}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => toggle(partner)}
                  style={{ display: "block", width: "100%", background: index === active ? "var(--tint)" : undefined, opacity: blocked ? 0.55 : 1 }}
                >
                  <b style={{ display: "block" }}>
                    {isSelected && <Icon name="check" style={{ width: 13, height: 13, verticalAlign: "-2px", marginRight: 5 }} />}
                    {partner.displayName}
                  </b>
                  <small className="muted">{identityLine(partner)}</small>
                </button>
              );
            })}
          </div>
          <p className="foundationnote" role="status" style={{ margin: "6px 0 0" }}>
            {statusText}
            {atLimit && ` · Selection limit of ${limit} Partners reached`}
          </p>
        </div>
      )}

      <div>
        <div className="actions" style={{ justifyContent: "space-between", marginBottom: 6 }}>
          <span className="foundationnote">
            <b>Selected Partners</b> · {selected.length} of {limit} max
          </span>
          {selected.length > 0 && (
            <button type="button" className="btn ghost" onClick={() => go({ partnerRefs: [] })}>
              Clear all
            </button>
          )}
        </div>
        {selected.length === 0 ? (
          <p className="foundationnote" style={{ margin: 0 }}>
            No Partner selected yet. Search above, pick one Partner for its full monthly view, or several to compare them side by side.
          </p>
        ) : (
          <ul aria-label="Selected Partners" style={{ display: "flex", flexWrap: "wrap", gap: 6, margin: 0, padding: 0, listStyle: "none", maxHeight: 132, overflow: "auto" }}>
            {selected.map((partner) => (
              <li key={partner.ref} style={{ maxWidth: "100%" }}>
                <span className="pill gray" style={{ maxWidth: "100%" }}>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis" }} title={`${partner.displayName} — ${identityLine(partner)}`}>
                    {partner.displayName}
                  </span>
                  <button type="button" aria-label={`Remove ${partner.displayName}`} onClick={() => go({ partnerRefs: selectedRefs.filter((ref) => ref !== partner.ref) })} style={{ padding: "0 2px", fontSize: 13, lineHeight: 1, color: "inherit" }}>
                    ×
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ---- Month selector ---------------------------------------------------------------------------------------

export function MonthSelect({ month, state }: { month: WorkspaceMonthDto; state: WorkspaceHrefState }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [value, setValue] = useOptimistic<string, string>(month.resolved ?? "", (_, next) => next);
  const id = useId();

  if (month.options.length === 0) {
    return (
      <span className="foundationnote">
        <b>Reporting month</b> · {month.sourceLabel}
      </span>
    );
  }

  function choose(next: string | null) {
    startTransition(() => {
      if (next) setValue(next);
      router.push(partnersWorkspacePath({ ...state, month: next }), { scroll: false });
    });
  }

  return (
    <div className="actions">
      <label htmlFor={id} className="foundationnote">
        Reporting month
      </label>
      <select id={id} value={value} onChange={(event) => choose(event.target.value)} style={{ minWidth: 160 }}>
        {month.options.map((option) => (
          <option key={option.month} value={option.month}>
            {option.label}
            {option.hasData ? "" : " (no data)"}
          </option>
        ))}
      </select>
      <span className="pill gray" data-testid="month-source">
        {month.sourceLabel}
      </span>
      {month.source === "explicit" && (
        <button type="button" className="btn ghost" onClick={() => choose(null)}>
          Use latest month with data
        </button>
      )}
    </div>
  );
}
