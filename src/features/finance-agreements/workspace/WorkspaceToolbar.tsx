"use client";

import type { KeyboardEvent } from "react";

import { Icon } from "@/ui/icons";
import { SearchInput, Toolbar } from "@/ui/Table";
import type { AgreementHeadStatus, CounterpartyType } from "@/server/finance-agreements/types";

import { formatPlatformName } from "../format";
import { CLEAR_FILTERS_LABEL, FILTER_LABELS } from "./workspace-copy";
import { COUNTERPARTY_FILTER_OPTIONS, isMonthPeriod, LIFECYCLE_FILTER_OPTIONS, PLATFORM_FILTER_OPTIONS, periodModeOf, type PeriodMode, type WorkspaceUrlState } from "./workspace-query";

export type WorkspaceLayout = "table" | "cards";

// Step 14B: the accepted `.toolbar` family for the Agreements workspace: a search-style Partner / Vendor filter (`.inputwrap`),
// select-style controls, an `aria-pressed` toggle and the `.segment` layout switch. Every control is labelled. The toolbar
// only REPORTS changes (onChange); the workspace turns them into URL state and the SERVER re-filters - nothing is filtered here.
// The `.toolbar` wraps (flex-wrap), and every control is capped at the container width so it can never overflow a narrow screen.
const FIT_STYLE = { maxWidth: "100%" } as const;

export type WorkspaceToolbarProps = {
  state: WorkspaceUrlState;
  searchText: string;
  onSearchText: (text: string) => void;
  onSearchCommit: () => void;
  onChange: (change: Partial<WorkspaceUrlState>) => void;
  // The current UTC month, used as the default when switching the period control to a month.
  defaultMonth: string;
  canClear: boolean;
  onClear: () => void;
  layout: WorkspaceLayout;
  onLayout: (layout: WorkspaceLayout) => void;
};

export function WorkspaceToolbar({ state, searchText, onSearchText, onSearchCommit, onChange, defaultMonth, canClear, onClear, layout, onLayout }: WorkspaceToolbarProps) {
  const periodMode = periodModeOf(state.period);

  function onSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      onSearchCommit();
    }
  }

  function onPeriodMode(mode: PeriodMode) {
    if (mode === "any") onChange({ period: null });
    else if (mode === "current") onChange({ period: "current" });
    else onChange({ period: state.period && isMonthPeriod(state.period) ? state.period : defaultMonth });
  }

  // A platform id in the URL that is not one of the two supported scopes is still honoured - and listed, so the select shows it.
  const platformOptions = state.platform && !PLATFORM_FILTER_OPTIONS.some((option) => option.value === state.platform) ? [...PLATFORM_FILTER_OPTIONS, { value: state.platform, label: formatPlatformName(state.platform) }] : PLATFORM_FILTER_OPTIONS;

  return (
    <Toolbar>
      <SearchInput placeholder="Search Partner or Vendor…" aria-label={FILTER_LABELS.search} value={searchText} maxLength={80} onChange={(event) => onSearchText(event.target.value)} onKeyDown={onSearchKeyDown} data-testid="workspace-search" />

      <select aria-label={FILTER_LABELS.counterpartyType} style={FIT_STYLE} value={state.counterpartyType ?? ""} onChange={(event) => onChange({ counterpartyType: (event.target.value || null) as CounterpartyType | null })}>
        <option value="">All Partners and Vendors</option>
        {COUNTERPARTY_FILTER_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>

      <select aria-label={FILTER_LABELS.lifecycle} style={FIT_STYLE} value={state.lifecycle ?? ""} onChange={(event) => onChange({ lifecycle: (event.target.value || null) as AgreementHeadStatus | null })}>
        <option value="">All lifecycles</option>
        {LIFECYCLE_FILTER_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>

      <select aria-label={FILTER_LABELS.platform} style={FIT_STYLE} value={state.platform ?? ""} onChange={(event) => onChange({ platform: event.target.value || null })}>
        <option value="">All platforms</option>
        {platformOptions.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>

      <select aria-label={FILTER_LABELS.period} style={FIT_STYLE} value={periodMode} onChange={(event) => onPeriodMode(event.target.value as PeriodMode)}>
        <option value="any">Any period</option>
        <option value="current">Current (in effect today)</option>
        <option value="month">Specific month…</option>
      </select>
      {periodMode === "month" && (
        <input type="month" aria-label={FILTER_LABELS.month} value={state.period ?? defaultMonth} style={{ width: 150, ...FIT_STYLE }} onChange={(event) => (isMonthPeriod(event.target.value) ? onChange({ period: event.target.value }) : undefined)} />
      )}

      <button type="button" className={state.discrepancy === "open" ? "btn primary" : "btn"} aria-pressed={state.discrepancy === "open"} style={FIT_STYLE} onClick={() => onChange({ discrepancy: state.discrepancy === "open" ? null : "open" })}>
        {state.discrepancy === "open" && <Icon name="check" />} {FILTER_LABELS.discrepancy}
      </button>

      {canClear && (
        <button type="button" className="btn ghost" onClick={onClear} data-testid="clear-filters">
          {CLEAR_FILTERS_LABEL}
        </button>
      )}

      <div className="segment" role="group" aria-label="Layout">
        <button type="button" className={layout === "table" ? "active" : ""} aria-label="Table view" aria-pressed={layout === "table"} onClick={() => onLayout("table")}>
          <Icon name="table" />
        </button>
        <button type="button" className={layout === "cards" ? "active" : ""} aria-label="Cards view" aria-pressed={layout === "cards"} onClick={() => onLayout("cards")}>
          <Icon name="grid" />
        </button>
      </div>
    </Toolbar>
  );
}
