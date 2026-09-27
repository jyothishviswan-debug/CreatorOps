// Reports Final-Master (spec section 7): Source-Metric Leaders as a first-class reusable section.
// Ranks Partners (or any labeled entity) independently by ONE explicit source metric at a time.
// Never a blended score, and never labeled "Overall Performance" - the caller-supplied `metricLabel`
// is always the literal metric name, and buildSourceMetricLeadersTable puts it directly in the title.
import type { ReportTableSection } from "./types";

export type LeaderCandidate = { label: string; value: number | null; context?: string };

export type LeaderRow = { rank: number; label: string; value: number; context: string | null };

// Ties share the same rank number (dense ranking) - never an arbitrary insertion-order tiebreak
// disguised as a rank. Null-valued candidates are excluded entirely (missing != zero - a candidate
// with no evidence for this metric is not ranked last with a fabricated 0).
export function rankByMetric(candidates: LeaderCandidate[], limit: number): LeaderRow[] {
  const withValues = candidates.filter((c): c is LeaderCandidate & { value: number } => c.value !== null && c.value !== undefined);
  const sorted = [...withValues].sort((a, b) => b.value - a.value);
  const rows: LeaderRow[] = [];
  let rank = 0;
  let lastValue: number | null = null;
  for (const candidate of sorted) {
    if (rows.length >= limit) break;
    if (lastValue === null || candidate.value !== lastValue) rank += 1;
    lastValue = candidate.value;
    rows.push({ rank, label: candidate.label, value: candidate.value, context: candidate.context ?? null });
  }
  return rows;
}

export function buildSourceMetricLeadersTable(params: { metricLabel: string; metricId: string; platformOrContext?: string; candidates: LeaderCandidate[]; limit: number }): ReportTableSection {
  const rows = rankByMetric(params.candidates, params.limit);
  const title = params.platformOrContext ? `Source-Metric Leaders - ${params.metricLabel} (${params.platformOrContext})` : `Source-Metric Leaders - ${params.metricLabel}`;
  return {
    kind: "table",
    sectionType: "source_metric_leaders",
    mode: "EVIDENCE",
    title,
    note: `Ranked by exactly one explicit metric (${params.metricLabel}) - never a blended score.`,
    columns: [
      { id: "rank", label: "Rank", numeric: true },
      { id: "label", label: "Partner" },
      { id: "value", label: params.metricLabel, numeric: true },
      { id: "context", label: "Context" },
    ],
    rows: rows.map((r) => ({ rank: r.rank, label: r.label, value: r.value, context: r.context })),
    emptyMessage: "No candidates had a reported value for this metric.",
  };
}
