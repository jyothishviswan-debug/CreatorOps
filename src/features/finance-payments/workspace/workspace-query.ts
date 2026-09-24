// Step 17B: the PURE URL-state layer of the Payments workspace (/finance/payments). No React, no
// server code: unit-tested in isolation. Mirrors src/features/finance-invoices/workspace/workspace-query.ts's
// shape and rules, scoped to what listPaymentsWorkspace (src/server/finance-payments/types.ts's
// listPaymentsQuerySchema) actually supports: status, invoiceRef, counterpartyType, counterpartyRef.
//
// Integration note (Step 17B, section 4 vs the closed Step 17A backend): the spec's compact-filter
// list also names "Settlement state", "Payment method" and "Search by payment ref / external
// reference". None of those are server-query-filterable today - `listPaymentsQuerySchema` has no
// such fields, settlement state is an INVOICE-level projection (not a Payment head field), and
// method lives only on a Payment's latest VERSION document (the workspace service already
// documents that it reads method for the current PAGE only, "never for the whole scanned set" -
// see payment-workspace-service.ts). Offering them as filters would mean either a silent
// client-side filter of an already-bounded read (the exact anti-pattern Invoices' own
// workspace-query.ts rejects) or a broader backend change than "minimal". Per the operating
// instructions ("do not change Payment domain rules unless a real integration defect proves a
// minimal backend fix is necessary"), this is left as a documented gap rather than a backend change -
// only the four server-supported filters are offered here, exactly like Invoices omits filters its
// own backend doesn't support.
import { PAYMENT_COUNTERPARTY_TYPES, PAYMENT_STATUSES, type PaymentCounterpartyType, type PaymentStatus } from "@/server/finance-payments/types";

import type { PaymentWorkspaceRequest } from "../api-client";

export const WORKSPACE_PATH = "/finance/payments";
export const NEW_PAYMENT_HREF = "/finance/payments/new";

export const WORKSPACE_PAGE_LIMIT = 10;

export const WORKSPACE_FILTER_KEYS = ["status", "counterpartyType", "counterpartyRef", "invoiceRef"] as const;
export type WorkspaceFilterKey = (typeof WORKSPACE_FILTER_KEYS)[number];

export type WorkspaceUrlState = {
  status: PaymentStatus | null;
  counterpartyType: PaymentCounterpartyType | null;
  // The exact counterparty ref (opaque id) - there is no server-side free-text name search.
  counterpartyRef: string | null;
  // The exact invoice ref (opaque id).
  invoiceRef: string | null;
};

export const EMPTY_WORKSPACE_STATE: WorkspaceUrlState = { status: null, counterpartyType: null, counterpartyRef: null, invoiceRef: null };

export type RawSearchParams = Record<string, string | string[] | undefined>;
export type ParsedWorkspaceUrl = { state: WorkspaceUrlState; ignored: WorkspaceFilterKey[] };

function firstText(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function parseWorkspaceUrlState(raw: RawSearchParams | null | undefined): ParsedWorkspaceUrl {
  const source: RawSearchParams = raw && typeof raw === "object" ? raw : {};
  const ignored: WorkspaceFilterKey[] = [];
  const state: WorkspaceUrlState = { ...EMPTY_WORKSPACE_STATE };

  const statusText = firstText(source.status);
  if (statusText !== null) {
    const candidate = statusText.toUpperCase();
    if ((PAYMENT_STATUSES as readonly string[]).includes(candidate)) state.status = candidate as PaymentStatus;
    else ignored.push("status");
  }

  const typeText = firstText(source.counterpartyType);
  if (typeText !== null) {
    const candidate = typeText.toUpperCase();
    if ((PAYMENT_COUNTERPARTY_TYPES as readonly string[]).includes(candidate)) state.counterpartyType = candidate as PaymentCounterpartyType;
    else ignored.push("counterpartyType");
  }

  const refText = firstText(source.counterpartyRef);
  if (refText !== null) state.counterpartyRef = refText.slice(0, 200);

  const invoiceRefText = firstText(source.invoiceRef);
  if (invoiceRefText !== null) state.invoiceRef = invoiceRefText.slice(0, 200);

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

export function toWorkspaceRequest(state: WorkspaceUrlState, options: { cursor?: string | null; limit?: number } = {}): PaymentWorkspaceRequest {
  const request: PaymentWorkspaceRequest = { limit: options.limit ?? WORKSPACE_PAGE_LIMIT };
  if (state.status) request.status = state.status;
  if (state.counterpartyType) request.counterpartyType = state.counterpartyType;
  if (state.counterpartyRef) request.counterpartyRef = state.counterpartyRef;
  if (state.invoiceRef) request.invoiceRef = state.invoiceRef;
  if (options.cursor) request.cursor = options.cursor;
  return request;
}

// --- Filter option lists (labels for the toolbar controls) -------------------------------------------------------------------------
export const STATUS_FILTER_OPTIONS: ReadonlyArray<{ value: PaymentStatus; label: string }> = [
  { value: "DRAFT", label: "Draft" },
  { value: "RECORDED", label: "Recorded" },
  { value: "CONFIRMED", label: "Confirmed" },
  { value: "FAILED", label: "Failed" },
  { value: "VOID", label: "Void" },
];

export const COUNTERPARTY_TYPE_FILTER_OPTIONS: ReadonlyArray<{ value: PaymentCounterpartyType; label: string }> = [
  { value: "PARTNER", label: "Partners" },
  { value: "VENDOR", label: "Vendors" },
];
