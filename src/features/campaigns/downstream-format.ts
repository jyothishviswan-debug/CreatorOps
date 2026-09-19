// Step 12C.1: pure display formatting for Campaign Detail's downstream
// summary cards - counts/labels only, never a derived metric. Kept out of
// the component so the singular/plural, "200+" truncation and Analytics
// readiness wording are exactly unit-testable.
import type { CampaignAnalyticsReadiness } from "@/server/analytics/campaign-readiness";

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return count === 1 ? singular : pluralForm;
}

// "3" or, when the server hit its documented per-Campaign bound and the
// number is therefore only a lower bound, "200+".
export function countLabel(count: number, truncated: boolean): string {
  return truncated ? `${count}+` : String(count);
}

export function assignmentsTotalLabel(total: number, truncated: boolean): string {
  return `${countLabel(total, truncated)} ${plural(truncated ? 2 : total, "Assignment")}`;
}

export function partnersLabel(count: number, truncated: boolean): string {
  return `${countLabel(count, truncated)} ${plural(truncated ? 2 : count, "Partner")}`;
}

// Truthful readiness wording from the accepted Step 12A/12B helper's own
// numbers - never an invented metric.
export function analyticsReadinessLabel(readiness: Pick<CampaignAnalyticsReadiness, "matchedCount" | "unmatchedCount" | "hasLinkedSourceRecords">): string {
  const total = readiness.matchedCount + readiness.unmatchedCount;
  if (total === 0) return "No Content records yet";
  if (!readiness.hasLinkedSourceRecords || readiness.matchedCount === 0) return "No source data linked yet";
  return `${readiness.matchedCount} of ${total} Content ${plural(total, "record")} ${plural(readiness.matchedCount, "has", "have")} matched data`;
}
