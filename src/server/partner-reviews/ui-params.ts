
// Step 13B: the ONE pure, dependency-light parsing of every URL / query value
// the Partner Reviews pages accept. The URL is the single source of truth for
// page state; the SERVER re-validates every value on every render, so nothing
// here is trusted from the browser. Garbage never throws: an unusable value is
// reported as such (or falls back to a documented default) and an explicit,
// valid choice is never silently changed.

export type RawParam = string | string[] | undefined | null;

// The backend's month rule (period.ts's derivePeriod: a four-digit year >= 1970 and a month 01-12), restated
// here so this module - which client components import - stays free of period.ts's node:crypto dependency. A
// unit test pins the two together over a matrix.
const MONTH_KEY = /^(\d{4})-(0[1-9]|1[0-2])$/;
export function isMonthKey(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = MONTH_KEY.exec(value);
  return match !== null && Number(match[1]) >= 1970;
}

export function firstOf(raw: RawParam): string | undefined {
  if (Array.isArray(raw)) return raw[0];
  return raw ?? undefined;
}

// --- Month -------------------------------------------------------------------
export type MonthParam = { state: "absent" } | { state: "valid"; month: string } | { state: "invalid" };

// A real `YYYY-MM` month (four-digit year >= 1970, month 01-12) - the same rule
// the backend applies to a review's periodKey.
export function parseMonthParam(raw: RawParam): MonthParam {
  const value = firstOf(raw);
  if (value === undefined || value === "") return { state: "absent" };
  return isMonthKey(value) ? { state: "valid", month: value } : { state: "invalid" };
}

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] as const;

// "2019-03" -> "March 2019". Falls back to the raw key for anything else.
export function monthLabel(periodKey: string): string {
  if (!isMonthKey(periodKey)) return periodKey;
  return `${MONTH_NAMES[Number(periodKey.slice(5, 7)) - 1]} ${periodKey.slice(0, 4)}`;
}

export function previousMonth(periodKey: string): string | null {
  if (!isMonthKey(periodKey)) return null;
  const year = Number(periodKey.slice(0, 4));
  const month = Number(periodKey.slice(5, 7));
  const prev = month === 1 ? { y: year - 1, m: 12 } : { y: year, m: month - 1 };
  const key = `${String(prev.y).padStart(4, "0")}-${String(prev.m).padStart(2, "0")}`;
  return isMonthKey(key) ? key : null;
}

// The `count` calendar months ending at `endMonth`, newest first.
export function monthWindow(endMonth: string, count: number): string[] {
  const months: string[] = [];
  let current: string | null = endMonth;
  while (current && months.length < count) {
    months.push(current);
    current = previousMonth(current);
  }
  return months;
}

// --- Workspace ----------------------------------------------------------------
export const WORKSPACE_FILTERS = ["needs-review", "drafts", "finalized"] as const;
export type WorkspaceFilter = (typeof WORKSPACE_FILTERS)[number];
export const DEFAULT_WORKSPACE_FILTER: WorkspaceFilter = "needs-review";

export const WORKSPACE_FILTER_LABELS: Record<WorkspaceFilter, string> = {
  "needs-review": "Needs Review",
  drafts: "Drafts / In Review",
  finalized: "Finalized / History",
};

// null = no usable filter was requested.
export function parseFilterParam(raw: RawParam): WorkspaceFilter | null {
  const value = firstOf(raw);
  return (WORKSPACE_FILTERS as readonly string[]).includes(value ?? "") ? (value as WorkspaceFilter) : null;
}

// Optional "signal" narrowing linked from the Overview's Needs Attention rows:
// a closed list of facts already carried by the stored list summary.
export const WORKSPACE_SIGNALS = ["stale", "revision_available", "missing_evidence", "late", "target_not_met", "requirement_unavailable", "lfc_sfc_unavailable"] as const;
export type WorkspaceSignal = (typeof WORKSPACE_SIGNALS)[number];


export function parseSignalParam(raw: RawParam): WorkspaceSignal | null {
  const value = firstOf(raw);
  return (WORKSPACE_SIGNALS as readonly string[]).includes(value ?? "") ? (value as WorkspaceSignal) : null;
}

export const MAX_SEARCH_QUERY_LENGTH = 80;

export function parseSearchQuery(raw: RawParam): string {
  return (firstOf(raw) ?? "").trim().slice(0, MAX_SEARCH_QUERY_LENGTH);
}

export const MAX_REGION_FILTERS = 10;

export function parseRegionParam(raw: RawParam): string[] {
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return [...new Set(list.map((value) => value.trim()).filter((value) => value.length > 0 && value.length <= 60))].slice(0, MAX_REGION_FILTERS);
}

// A Partner is identified by its canonical partnerRef (an opaque server-issued handle).
export function parsePartnerRefParam(raw: RawParam): string | undefined {
  const value = firstOf(raw)?.trim();
  return value && value.length <= 200 && !/[\s/]/.test(value) ? value : undefined;
}

export const WORKSPACE_PAGE_SIZE = 10;
export const MAX_WORKSPACE_PAGE_SIZE = 20;

export function parseLimitParam(raw: RawParam): number {
  const value = Number(firstOf(raw));
  if (!Number.isInteger(value) || value < 1) return WORKSPACE_PAGE_SIZE;
  return Math.min(value, MAX_WORKSPACE_PAGE_SIZE);
}

// --- Review Detail ---------------------------------------------------------------
export const DETAIL_TABS = ["overview", "production", "compliance", "performance", "history"] as const;
export type DetailTab = (typeof DETAIL_TABS)[number];
export const DETAIL_TAB_LABELS: Record<DetailTab, string> = { overview: "Overview", production: "Production", compliance: "Compliance", performance: "Performance", history: "Version History" };

export function parseDetailTab(raw: RawParam): DetailTab {
  const value = firstOf(raw);
  return (DETAIL_TABS as readonly string[]).includes(value ?? "") ? (value as DetailTab) : "overview";
}

export type VersionParam = { state: "absent" } | { state: "valid"; version: number } | { state: "invalid" };

export function parseVersionParam(raw: RawParam): VersionParam {
  const value = firstOf(raw);
  if (value === undefined || value === "") return { state: "absent" };
  if (!/^\d{1,4}$/.test(value)) return { state: "invalid" };
  const version = Number(value);
  return version >= 1 ? { state: "valid", version } : { state: "invalid" };
}

// --- Partner-wise history -----------------------------------------------------------
export const HISTORY_TABS = ["trend", "production", "compliance", "performance", "commercial", "history"] as const;
export type HistoryTab = (typeof HISTORY_TABS)[number];
export const HISTORY_TAB_LABELS: Record<HistoryTab, string> = {
  trend: "Monthly Trend",
  production: "Production",
  compliance: "Compliance",
  performance: "Performance",
  commercial: "Commercial Evidence",
  history: "Review History",
};

export function parseHistoryTab(raw: RawParam): HistoryTab {
  const value = firstOf(raw);
  return (HISTORY_TABS as readonly string[]).includes(value ?? "") ? (value as HistoryTab) : "trend";
}

// --- Href builders (the one place each URL shape is defined) ---------------------------
function qs(params: Record<string, string | string[] | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) for (const item of value) search.append(key, item);
    else search.set(key, value);
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

export type WorkspaceHrefState = { filter?: WorkspaceFilter; month?: string | null; partnerRef?: string | null; region?: string[]; signal?: WorkspaceSignal | null };

export function workspaceHref(state: WorkspaceHrefState = {}): string {
  return `/partner-reviews/workspace${qs({ filter: state.filter, month: state.month, partnerRef: state.partnerRef, region: state.region, signal: state.signal })}`;
}

export function overviewHref(month?: string | null): string {
  return `/partner-reviews${qs({ month })}`;
}

export function reviewHref(reviewRef: string, options: { tab?: DetailTab; version?: number | null } = {}): string {
  return `/partner-reviews/${reviewRef}${qs({ tab: options.tab && options.tab !== "overview" ? options.tab : undefined, version: options.version ? String(options.version) : undefined })}`;
}

export function partnerHistoryHref(partnerRef: string, options: { month?: string | null; tab?: HistoryTab; until?: string | null } = {}): string {
  return `/partner-reviews/partner/${encodeURIComponent(partnerRef)}${qs({ month: options.month, tab: options.tab && options.tab !== "trend" ? options.tab : undefined, until: options.until })}`;
}
