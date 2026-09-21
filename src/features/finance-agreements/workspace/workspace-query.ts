// Step 14B: the PURE URL-state layer of the Agreements workspace (/finance/agreements). No React, no server code beyond the
// pure registry modules: unit-tested in isolation.
//
// The URL carries only FILTERS (all re-applied by the SERVER on every render; nothing is filtered in the browser):
//   lifecycle, counterpartyType, q, platform, period, discrepancy
// The opaque page cursor is NOT part of the URL: page 1 is always the server-rendered first page, and further pages are
// fetched one bounded cursor page at a time (cursor passed through verbatim from the previous response).
//
// Parsing is lenient by design (a person can hand-edit the URL): an unknown or malformed value is dropped and named in
// `ignored` so the page can keep working; a repeated param uses its first value. Serialization is CANONICAL: a fixed
// param order and no default / empty values, so two equal states always produce the same URL (and the same remount key).
import { normalizePlatformIdentifier } from "@/server/shared/platform";
import { AGREEMENT_HEAD_STATUSES, COUNTERPARTY_TYPES, type AgreementHeadStatus, type CounterpartyType } from "@/server/finance-agreements/types";

import type { WorkspaceRequest } from "../api-client";

export const WORKSPACE_PATH = "/finance/agreements";

// One bounded page. Kept constant for a whole result set: the server's cursor is an offset, so changing the page size
// between pages would skip or repeat rows.
export const WORKSPACE_PAGE_LIMIT = 10;
export const WORKSPACE_SEARCH_MAX_LENGTH = 80;

// The filters, in canonical URL order.
export const WORKSPACE_FILTER_KEYS = ["lifecycle", "counterpartyType", "q", "platform", "period", "discrepancy"] as const;
export type WorkspaceFilterKey = (typeof WORKSPACE_FILTER_KEYS)[number];

export type WorkspaceUrlState = {
  lifecycle: AgreementHeadStatus | null;
  counterpartyType: CounterpartyType | null;
  // Counterparty name search text (trimmed, at most 80 characters).
  q: string | null;
  // Normalized platform id (lower-case), e.g. "instagram".
  platform: string | null;
  // "current" (the governing version covers today) or a "YYYY-MM" calendar month.
  period: string | null;
  // "open" = only Agreements that still have unresolved fields.
  discrepancy: "open" | null;
};

export const EMPTY_WORKSPACE_STATE: WorkspaceUrlState = { lifecycle: null, counterpartyType: null, q: null, platform: null, period: null, discrepancy: null };

export type RawSearchParams = Record<string, string | string[] | undefined>;

export type ParsedWorkspaceUrl = { state: WorkspaceUrlState; ignored: WorkspaceFilterKey[] };

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const PLATFORM_PATTERN = /^[a-z0-9][a-z0-9 ._-]{0,59}$/;

function firstText(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function isMonthPeriod(value: string): boolean {
  return MONTH_PATTERN.test(value);
}

export function parseWorkspaceUrlState(raw: RawSearchParams | null | undefined): ParsedWorkspaceUrl {
  const source: RawSearchParams = raw && typeof raw === "object" ? raw : {};
  const ignored: WorkspaceFilterKey[] = [];
  const state: WorkspaceUrlState = { ...EMPTY_WORKSPACE_STATE };

  const enumValue = <T extends string>(key: WorkspaceFilterKey, allowed: readonly T[], normalize: (text: string) => string): T | null => {
    const text = firstText(source[key]);
    if (text === null) return null;
    const candidate = normalize(text);
    if ((allowed as readonly string[]).includes(candidate)) return candidate as T;
    ignored.push(key);
    return null;
  };

  state.lifecycle = enumValue("lifecycle", AGREEMENT_HEAD_STATUSES, (text) => text.toUpperCase());
  state.counterpartyType = enumValue("counterpartyType", COUNTERPARTY_TYPES, (text) => text.toUpperCase());
  state.discrepancy = enumValue("discrepancy", ["open"] as const, (text) => text.toLowerCase());

  const q = firstText(source.q);
  state.q = q === null ? null : q.slice(0, WORKSPACE_SEARCH_MAX_LENGTH).trim() || null;

  const platformText = firstText(source.platform);
  if (platformText !== null) {
    const platform = normalizePlatformIdentifier(platformText);
    if (PLATFORM_PATTERN.test(platform)) state.platform = platform;
    else ignored.push("platform");
  }

  const periodText = firstText(source.period);
  if (periodText !== null) {
    const period = periodText.toLowerCase();
    if (period === "current" || isMonthPeriod(period)) state.period = period;
    else ignored.push("period");
  }

  return { state, ignored };
}

// The canonical query string of a state ("" when no filter is set; otherwise starts with "?").
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

// A stable identity of a state: the list is remounted (page cache dropped) whenever it changes.
export function workspaceStateKey(state: WorkspaceUrlState): string {
  return workspaceQueryString(state) || "all";
}

// Merges a change into a state. A blank text search collapses to null; everything else is taken as given.
export function withFilter(state: WorkspaceUrlState, change: Partial<WorkspaceUrlState>): WorkspaceUrlState {
  const merged = { ...state, ...change };
  const q = merged.q === null ? null : merged.q.trim().slice(0, WORKSPACE_SEARCH_MAX_LENGTH).trim();
  return { ...merged, q: q ? q : null };
}

export function activeFilterCount(state: WorkspaceUrlState): number {
  return WORKSPACE_FILTER_KEYS.filter((key) => state[key] !== null).length;
}

export function hasActiveFilters(state: WorkspaceUrlState): boolean {
  return activeFilterCount(state) > 0;
}

// The service / API request for a state. Only SET filters are sent. `cursor` is opaque: it is passed through verbatim
// (never decoded, trimmed or rewritten) and only when present.
export function toWorkspaceRequest(state: WorkspaceUrlState, options: { cursor?: string | null; limit?: number } = {}): WorkspaceRequest {
  const request: WorkspaceRequest = { limit: options.limit ?? WORKSPACE_PAGE_LIMIT };
  if (state.lifecycle) request.lifecycle = state.lifecycle;
  if (state.counterpartyType) request.counterpartyType = state.counterpartyType;
  if (state.q) request.q = state.q;
  if (state.platform) request.platform = state.platform;
  if (state.period) request.period = state.period;
  if (state.discrepancy) request.discrepancy = state.discrepancy;
  if (options.cursor) request.cursor = options.cursor;
  return request;
}

// --- Filter option lists (labels for the toolbar controls) -------------------------------------------------------------------------
export const LIFECYCLE_FILTER_OPTIONS: ReadonlyArray<{ value: AgreementHeadStatus; label: string }> = [
  { value: "DRAFT", label: "Draft" },
  { value: "ACTIVE", label: "Active" },
  { value: "SUSPENDED", label: "Suspended" },
  { value: "ENDED", label: "Ended" },
];

export const COUNTERPARTY_FILTER_OPTIONS: ReadonlyArray<{ value: CounterpartyType; label: string }> = [
  { value: "PARTNER", label: "Partners" },
  { value: "VENDOR", label: "Vendors" },
];

// Platform scopes a Partner Agreement can carry today. Any other valid id in the URL is still honoured (and listed).
export const PLATFORM_FILTER_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "instagram", label: "Instagram" },
  { value: "youtube", label: "YouTube" },
];

// The period control has three modes: no period, "current", or one calendar month.
export type PeriodMode = "any" | "current" | "month";
export function periodModeOf(period: string | null): PeriodMode {
  if (period === null) return "any";
  return period === "current" ? "current" : "month";
}

// The current UTC calendar month as YYYY-MM (injectable clock for tests).
export function currentMonthKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 7);
}
