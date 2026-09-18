// Step 12A section 5: the one server-authoritative metric registry,
// shared by import validation, matching-adjacent read/normalize code, and
// read-model aggregation. Nothing else in Analytics is allowed to invent
// a second interpretation of "what counts as a supported metric" or "what
// missing means" - every metric read goes through parseSupportedMetric
// below.

export const ANALYTICS_METRIC_IDS = [
  "postId",
  "postUrl",
  "postDateTime",
  "postType",
  "postMediaUrl",
  "postCaption",
  "comments",
  "likes",
  "views",
  "profileFollowers",
  "accountUsername",
  // Only ever populated when the SOURCE FILE explicitly reports its own
  // "Engagement" column - never computed/derived by any Analytics code
  // path. See UNSUPPORTED_METRIC_IDS' own comment for the blended-score
  // rule this is distinct from.
  "engagement",
  "accountOrChannelName",
] as const;
export type AnalyticsMetricId = (typeof ANALYTICS_METRIC_IDS)[number];

export function isAnalyticsMetricId(value: unknown): value is AnalyticsMetricId {
  return typeof value === "string" && (ANALYTICS_METRIC_IDS as readonly string[]).includes(value);
}

export type AnalyticsMetricKind = "identity" | "count" | "text" | "datetime" | "url";

export const ANALYTICS_METRIC_REGISTRY: Record<AnalyticsMetricId, { label: string; kind: AnalyticsMetricKind }> = {
  postId: { label: "Platform Content ID", kind: "identity" },
  postUrl: { label: "Post URL", kind: "url" },
  postDateTime: { label: "Post Date", kind: "datetime" },
  postType: { label: "Post Type", kind: "text" },
  postMediaUrl: { label: "Media URL", kind: "url" },
  postCaption: { label: "Caption", kind: "text" },
  comments: { label: "Comments", kind: "count" },
  likes: { label: "Likes", kind: "count" },
  views: { label: "Views", kind: "count" },
  profileFollowers: { label: "Profile Followers", kind: "count" },
  accountUsername: { label: "Account Username", kind: "identity" },
  engagement: { label: "Engagement (source-reported only)", kind: "count" },
  accountOrChannelName: { label: "Account/Channel Name", kind: "text" },
};

// Purely documentation/rejection - a header/field recognized as one of
// these is classified as an IGNORED COLUMN (safely dropped, noted
// informationally), never blocked, never silently synthesized into a
// supported field. "blendedPerformanceScore" documents the standing rule
// that Analytics never invents its own composite/blended score anywhere
// (read-models.ts's own interactions aggregation only ever sums
// explicitly source-reported compatible metrics).
export const UNSUPPORTED_METRIC_IDS = ["reach", "impressions", "shares", "saves", "watchTimeMinutes", "demographics", "authenticityScore", "blendedPerformanceScore"] as const;
export type UnsupportedMetricId = (typeof UNSUPPORTED_METRIC_IDS)[number];

export function isUnsupportedMetricId(value: unknown): value is UnsupportedMetricId {
  return typeof value === "string" && (UNSUPPORTED_METRIC_IDS as readonly string[]).includes(value);
}

// The ONE shared "what does missing/unparseable mean" helper - reused by
// every adapter and by read-model aggregation. Returns `null` (never `0`)
// for missing/blank/unparseable input, so "no data reported" is never
// confused with "reported as zero" anywhere downstream.
export function parseSupportedMetric(rawValue: unknown): number | null {
  if (rawValue === null || rawValue === undefined) return null;
  if (typeof rawValue === "number") return Number.isFinite(rawValue) ? rawValue : null;

  if (typeof rawValue === "string") {
    const trimmed = rawValue.trim();
    if (trimmed.length === 0) return null;
    // Tolerates thousands separators/commas and a trailing "%" - common
    // spreadsheet export artifacts - but never a currency symbol or
    // arbitrary text (that's a genuinely unparseable value, not a
    // formatting quirk).
    const cleaned = trimmed.replace(/,/g, "").replace(/%$/, "");
    if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

// Best-effort ISO-8601 normalization for a source-reported date/time
// string - returns `null` (never throws, never a blocking error) when the
// raw value cannot be confidently parsed. Used by every content adapter
// for postDateTime.
export function parseSupportedDateTime(rawValue: unknown): string | null {
  if (rawValue === null || rawValue === undefined) return null;
  if (rawValue instanceof Date) return Number.isNaN(rawValue.getTime()) ? null : rawValue.toISOString();

  if (typeof rawValue === "number") {
    // Excel serial date (days since 1899-12-30, with the well-known 1900
    // leap-year bug baked into every spreadsheet tool) - only trusted
    // within a sane range, never blindly cast.
    if (rawValue <= 0 || rawValue > 100000) return null;
    const epoch = Date.UTC(1899, 11, 30);
    const ms = epoch + rawValue * 24 * 60 * 60 * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  if (typeof rawValue === "string") {
    const trimmed = rawValue.trim();
    if (trimmed.length === 0) return null;
    const parsed = new Date(trimmed);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }

  return null;
}
