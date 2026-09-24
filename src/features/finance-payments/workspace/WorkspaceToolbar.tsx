"use client";

import type { KeyboardEvent } from "react";

import { Icon } from "@/ui/icons";
import { Toolbar } from "@/ui/Table";
import type { PaymentCounterpartyType, PaymentStatus } from "@/server/finance-payments/types";

import { CLEAR_FILTERS_LABEL, FILTER_LABELS } from "./workspace-copy";
import { COUNTERPARTY_TYPE_FILTER_OPTIONS, STATUS_FILTER_OPTIONS, type WorkspaceUrlState } from "./workspace-query";

export type WorkspaceLayout = "table" | "cards";

// Step 17B: the accepted `.toolbar` family for the Payments workspace - a compact single-row
// desktop toolbar (Status ~160px, Type ~150px, Counterparty ~240px, Invoice ref ~220px), matching
// the Payables/Invoices workspace's own control sizing convention. The toolbar only REPORTS changes
// (onChange); the workspace turns them into URL state and the SERVER re-filters - nothing is
// filtered here.
export type WorkspaceToolbarProps = {
  state: WorkspaceUrlState;
  counterpartyRefText: string;
  onCounterpartyRefText: (text: string) => void;
  onCounterpartyRefCommit: () => void;
  invoiceRefText: string;
  onInvoiceRefText: (text: string) => void;
  onInvoiceRefCommit: () => void;
  onChange: (change: Partial<WorkspaceUrlState>) => void;
  canClear: boolean;
  onClear: () => void;
  resultCount: number | null;
  layout: WorkspaceLayout;
  onLayout: (layout: WorkspaceLayout) => void;
};

export function WorkspaceToolbar({ state, counterpartyRefText, onCounterpartyRefText, onCounterpartyRefCommit, invoiceRefText, onInvoiceRefText, onInvoiceRefCommit, onChange, canClear, onClear, resultCount, layout, onLayout }: WorkspaceToolbarProps) {
  function onEnterCommit(commit: () => void) {
    return (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") {
        event.preventDefault();
        commit();
      }
    };
  }

  return (
    <Toolbar>
      <select aria-label={FILTER_LABELS.status} style={{ width: 160, maxWidth: "100%" }} value={state.status ?? ""} onChange={(event) => onChange({ status: (event.target.value || null) as PaymentStatus | null })}>
        <option value="">All statuses</option>
        {STATUS_FILTER_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>

      <select
        aria-label={FILTER_LABELS.counterpartyType}
        style={{ width: 150, maxWidth: "100%" }}
        value={state.counterpartyType ?? ""}
        onChange={(event) => onChange({ counterpartyType: (event.target.value || null) as PaymentCounterpartyType | null })}
      >
        <option value="">All Partners and Vendors</option>
        {COUNTERPARTY_TYPE_FILTER_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>

      <div className="inputwrap" style={{ minWidth: 220, maxWidth: 260 }}>
        <Icon name="search" />
        <input
          type="search"
          aria-label={FILTER_LABELS.counterparty}
          placeholder="Counterparty ref…"
          maxLength={200}
          value={counterpartyRefText}
          onChange={(event) => onCounterpartyRefText(event.target.value)}
          onKeyDown={onEnterCommit(onCounterpartyRefCommit)}
          onBlur={onCounterpartyRefCommit}
          data-testid="workspace-counterparty-ref"
        />
      </div>

      <div className="inputwrap" style={{ minWidth: 200, maxWidth: 240 }}>
        <Icon name="search" />
        <input
          type="search"
          aria-label={FILTER_LABELS.invoiceRef}
          placeholder="Invoice ref…"
          maxLength={200}
          value={invoiceRefText}
          onChange={(event) => onInvoiceRefText(event.target.value)}
          onKeyDown={onEnterCommit(onInvoiceRefCommit)}
          onBlur={onInvoiceRefCommit}
          data-testid="workspace-invoice-ref"
        />
      </div>

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
