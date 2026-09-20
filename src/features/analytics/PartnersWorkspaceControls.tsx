"use client";

// Step 12F / 12F.2: the interactive controls of the Partners Analytics workspace -
// the Partner selector (Target Audience | Region | ONE compact multi-select Partner
// search) and the month selector. Both only ever change the URL (router push /
// replace): the URL is the one source of truth and the SERVER re-validates every
// value on every render, so nothing here is trusted and nothing is filtered in the
// browser.
//
// The Partner search is ONE control: the field itself holds the selected Partners
// as compact removable chips (a few + "+N selected" when closed, all of them while
// open) and the search input after them; focusing / clicking it opens a bounded,
// internally scrolling dropdown directly beneath with "Select all shown", "Clear
// all", one checkbox row per authorized match (name, region, Target Audience) and
// the "N Partners found" line. It stays open while Partners are ticked and closes
// on an outside click or Escape. Nothing about the selection is rendered anywhere
// else on the page.
//
// Target Audience and Region only narrow that search: they never select, remove or
// reveal anything, and choosing EVERY option of one ("Select all") is the same as
// no filter (server-side, see narrowingRegions).
//
// Built only from accepted foundation pieces (the shared multi-selects, `.pill`
// chips, `.searchresults`, `.btn`, `.foundationnote`, `.sr`) - no new CSS class.
//
// Keyboard (combobox + multiselectable listbox): type to search (debounced, stale
// requests aborted); ArrowDown / ArrowUp move through the results with focus still
// in the input (aria-activedescendant); Enter toggles the highlighted Partner, and
// so does Space while nothing has been typed (once text is typed Space is a
// character - names contain spaces); Backspace on an empty field removes the last
// chip; Escape closes the dropdown. Chip remove and Clear all return focus to the
// input without re-opening the dropdown.
import { useEffect, useId, useOptimistic, useRef, useState, useSyncExternalStore, useTransition, type KeyboardEvent } from "react";
import { useRouter } from "next/navigation";

import { Icon } from "@/ui/icons";
import { RegionMultiSelect } from "@/features/shared/RegionMultiSelect";
import { TargetAudienceMultiSelect } from "@/features/shared/TargetAudienceMultiSelect";
import type { TargetAudience } from "@/server/discovery/types";
import type { PartnerSearchResultDto, SelectedPartnerDto, WorkspaceMonthDto } from "@/server/analytics/partners-workspace-dto";
import { partnersWorkspacePath, type WorkspaceHrefState } from "@/server/analytics/partners-workspace-links";

import { searchAnalyticsWorkspacePartners } from "./api-client";

const SEARCH_DEBOUNCE_MS = 250;
const SEARCH_LIMIT = 10;
// Chips shown while the control is closed; the rest collapse into "+N selected". Phones collapse harder.
const CLOSED_CHIPS_DESKTOP = 2;
const CLOSED_CHIPS_PHONE = 1;
const PHONE_QUERY = "(max-width: 480px)";

function subscribePhone(onChange: () => void) {
  const media = window.matchMedia(PHONE_QUERY);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}
function usePhone(): boolean {
  return useSyncExternalStore(
    subscribePhone,
    () => window.matchMedia(PHONE_QUERY).matches,
    () => false,
  );
}

function identityLine(partner: { regions: string[]; targetAudience: string[] }): string {
  const parts = [partner.regions.length > 0 ? partner.regions.join(", ") : null, partner.targetAudience.length > 0 ? partner.targetAudience.join(", ") : null].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : "No region or Target Audience recorded";
}

// A checkbox glyph for the dropdown rows. The row itself is the interactive
// element (role option / checkbox), so this is presentational only.
function CheckBox({ state }: { state: "on" | "off" | "mixed" }) {
  const filled = state !== "off";
  return (
    <span
      aria-hidden="true"
      style={{ width: 15, height: 15, flexShrink: 0, marginTop: 1, display: "inline-grid", placeItems: "center", borderRadius: 3, border: `1px solid ${filled ? "var(--orange)" : "#b9c1cb"}`, background: filled ? "var(--orange)" : "white", color: "white" }}
    >
      {state === "on" && <Icon name="check" style={{ width: 11, height: 11 }} />}
      {state === "mixed" && <span style={{ width: 7, height: 2, background: "white", borderRadius: 1 }} />}
    </span>
  );
}

export function PartnerSelectorPanel({ selected, limit, state }: { selected: SelectedPartnerDto[]; limit: number; state: WorkspaceHrefState }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [targetAudience, setTargetAudience] = useOptimistic<readonly TargetAudience[], readonly TargetAudience[]>(state.targetAudience, (_, next) => next);
  const [regions, setRegions] = useOptimistic<readonly string[], readonly string[]>(state.regions, (_, next) => next);

  const listId = useId();
  const controlRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Set right before a programmatic focus that must NOT open the dropdown (after a chip remove / Clear all).
  const quietFocus = useRef(false);
  const phone = usePhone();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [focused, setFocused] = useState(false);
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

  // Outside click closes the dropdown (the other filter dropdowns are outside the
  // control, so opening one of them closes this one).
  useEffect(() => {
    if (!open) return;
    function onOutside(event: MouseEvent) {
      if (controlRef.current && !controlRef.current.contains(event.target as Node)) setOpen(false);
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

  function focusInputQuietly() {
    quietFocus.current = true;
    inputRef.current?.focus();
    quietFocus.current = false;
  }

  function toggle(partner: PartnerSearchResultDto) {
    if (selectedRefs.includes(partner.ref)) go({ partnerRefs: selectedRefs.filter((ref) => ref !== partner.ref) });
    else if (!atLimit) go({ partnerRefs: [...selectedRefs, partner.ref] });
  }

  function removeChip(ref: string) {
    go({ partnerRefs: selectedRefs.filter((existing) => existing !== ref) });
    focusInputQuietly();
  }

  function clearAll() {
    go({ partnerRefs: [] });
    focusInputQuietly();
  }

  // "Select all shown" acts on the Partners listed right now (the search is
  // bounded, so this is never "every Partner"), and never past the selection cap.
  const shownRefs = results.map((partner) => partner.ref);
  const shownSelected = shownRefs.filter((ref) => selectedRefs.includes(ref)).length;
  const allShownSelected = shownRefs.length > 0 && shownSelected === shownRefs.length;
  const room = Math.max(0, limit - selectedRefs.length);

  function toggleAllShown() {
    if (shownRefs.length === 0) return;
    if (allShownSelected) {
      go({ partnerRefs: selectedRefs.filter((ref) => !shownRefs.includes(ref)) });
      return;
    }
    const add = shownRefs.filter((ref) => !selectedRefs.includes(ref)).slice(0, room);
    if (add.length > 0) go({ partnerRefs: [...selectedRefs, ...add] });
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!open) setOpen(true);
      else setActive((index) => Math.min(index + 1, results.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) => Math.max(index - 1, 0));
    } else if (event.key === "Enter" || (event.key === " " && query.length === 0)) {
      if (open && active >= 0 && results[active]) {
        event.preventDefault();
        toggle(results[active]);
      }
    } else if (event.key === "Backspace") {
      if (query.length === 0 && selected.length > 0) {
        event.preventDefault();
        go({ partnerRefs: selectedRefs.slice(0, -1) });
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
  const foundText =
    status === "loading"
      ? "Searching…"
      : status === "error"
        ? "Couldn’t search Partners. Try again."
        : status === "ready" && results.length === 0
          ? "No matching Partners in your authorized scope"
          : status === "ready" && hasMore
            ? `Showing the first ${results.length} matches — keep typing to narrow`
            : status === "ready"
              ? `${results.length} Partner${results.length === 1 ? "" : "s"} found`
              : "";

  // Closed: a few chips + "+N selected". Open: every chip, so any Partner can be removed.
  const closedChips = phone ? CLOSED_CHIPS_PHONE : CLOSED_CHIPS_DESKTOP;
  const visibleChips = open ? selected : selected.slice(0, closedChips);
  const hiddenChips = selected.length - visibleChips.length;

  return (
    <div>
      <div className="actions" style={{ alignItems: "flex-start", marginBottom: 6 }}>
        <div role="group" aria-label="Target Audience filter" style={{ minWidth: 160, maxWidth: 220, flex: "1 1 160px" }}>
          <TargetAudienceMultiSelect selectAll value={[...targetAudience]} onChange={(next) => go({ targetAudience: next }, "replace")} />
        </div>
        <div role="group" aria-label="Region filter" style={{ minWidth: 160, maxWidth: 220, flex: "1 1 160px" }}>
          <RegionMultiSelect selectAll value={[...regions]} onChange={(next) => go({ regions: next }, "replace")} />
        </div>

        <div ref={controlRef} style={{ position: "relative", flex: "1 1 320px", minWidth: "min(100%, 240px)", maxWidth: 640 }}>
          {/* The one control: chips, then the search input, then the count. Clicking anywhere in it focuses the input. */}
          <div
            onMouseDown={(event) => {
              if (event.target === inputRef.current || (event.target as HTMLElement).closest("button")) return;
              event.preventDefault();
              inputRef.current?.focus();
            }}
            style={{
              display: "flex",
              alignItems: "center",
              flexWrap: "wrap",
              gap: 4,
              minHeight: 36,
              maxHeight: open ? 76 : undefined,
              overflowY: open ? "auto" : undefined,
              padding: "3px 8px",
              background: "white",
              border: `1px solid ${focused || open ? "#e77c42" : "#dce1e7"}`,
              boxShadow: focused || open ? "0 0 0 2px #e77c4233" : undefined,
              borderRadius: 6,
              cursor: "text",
            }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true" style={{ width: 15, height: 15, color: "#8e98a5" }}>
              <circle cx="10" cy="10" r="6" />
              <path d="m15 15 6 6" />
            </svg>
            {/* display: contents lets the chips wrap in the control's own flow (the search input follows the last chip on the same line); the list keeps its role and label. */}
            {selected.length > 0 && (
              <ul aria-label="Selected Partners" role="list" style={{ display: "contents", listStyle: "none" }}>
                {visibleChips.map((partner) => (
                  <li key={partner.ref} style={{ maxWidth: "100%", minWidth: 0 }}>
                    <span className="pill gray" style={{ maxWidth: "100%" }}>
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", maxWidth: 130 }} title={`${partner.displayName} — ${identityLine(partner)}`}>
                        {partner.displayName}
                      </span>
                      <button type="button" aria-label={`Remove ${partner.displayName}`} onClick={() => removeChip(partner.ref)} style={{ padding: "0 2px", fontSize: 13, lineHeight: 1, color: "inherit" }}>
                        ×
                      </button>
                    </span>
                  </li>
                ))}
                {hiddenChips > 0 && (
                  <li>
                    <button type="button" className="pill gray" aria-label={`${hiddenChips} more selected Partners - show all`} onClick={() => inputRef.current?.focus()}>
                      +{hiddenChips} selected
                    </button>
                  </li>
                )}
              </ul>
            )}
            <input
              ref={inputRef}
              type="text"
              placeholder="Search and select Partners..."
              aria-label="Search and select Partners"
              role="combobox"
              aria-expanded={open}
              aria-controls={listId}
              aria-autocomplete="list"
              aria-haspopup="listbox"
              aria-activedescendant={open && active >= 0 ? optionId(active) : undefined}
              autoComplete="off"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setOpen(true);
              }}
              onFocus={() => {
                setFocused(true);
                if (!quietFocus.current) setOpen(true);
              }}
              onClick={() => setOpen(true)}
              onBlur={() => setFocused(false)}
              onKeyDown={onKeyDown}
              style={{ flex: "1 1 96px", minWidth: 72, border: 0, outline: "none", padding: "4px 2px", background: "transparent" }}
            />
            <small className="muted" style={{ marginLeft: "auto", whiteSpace: "nowrap", paddingLeft: 4 }}>
              {selected.length} / {limit}
            </small>
            <span className="sr" role="status">
              {selected.length} of {limit} Partners selected
            </span>
          </div>

          {open && (
            <div className="panel" style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0, zIndex: 20, padding: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4, paddingBottom: 4, borderBottom: "1px solid var(--line)" }}>
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={allShownSelected ? true : shownSelected > 0 ? "mixed" : false}
                  aria-label="Select all shown Partners"
                  disabled={shownRefs.length === 0 || (!allShownSelected && room === 0)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={toggleAllShown}
                  style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px", fontSize: 12, fontWeight: 600, textAlign: "left", opacity: shownRefs.length === 0 ? 0.55 : 1 }}
                >
                  <CheckBox state={allShownSelected ? "on" : shownSelected > 0 ? "mixed" : "off"} />
                  Select all shown
                </button>
                {selected.length > 0 && (
                  <button type="button" className="btn ghost" onMouseDown={(event) => event.preventDefault()} onClick={clearAll} style={{ marginLeft: "auto", minHeight: 28, padding: "2px 8px" }}>
                    Clear all
                  </button>
                )}
              </div>
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
                      title={blocked ? `Maximum ${limit} Partners` : undefined}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => toggle(partner)}
                      style={{ display: "flex", alignItems: "flex-start", gap: 8, width: "100%", padding: "7px 6px", background: index === active ? "var(--tint)" : undefined, opacity: blocked ? 0.55 : 1, cursor: blocked ? "not-allowed" : undefined }}
                    >
                      <CheckBox state={isSelected ? "on" : "off"} />
                      <span style={{ minWidth: 0 }}>
                        <b style={{ display: "block" }}>{partner.displayName}</b>
                        <small className="muted">{identityLine(partner)}</small>
                      </span>
                    </button>
                  );
                })}
              </div>
              <p className="foundationnote" role="status" style={{ margin: "6px 0 0" }}>
                {foundText}
                {atLimit && ` · Maximum ${limit} Partners selected - remove one to add another`}
                {!atLimit && !allShownSelected && shownRefs.length - shownSelected > room && ` · Select all shown adds ${room} more (limit ${limit})`}
              </p>
            </div>
          )}
        </div>
      </div>
      <p className="foundationnote" style={{ margin: 0 }}>
        Target Audience and region only narrow this Partner search. They never select Partners, change Analytics data or widen what you are authorized to see. Selecting every option of a filter is the same as no filter.
      </p>
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
