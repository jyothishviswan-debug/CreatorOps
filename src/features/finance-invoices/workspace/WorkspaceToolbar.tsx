"use client";

import type { KeyboardEvent } from "react";

import { Icon } from "@/ui/icons";
import { Toolbar } from "@/ui/Table";
import type { InvoiceCounterpartyType, InvoiceReconciliationState, InvoiceStatus } from "@/server/finance-invoices/types";

import { CLEAR_FILTERS_LABEL, FILTER_LABELS } from "./workspace-copy";
import { COUNTERPARTY_TYPE_FILTER_OPTIONS, isCommercialPeriod, RECONCILIATION_FILTER_OPTIONS, STATUS_FILTER_OPTIONS, type WorkspaceUrlState } from "./workspace-query";

export type WorkspaceLayout = "table" | "cards";

// Step 16B: the accepted `.toolbar` family for the Invoices workspace - a compact single-row desktop
// toolbar (Status ~160px, Reconciliation ~190px, Type ~150px, Counterparty ~260px, Period ~190px),
// matching the Payables workspace's own control sizing convention. The toolbar only REPORTS changes
// (onChange); the workspace turns them into URL state and the SERVER re-filters - nothing is
// filtered here.
export type WorkspaceToolbarProps = {
  state: WorkspaceUrlState;
  counterpartyRefText: string;
  onCounterpartyRefText: (text: string) => void;
  onCounterpartyRefCommit: () => void;
  onChange: (change: Partial<WorkspaceUrlState>) => void;
  canClear: boolean;
  onClear: () => void;
  resultCount: number | null;
  layout: WorkspaceLayout;
  onLayout: (layout: WorkspaceLayout) => void;
};

export function WorkspaceToolbar({ state, counterpartyRefText, onCounterpartyRefText, onCounterpartyRefCommit, onChange, canClear, onClear, resultCount, layout, onLayout }: WorkspaceToolbarProps) {
  function onCounterpartyKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      onCounterpartyRefCommit();
    }
  }

  return (
    <Toolbar>
      <select aria-label={FILTER_LABELS.status} style={{ width: 160, maxWidth: "100%" }} value={state.status ?? ""} onChange={(event) => onChange({ status: (event.target.value || null) as InvoiceStatus | null })}>
        <option value="">All statuses</option>
        {STATUS_FILTER_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>

      <select
        aria-label={FILTER_LABELS.reconciliationState}
        style={{ width: 190, maxWidth: "100%" }}
        value={state.reconciliationState ?? ""}
        onChange={(event) => onChange({ reconciliationState: (event.target.value || null) as InvoiceReconciliationState | null })}
      >
        <option value="">All reconciliation</option>
        {RECONCILIATION_FILTER_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>

      <select
        aria-label={FILTER_LABELS.counterpartyType}
        style={{ width: 150, maxWidth: "100%" }}
        value={state.counterpartyType ?? ""}
        onChange={(event) => onChange({ counterpartyType: (event.target.value || null) as InvoiceCounterpartyType | null })}
      >
        <option value="">All Partners and Vendors</option>
        {COUNTERPARTY_TYPE_FILTER_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>

      <div className="inputwrap" style={{ minWidth: 240, maxWidth: 280 }}>
        <Icon name="search" />
        <input
          type="search"
          aria-label={FILTER_LABELS.counterparty}
          placeholder="Counterparty ref…"
          maxLength={200}
          value={counterpartyRefText}
          onChange={(event) => onCounterpartyRefText(event.target.value)}
          onKeyDown={onCounterpartyKeyDown}
          onBlur={onCounterpartyRefCommit}
          data-testid="workspace-counterparty-ref"
        />
      </div>

      <input
        type="month"
        aria-label={FILTER_LABELS.commercialPeriod}
        style={{ width: 190, maxWidth: "100%" }}
        value={state.commercialPeriod ?? ""}
        onChange={(event) => (event.target.value === "" || isCommercialPeriod(event.target.value) ? onChange({ commercialPeriod: event.target.value || null }) : undefined)}
      />

      {canClear && (
        <button type="button" className="btn ghost" onClick={onClear} data-testid="clear-filters">
          {CLEAR_FILTERS_LABEL}
        </button>
      )}

      <span className="muted" style={{ marginLeft: "auto", fontSize: 11, whiteSpace: "nowrap" }} data-testid="workspace-result-count">
        {resultCount !== null ? `${resultCount} shown` : ""}
      </span>

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
