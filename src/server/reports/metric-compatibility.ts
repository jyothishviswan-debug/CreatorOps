// Reports Final-Master (spec section 11): the metric-COMBINATION compatibility registry.
//
// This is deliberately NOT the same thing as Analytics' own src/server/analytics/metric-registry.ts
// (that registry answers "is this one raw per-record field value well-formed?" - a validity
// question). This registry answers a completely different question: "is it semantically safe to ADD
// TOGETHER this metric's values from two different platforms (or two different source rows) into one
// combined number?" No Reports family imports this to decide whether to COMPUTE a per-platform figure
// (every family already does that safely on its own) - this registry exists so any NEW section-level
// combination (Source-Metric Leaders across platforms, a combined KPI tile, a cross-platform total)
// goes through one explicit, testable gate instead of ad-hoc addition, per spec section 11: "This must
// be enforced in execution code, not merely explained in the UI."
//
// The three examples spec section 11 gives verbatim are encoded exactly as given:
//   - Content/Post count: combine only when definitions align (both platforms count "one published
//     item" the same way - true today, since Analytics defines exactly one publishedContent row per
//     matched platform post/video, so a raw COUNT of items is safe to sum - see
//     cross_platform_partner_programme.ts's own publishedContentTotalAcrossPlatforms, the one existing
//     precedent this registry now formalizes).
//   - Views: combine only when compatible (Instagram "views" and YouTube "views" are not proven
//     semantically identical - Instagram counts video plays with its own dedupe/replay rules, YouTube
//     counts differently - so this registry marks it INCOMPATIBLE until a real product decision says
//     otherwise. Per-platform Views stay separate everywhere today; nothing in this stage changes that.
//   - Engagement: same reasoning and same INCOMPATIBLE default as Views.
//   - Followers/Subscribers: NEVER compatible (the same person can follow/subscribe on more than one
//     platform - summing double-counts audience). Hard-coded incompatible, not just defaulted.
//   - Reach/Impressions: not modeled by Analytics at all in this product - never invented, never
//     combined (see catalog.ts's own campaign_performance limitations).
export type ReportCombinableMetricId = "publishedContentCount" | "views" | "engagement" | "likes" | "comments" | "followers" | "subscribers" | "reach" | "impressions";

export type MetricCompatibilityEntry = {
  metricId: ReportCombinableMetricId;
  combinableAcrossPlatforms: boolean;
  reason: string;
};

// Keyed explicitly (never inferred from a string pattern) - every entry is a reviewed product
// decision, not a guess.
export const REPORT_METRIC_COMPATIBILITY: Record<ReportCombinableMetricId, MetricCompatibilityEntry> = {
  publishedContentCount: {
    metricId: "publishedContentCount",
    combinableAcrossPlatforms: true,
    reason: "Each Content item is published on exactly one platform (no double-counting) and every platform reports the same unit - a raw count of items. Safe to sum.",
  },
  views: {
    metricId: "views",
    combinableAcrossPlatforms: false,
    reason: "Instagram and YouTube each define \"views\" with their own counting/replay rules - not proven semantically identical. Kept separate per platform everywhere in this product.",
  },
  engagement: {
    metricId: "engagement",
    combinableAcrossPlatforms: false,
    reason: "Engagement is a platform-native interaction composite with no shared cross-platform definition. Kept separate per platform everywhere in this product.",
  },
  likes: {
    metricId: "likes",
    combinableAcrossPlatforms: false,
    reason: "Likes are a platform-native interaction figure with no proven shared cross-platform definition. Kept separate per platform.",
  },
  comments: {
    metricId: "comments",
    combinableAcrossPlatforms: false,
    reason: "Comments are a platform-native interaction figure with no proven shared cross-platform definition. Kept separate per platform.",
  },
  followers: {
    metricId: "followers",
    combinableAcrossPlatforms: false,
    reason: "The same person can follow a Partner on more than one platform - summing followers across platforms double-counts audience. Never combined.",
  },
  subscribers: {
    metricId: "subscribers",
    combinableAcrossPlatforms: false,
    reason: "The same person can subscribe/follow a Partner on more than one platform - summing double-counts audience. Never combined.",
  },
  reach: {
    metricId: "reach",
    combinableAcrossPlatforms: false,
    reason: "Reach is not modeled by Analytics in this product at all - never invented, never combined, never substituted with views.",
  },
  impressions: {
    metricId: "impressions",
    combinableAcrossPlatforms: false,
    reason: "Impressions are not modeled by Analytics in this product at all - never invented, never combined, never substituted with views.",
  },
};

export function isMetricCombinableAcrossPlatforms(metricId: ReportCombinableMetricId): boolean {
  return REPORT_METRIC_COMPATIBILITY[metricId]?.combinableAcrossPlatforms ?? false;
}

export type CombinedMetricOutcome = { combined: true; value: number | null } | { combined: false; reason: string };

// The one enforcement point every section builder that might want a cross-platform total MUST call
// through - never a bare `+` on two platform figures. Values are `number | null` (missing != zero,
// per section 10) - a null input is treated as "no evidence for that platform", not zero, and is
// simply excluded from the sum (never coerced).
export function combineMetricAcrossPlatforms(metricId: ReportCombinableMetricId, valuesByPlatform: Record<string, number | null>): CombinedMetricOutcome {
  const entry = REPORT_METRIC_COMPATIBILITY[metricId];
  if (!entry || !entry.combinableAcrossPlatforms) {
    return { combined: false, reason: entry?.reason ?? `Unknown metric "${metricId}" - never combined without an explicit compatibility entry.` };
  }
  const known = Object.values(valuesByPlatform).filter((v): v is number => v !== null && v !== undefined);
  if (known.length === 0) return { combined: true, value: null };
  return { combined: true, value: known.reduce((sum, v) => sum + v, 0) };
}
