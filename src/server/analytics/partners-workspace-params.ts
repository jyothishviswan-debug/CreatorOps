// Step 12F: the pure request-parameter layer of the Partners Analytics
// workspace (/analytics/partners): every value that arrives in the URL (or the
// Partner-search API) is parsed, normalized and BOUNDED here before anything
// else looks at it, so the server never trusts the query string and every
// render re-validates. Pure and dependency-light: no Firestore, no actor.
//
// URL state (the URL is the ONE source of truth):
//   ?partners=<ref>,<ref>   canonical partnerRefs, deduped, at most PARTNER_SELECTION_LIMIT
//   ?month=YYYY-MM          server-validated (see reporting-month.ts); absent = latest month with data
//   ?platform=instagram|youtube   (All = absent), normalized with the shared normalizePlatformIdentifier
//   ?targetAudience=India%201&targetAudience=...   canonical TARGET_AUDIENCES values ONLY
//   ?region=...             optional Partner-discovery region filter (repeatable, bounded)
//   ?metric=views|engagement|likes|comments   which single metric the multi-Partner trend matrix shows
//
// Target Audience and region are Partner-DISCOVERY aids for the selector only:
// they narrow the search list (choosing every option of one is no narrowing). They never select Partners, never filter the
// already-selected Partners, never rewrite Analytics data and never broaden
// scope. No Tier parameter exists anywhere in this file.
import { DISCOVERY_REGIONS, TARGET_AUDIENCES, type TargetAudience } from "@/server/discovery/types";

import { parsePartnerViewSelection, type PartnerViewSelection } from "./partner-view-metrics";
import { PLATFORM_VIEW_METRICS, type PlatformViewMetricId } from "./platform-view-metrics";
import { DEFAULT_TREND_METRIC as DEFAULT_METRIC } from "./partners-workspace-links";
import { parseMonthParam } from "./reporting-month";

// No existing shared multi-select / comparison cap exists in this repository
// (searched: no MAX_*SELECT / selection-cap constant), so the workspace defines
// its own conservative bound. It is enforced server-side (extra refs are ignored
// with a disclosed notice) AND in the selector UI.
export const PARTNER_SELECTION_LIMIT = 10;
export const MAX_PARTNER_REF_LENGTH = 200;
// A hostile URL must not make the server tokenize an unbounded string list.
const MAX_RAW_PARTNER_TOKENS = 100;

// Firestore's array-contains-any accepts at most 30 values, so 30 is the most
// regions that can genuinely narrow a search. Choosing EVERY region ("Select
// all") never reaches Firestore: it means "no region narrowing" (see
// narrowingRegions), so the URL/selector state may hold the whole canonical list
// (plus custom "Other" regions) up to MAX_REGION_SELECTION.
export const MAX_REGION_FILTERS = 30;
export const MAX_REGION_SELECTION = 60;
export const MAX_REGION_LENGTH = 60;

export const PARTNER_SEARCH_MAX_QUERY_LENGTH = 100;
export const PARTNER_SEARCH_DEFAULT_LIMIT = 10;
export const PARTNER_SEARCH_MAX_LIMIT = 20;

export const DEFAULT_TREND_METRIC: PlatformViewMetricId = DEFAULT_METRIC;

// ---- Small parsers ------------------------------------------------------------------------

// Next hands a query value as `string | string[] | undefined`; anything that is
// not a string (or an array of strings) contributes nothing.
export function stringValues(input: unknown): string[] {
  if (typeof input === "string") return [input];
  if (Array.isArray(input)) return input.filter((value): value is string => typeof value === "string");
  return [];
}

export function parseTargetAudienceValues(input: unknown): TargetAudience[] {
  const allowed = new Set<string>(TARGET_AUDIENCES);
  const out: TargetAudience[] = [];
  for (const value of stringValues(input)) {
    const trimmed = value.trim();
    // Canonical, exact values only; unknown values are ignored (never trusted, never errors).
    if (allowed.has(trimmed) && !out.includes(trimmed as TargetAudience)) out.push(trimmed as TargetAudience);
  }
  // Stable, canonical order regardless of URL order.
  return TARGET_AUDIENCES.filter((value) => out.includes(value));
}

export function parseRegionValues(input: unknown): string[] {
  const out: string[] = [];
  for (const value of stringValues(input)) {
    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_REGION_LENGTH) continue;
    if (!out.some((existing) => existing.toLowerCase() === trimmed.toLowerCase())) out.push(trimmed);
    if (out.length >= MAX_REGION_SELECTION) break;
  }
  // Every canonical region chosen = "Select all": kept whole. Anything else is a
  // real narrowing and stays within what Firestore can filter on.
  return selectsEveryRegion(out) ? out : out.slice(0, MAX_REGION_FILTERS);
}

// "Select all" in a filter is the SAME as no filter: a Partner with no region /
// Target Audience recorded stays searchable. These two functions are the only
// place a selector value becomes a real search narrowing.
export function selectsEveryRegion(regions: readonly string[]): boolean {
  const chosen = new Set(regions.map((region) => region.toLowerCase()));
  return DISCOVERY_REGIONS.every((region) => chosen.has(region.toLowerCase()));
}

export function narrowingRegions(regions: readonly string[]): string[] {
  return selectsEveryRegion(regions) ? [] : [...regions];
}

export function narrowingTargetAudiences(values: readonly TargetAudience[]): TargetAudience[] {
  return TARGET_AUDIENCES.every((value) => values.includes(value)) ? [] : [...values];
}

export function parseTrendMetric(input: unknown): PlatformViewMetricId {
  return typeof input === "string" && (PLATFORM_VIEW_METRICS as readonly string[]).includes(input.trim()) ? (input.trim() as PlatformViewMetricId) : DEFAULT_TREND_METRIC;
}

export type ParsedPartnerRefs = {
  // Deduped (first occurrence wins, so the order is the caller's own), at most
  // PARTNER_SELECTION_LIMIT.
  refs: string[];
  // Well-formed refs beyond the limit that were ignored.
  ignoredOverLimit: number;
  // Tokens that can never be a real ref (over-long) - counted as "not available".
  malformed: number;
};

// `?partners=a,b` and/or repeated `?partners=a&partners=b`; blanks are dropped.
export function parsePartnerRefs(input: unknown): ParsedPartnerRefs {
  const tokens = stringValues(input)
    .flatMap((value) => value.split(","))
    .slice(0, MAX_RAW_PARTNER_TOKENS)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);

  let malformed = 0;
  const unique: string[] = [];
  for (const token of tokens) {
    if (token.length > MAX_PARTNER_REF_LENGTH) {
      malformed++;
      continue;
    }
    if (!unique.includes(token)) unique.push(token);
  }
  return { refs: unique.slice(0, PARTNER_SELECTION_LIMIT), ignoredOverLimit: Math.max(0, unique.length - PARTNER_SELECTION_LIMIT), malformed };
}

// ---- The workspace state ------------------------------------------------------------------------

export type WorkspaceParamsInput = { partners?: unknown; month?: unknown; platform?: unknown; targetAudience?: unknown; region?: unknown; metric?: unknown };

export type WorkspaceState = {
  partnerRefs: string[];
  ignoredOverLimit: number;
  malformedPartnerTokens: number;
  // The user's explicit, VALID month; null = none (the default follows the data).
  month: string | null;
  // A month value was supplied but is not `YYYY-MM`: treated as absent + disclosed.
  monthInvalid: boolean;
  platform: PartnerViewSelection;
  targetAudience: TargetAudience[];
  regions: string[];
  metric: PlatformViewMetricId;
};

export function parseWorkspaceParams(raw: WorkspaceParamsInput): WorkspaceState {
  const partners = parsePartnerRefs(raw.partners);
  const month = parseMonthParam(raw.month);
  return {
    partnerRefs: partners.refs,
    ignoredOverLimit: partners.ignoredOverLimit,
    malformedPartnerTokens: partners.malformed,
    month: month.month,
    monthInvalid: month.invalid,
    platform: parsePartnerViewSelection(raw.platform),
    targetAudience: parseTargetAudienceValues(raw.targetAudience),
    regions: parseRegionValues(raw.region),
    metric: parseTrendMetric(raw.metric),
  };
}

// ---- Hrefs ---------------------------------------------------------------------------------------

// The workspace URL writer lives in partners-workspace-links.ts (import-free, so the
// client selector shares it); re-exported here for the server callers.
export { PARTNERS_WORKSPACE_PATH, partnersWorkspacePath, type WorkspaceHrefState } from "./partners-workspace-links";

// ---- Partner search input ----------------------------------------------------------------------------

export type PartnerSearchInput = {
  // Lower-cased, trimmed name prefix ("" = browse the most recent Partners).
  prefix: string;
  targetAudience: TargetAudience[];
  regions: string[];
  limit: number;
};

export type ParsedPartnerSearch = { ok: true; input: PartnerSearchInput } | { ok: false; message: string };

export function parsePartnerSearchInput(raw: { q?: unknown; targetAudience?: unknown; region?: unknown; limit?: unknown }): ParsedPartnerSearch {
  const q = typeof raw.q === "string" ? raw.q.trim() : "";
  if (q.length > PARTNER_SEARCH_MAX_QUERY_LENGTH) return { ok: false, message: "Search text is too long." };

  let limit = PARTNER_SEARCH_DEFAULT_LIMIT;
  if (raw.limit !== undefined && raw.limit !== null && raw.limit !== "") {
    const parsed = typeof raw.limit === "number" ? raw.limit : typeof raw.limit === "string" ? Number(raw.limit) : Number.NaN;
    if (!Number.isInteger(parsed) || parsed < 1) return { ok: false, message: "Invalid limit." };
    limit = Math.min(parsed, PARTNER_SEARCH_MAX_LIMIT);
  }

  return { ok: true, input: { prefix: q.toLowerCase(), targetAudience: parseTargetAudienceValues(raw.targetAudience), regions: parseRegionValues(raw.region), limit } };
}
