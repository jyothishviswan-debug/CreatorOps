// Step 15B: the PURE URL-state layer of the Payables workspace (/finance/payables). No React, no server
// code: unit-tested in isolation. Mirrors src/features/finance-agreements/workspace/workspace-query.ts's
// shape and rules, scoped to what listPayablesWorkspace actually supports.
//
// The URL carries only FILTERS (all re-applied by the SERVER on every render; nothing is filtered in the
// browser): status, counterpartyType, counterpartyRef, commercialPeriod. The opaque page cursor is NOT
// part of the URL: page 1 is always the server-rendered first page, further pages are fetched one bounded
// cursor page at a time.
import { PAYABLE_COUNTERPARTY_TYPES, PAYABLE_STATUSES, type PayableCounterpartyType, type PayableStatus } from "@/server/finance-payables/types";

import type { WorkspaceRequest } from "../api-client";

export const WORKSPACE_PATH = "/finance/payables";
export const NEW_PAYABLE_HREF = "/finance/payables/new";

export const WORKSPACE_PAGE_LIMIT = 10;
export const COMMERCIAL_PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

export const WORKSPACE_FILTER_KEYS = ["status", "counterpartyType", "counterpartyRef", "commercialPeriod"] as const;
export type WorkspaceFilterKey = (typeof WORKSPACE_FILTER_KEYS)[number];

export type WorkspaceUrlState = {
  status: PayableStatus | null;
  counterpartyType: PayableCounterpartyType | null;
  // The exact counterparty ref (opaque id) - the workspace toolbar resolves a typed name to a ref
  // before it reaches this state; there is no free-text server-side name search.
  counterpartyRef: string | null;
  // "YYYY-MM"
  commercialPeriod: string | null;
};

export const EMPTY_WORKSPACE_STATE: WorkspaceUrlState = { status: null, counterpartyType: null, counterpartyRef: null, commercialPeriod: null };

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
    if ((PAYABLE_STATUSES as readonly string[]).includes(candidate)) state.status = candidate as PayableStatus;
    else ignored.push("status");
  }

  const typeText = firstText(source.counterpartyType);
  if (typeText !== null) {
    const candidate = typeText.toUpperCase();
    if ((PAYABLE_COUNTERPARTY_TYPES as readonly string[]).includes(candidate)) state.counterpartyType = candidate as PayableCounterpartyType;
    else ignored.push("counterpartyType");
  }

  const refText = firstText(source.counterpartyRef);
  if (refText !== null) state.counterpartyRef = refText.slice(0, 200);

  const periodText = firstText(source.commercialPeriod);
  if (periodText !== null) {
    if (isCommercialPeriod(periodText)) state.commercialPeriod = periodText;
    else ignored.push("commercialPeriod");
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

export function toWorkspaceRequest(state: WorkspaceUrlState, options: { cursor?: string | null; limit?: number } = {}): WorkspaceRequest {
  const request: WorkspaceRequest = { limit: options.limit ?? WORKSPACE_PAGE_LIMIT };
  if (state.status) request.status = state.status;
  if (state.counterpartyType) request.counterpartyType = state.counterpartyType;
  if (state.counterpartyRef) request.counterpartyRef = state.counterpartyRef;
  if (state.commercialPeriod) request.commercialPeriod = state.commercialPeriod;
  if (options.cursor) request.cursor = options.cursor;
  return request;
}

// --- Filter option lists (labels for the toolbar controls) -------------------------------------------------------------------------
export const STATUS_FILTER_OPTIONS: ReadonlyArray<{ value: PayableStatus; label: string }> = [
  { value: "DRAFT", label: "Draft" },
  { value: "READY_FOR_INVOICE", label: "Ready for invoice" },
  { value: "VOID", label: "Void" },
];

export const COUNTERPARTY_TYPE_FILTER_OPTIONS: ReadonlyArray<{ value: PayableCounterpartyType; label: string }> = [
  { value: "PARTNER", label: "Partners" },
  { value: "VENDOR", label: "Vendors" },
];
