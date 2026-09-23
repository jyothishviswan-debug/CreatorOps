// Step 16B: the PURE URL-state layer of the Invoices workspace (/finance/invoices). No React, no
// server code: unit-tested in isolation. Mirrors src/features/finance-payables/workspace/workspace-query.ts's
// shape and rules, scoped to what listInvoicesWorkspace actually supports.
//
// The URL carries only FILTERS the server query schema (listInvoicesQuerySchema) actually accepts:
// status, counterpartyType, counterpartyRef, commercialPeriod, reconciliationState. There is no
// server-side invoice-date filter or free-text invoice-number search in Step 16A, so neither is
// offered here (never a client-side filter of an already-bounded read - see workspace-copy.ts).
// The opaque page cursor is NOT part of the URL: page 1 is always the server-rendered first page.
import { INVOICE_COUNTERPARTY_TYPES, INVOICE_RECONCILIATION_STATES, INVOICE_STATUSES, type InvoiceCounterpartyType, type InvoiceReconciliationState, type InvoiceStatus } from "@/server/finance-invoices/types";

import type { InvoiceWorkspaceRequest } from "../api-client";

export const WORKSPACE_PATH = "/finance/invoices";
export const NEW_INVOICE_HREF = "/finance/invoices/new";

export const WORKSPACE_PAGE_LIMIT = 10;
export const COMMERCIAL_PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

export const WORKSPACE_FILTER_KEYS = ["status", "counterpartyType", "counterpartyRef", "commercialPeriod", "reconciliationState"] as const;
export type WorkspaceFilterKey = (typeof WORKSPACE_FILTER_KEYS)[number];

export type WorkspaceUrlState = {
  status: InvoiceStatus | null;
  counterpartyType: InvoiceCounterpartyType | null;
  // The exact counterparty ref (opaque id) - there is no server-side free-text name search.
  counterpartyRef: string | null;
  // "YYYY-MM"
  commercialPeriod: string | null;
  reconciliationState: InvoiceReconciliationState | null;
};

export const EMPTY_WORKSPACE_STATE: WorkspaceUrlState = { status: null, counterpartyType: null, counterpartyRef: null, commercialPeriod: null, reconciliationState: null };

export type RawSearchParams = Record<string, string | string[] | undefined>;
export type ParsedWorkspaceUrl = { state: WorkspaceUrlState; ignored: WorkspaceFilterKey[] };

function firstText(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function isCommercialPeriod(value: string): boolean {
  return COMMERCIAL_PERIOD_PATTERN.test(value);
}

export function parseWorkspaceUrlState(raw: RawSearchParams | null | undefined): ParsedWorkspaceUrl {
  const source: RawSearchParams = raw && typeof raw === "object" ? raw : {};
  const ignored: WorkspaceFilterKey[] = [];
  const state: WorkspaceUrlState = { ...EMPTY_WORKSPACE_STATE };

  const statusText = firstText(source.status);
  if (statusText !== null) {
    const candidate = statusText.toUpperCase();
    if ((INVOICE_STATUSES as readonly string[]).includes(candidate)) state.status = candidate as InvoiceStatus;
    else ignored.push("status");
  }

  const typeText = firstText(source.counterpartyType);
  if (typeText !== null) {
    const candidate = typeText.toUpperCase();
    if ((INVOICE_COUNTERPARTY_TYPES as readonly string[]).includes(candidate)) state.counterpartyType = candidate as InvoiceCounterpartyType;
    else ignored.push("counterpartyType");
  }

  const refText = firstText(source.counterpartyRef);
  if (refText !== null) state.counterpartyRef = refText.slice(0, 200);

  const periodText = firstText(source.commercialPeriod);
  if (periodText !== null) {
    if (isCommercialPeriod(periodText)) state.commercialPeriod = periodText;
    else ignored.push("commercialPeriod");
  }

  const reconciliationText = firstText(source.reconciliationState);
  if (reconciliationText !== null) {
    const candidate = reconciliationText.toUpperCase();
    if ((INVOICE_RECONCILIATION_STATES as readonly string[]).includes(candidate)) state.reconciliationState = candidate as InvoiceReconciliationState;
    else ignored.push("reconciliationState");
  }

  return { state, ignored };
}

export function workspaceQueryString(state: WorkspaceUrlState): string {
  const search = new URLSearchParams();
  for (const key of WORKSPACE_FILTER_KEYS) {
    const value = state[key];
    if (value !== null && value !== "") search.set(key, value);
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

export function workspaceHref(state: WorkspaceUrlState = EMPTY_WORKSPACE_STATE): string {
  return `${WORKSPACE_PATH}${workspaceQueryString(state)}`;
}

export function workspaceStateKey(state: WorkspaceUrlState): string {
  return workspaceQueryString(state) || "all";
}

export function withFilter(state: WorkspaceUrlState, change: Partial<WorkspaceUrlState>): WorkspaceUrlState {
  return { ...state, ...change };
}

export function activeFilterCount(state: WorkspaceUrlState): number {
  return WORKSPACE_FILTER_KEYS.filter((key) => state[key] !== null).length;
}

export function hasActiveFilters(state: WorkspaceUrlState): boolean {
  return activeFilterCount(state) > 0;
}

export function toWorkspaceRequest(state: WorkspaceUrlState, options: { cursor?: string | null; limit?: number } = {}): InvoiceWorkspaceRequest {
  const request: InvoiceWorkspaceRequest = { limit: options.limit ?? WORKSPACE_PAGE_LIMIT };
  if (state.status) request.status = state.status;
  if (state.counterpartyType) request.counterpartyType = state.counterpartyType;
  if (state.counterpartyRef) request.counterpartyRef = state.counterpartyRef;
  if (state.commercialPeriod) request.commercialPeriod = state.commercialPeriod;
  if (state.reconciliationState) request.reconciliationState = state.reconciliationState;
  if (options.cursor) request.cursor = options.cursor;
  return request;
}

// --- Filter option lists (labels for the toolbar controls) -------------------------------------------------------------------------
export const STATUS_FILTER_OPTIONS: ReadonlyArray<{ value: InvoiceStatus; label: string }> = [
  { value: "DRAFT", label: "Draft" },
  { value: "SUBMITTED", label: "Submitted" },
  { value: "APPROVED", label: "Approved" },
  { value: "REJECTED", label: "Rejected" },
  { value: "VOID", label: "Void" },
];

export const COUNTERPARTY_TYPE_FILTER_OPTIONS: ReadonlyArray<{ value: InvoiceCounterpartyType; label: string }> = [
  { value: "PARTNER", label: "Partners" },
  { value: "VENDOR", label: "Vendors" },
];

export const RECONCILIATION_FILTER_OPTIONS: ReadonlyArray<{ value: InvoiceReconciliationState; label: string }> = [
  { value: "MATCH", label: "Match" },
  { value: "MISMATCH", label: "Mismatch" },
  { value: "REVIEW_REQUIRED", label: "Review required" },
  { value: "BLOCKED", label: "Blocked" },
  { value: "MISSING_IN_INVOICE", label: "Missing information" },
  { value: "MISSING_IN_PAYABLE", label: "Missing information" },
];
