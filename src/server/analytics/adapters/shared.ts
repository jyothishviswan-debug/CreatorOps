import { isUnsupportedMetricId, type AnalyticsMetricId, type UnsupportedMetricId } from "../metric-registry";

// Step 12A section 6: the shared "explicit selected import target +
// recognized headers + platform evidence, never guessing" discipline
// every adapter (Instagram/YouTube content, channel snapshot) builds on.
// Case-insensitive, whitespace-tolerant header matching - one normalizer,
// reused by every adapter's own alias table lookup. Also folds underscores
// and hyphens to spaces so a real snake_case/kebab-case export (e.g. a
// Supermetrics "post_id"/"post_url" column) matches the same alias as its
// spaced Title Case equivalent ("Post ID"/"Post URL") - no alias string
// declared anywhere uses underscores/hyphens itself, so this only adds
// matches, never removes one.
export function normalizeHeaderKey(header: string): string {
  return header
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export type HeaderAliasMap<TFieldId extends string> = Record<TFieldId, string[]>;

// Headers recognized across EVERY adapter as belonging to a metric this
// registry deliberately does not support (Section 5) - a column matching
// one of these is always classified as an IGNORED COLUMN, never coerced
// into a supported field, never blocking the row. Shared once here so no
// adapter has to redeclare the same rejection list.
export const SHARED_UNSUPPORTED_HEADER_ALIASES: HeaderAliasMap<UnsupportedMetricId> = {
  reach: ["Reach", "Total Reach", "Unique Reach"],
  impressions: ["Impressions", "Total Impressions"],
  shares: ["Shares", "Share Count", "# Shares"],
  saves: ["Saves", "Save Count", "# Saves", "Bookmarks"],
  watchTimeMinutes: ["Watch Time (minutes)", "Watch Time Minutes", "Watch Time"],
  demographics: ["Demographics", "Audience Demographics"],
  authenticityScore: ["Authenticity Score"],
  blendedPerformanceScore: ["Blended Performance Score", "Performance Score", "Composite Score"],
};

export type HeaderClassification<TFieldId extends string> = {
  // original header text -> canonical field id
  recognized: Map<string, TFieldId>;
  // original header text -> the specific unsupported metric id it matched
  unsupported: Map<string, UnsupportedMetricId>;
  // original header text, verbatim, left completely alone
  unrecognized: string[];
  // Remediation-plan Wave B / finding #55 re-audit: canonical field id -> the RAW header strings
  // (>= 2, verbatim) that all normalized to it. A collision NEVER silently picks the
  // last-in-column-order header (the pre-fix behavior) - the field is pulled out of `recognized`
  // entirely and reported here instead, so no column is guessed and every colliding original
  // header stays visible to the caller.
  ambiguous: Map<TFieldId, string[]>;
};

function buildLookup<TFieldId extends string>(aliasMap: HeaderAliasMap<TFieldId>): Map<string, TFieldId> {
  const lookup = new Map<string, TFieldId>();
  for (const [fieldId, aliases] of Object.entries(aliasMap) as [TFieldId, string[]][]) {
    for (const alias of aliases) lookup.set(normalizeHeaderKey(alias), fieldId);
  }
  return lookup;
}

// Classifies every header in a sheet into exactly one bucket: recognized
// (mapped to a canonical, SUPPORTED metric-registry field id),
// unsupported (recognized as belonging to a metric this registry
// deliberately rejects), unrecognized (left alone, verbatim, never
// coerced), or ambiguous (Wave B / finding #55 re-audit - see below). A
// header can never land in more than one bucket - the adapter's own
// alias table always wins over the shared unsupported list when the SAME
// header text happens to appear in both (it never does in practice,
// since the two tables are deliberately disjoint, but recognized is
// checked first for safety).
//
// COLLISION SAFETY (the re-audit's own finding): folding underscores/
// hyphens to spaces (normalizeHeaderKey) means two DIFFERENTLY-SPELLED
// real headers (e.g. a sheet with both "Post_ID" and "Post-ID") can now
// normalize to the same canonical field. Before this fix, both were
// inserted into `recognized` under their own distinct raw-header keys,
// and `fieldValueGetter` (below) would then silently let whichever one
// came LAST in column order win, discarding the other's entire column
// with zero indication anywhere. Fixed by grouping every header that
// WOULD recognize to the same field first: exactly one candidate keeps
// it in `recognized`; two or more moves the field to `ambiguous` instead
// (never guessed) with every colliding raw header preserved for the
// caller to surface.
export function classifyHeaders<TFieldId extends string>(headers: string[], aliasMap: HeaderAliasMap<TFieldId>): HeaderClassification<TFieldId> {
  const recognizedLookup = buildLookup(aliasMap);
  const unsupportedLookup = buildLookup(SHARED_UNSUPPORTED_HEADER_ALIASES);

  const candidatesByField = new Map<TFieldId, string[]>();
  const unsupported = new Map<string, UnsupportedMetricId>();
  const unrecognized: string[] = [];

  for (const header of headers) {
    const key = normalizeHeaderKey(header);
    const recognizedField = recognizedLookup.get(key);
    if (recognizedField !== undefined) {
      const existing = candidatesByField.get(recognizedField);
      if (existing) existing.push(header);
      else candidatesByField.set(recognizedField, [header]);
      continue;
    }
    const unsupportedField = unsupportedLookup.get(key);
    if (unsupportedField !== undefined) {
      unsupported.set(header, unsupportedField);
      continue;
    }
    unrecognized.push(header);
  }

  const recognized = new Map<string, TFieldId>();
  const ambiguous = new Map<TFieldId, string[]>();
  for (const [fieldId, rawHeaders] of candidatesByField) {
    if (rawHeaders.length === 1) recognized.set(rawHeaders[0]!, fieldId);
    else ambiguous.set(fieldId, rawHeaders);
  }

  return { recognized, unsupported, unrecognized, ambiguous };
}

// A generic header-keyed row (exactly what the xlsx-parser hands back
// per data row - see xlsx-parser.ts).
export type RawSheetRow = Record<string, unknown>;

// Reads a recognized field's raw cell value out of one row, given the
// classification's recognized map (canonical field id -> the ORIGINAL
// header text it was recognized under, inverted here for lookup by
// field id instead of by header).
export function fieldValueGetter<TFieldId extends string>(recognized: Map<string, TFieldId>, row: RawSheetRow): (fieldId: TFieldId) => unknown {
  const byFieldId = new Map<TFieldId, string>();
  for (const [header, fieldId] of recognized) byFieldId.set(fieldId, header);
  return (fieldId: TFieldId) => {
    const header = byFieldId.get(fieldId);
    return header === undefined ? undefined : row[header];
  };
}

function toSafeString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const str = typeof value === "string" ? value : String(value);
  const trimmed = str.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export { toSafeString };
export type { AnalyticsMetricId };
export { isUnsupportedMetricId };
