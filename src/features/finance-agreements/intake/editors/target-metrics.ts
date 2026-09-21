// Step 14B (intake): the Analytics-backed metrics a performance target can watch (pure). A target is MONITORING ONLY: it is stored
// with its always-false flag and never sits inside the commercial terms. Any other Analytics metric id can be typed
// ("Other metric"); it is a plain id, never a rule for any amount.
export type TargetMetric = { id: string; label: string; defaultUnit: string };

export const TARGET_METRICS: readonly TargetMetric[] = [
  { id: "followerGrowth", label: "Follower growth", defaultUnit: "followers" },
  { id: "reach", label: "Reach", defaultUnit: "accounts" },
  { id: "views", label: "Views", defaultUnit: "views" },
  { id: "engagement", label: "Engagement", defaultUnit: "%" },
  { id: "likes", label: "Likes", defaultUnit: "likes" },
  { id: "comments", label: "Comments", defaultUnit: "comments" },
];

export const OTHER_METRIC_OPTION = "__other";

export const isKnownTargetMetric = (metricId: string): boolean => TARGET_METRICS.some((metric) => metric.id === metricId);

// The label shown for a metric id: the known label, else the id as written (an "other" Analytics metric).
export function targetMetricLabel(metricId: string): string {
  return TARGET_METRICS.find((metric) => metric.id === metricId)?.label ?? (metricId.trim().length > 0 ? metricId.trim() : "Metric");
}

export const defaultUnitForMetric = (metricId: string): string => TARGET_METRICS.find((metric) => metric.id === metricId)?.defaultUnit ?? "";

// The value of the metric <select> for a row: a known id, the "other" marker (typed id / freshly chosen other), or "" (nothing chosen yet).
export function metricSelectValue(metricId: string, otherChosen: boolean): string {
  if (isKnownTargetMetric(metricId)) return metricId;
  return otherChosen || metricId.trim().length > 0 ? OTHER_METRIC_OPTION : "";
}
