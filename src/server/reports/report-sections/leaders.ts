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
  // Spec section 14's "do not fill a management PDF with an all-Not-available column if it contributes
  // no information" applies here too, even though this table's columns are hand-declared rather than
  // routed through buildGenericTable's own auto-omit guard: a caller (today, only the Monthly builder)
  // that never supplies a `context` for any ranked row would otherwise print "Not available" in that
  // column for every single row of every leaderboard - genuinely uninformative.
  const hasContext = rows.some((r) => r.context !== null);
  return {
    kind: "table",
    sectionType: "source_metric_leaders",
    mode: "EVIDENCE",
    title,
    // Spec section 8: the design-rule prose ("Ranked by exactly one explicit metric ... never a blended
    // score") used to repeat under EVERY leader table in the finalized PDF - a system design rule, not
    // management-report content. The title alone ("Source-Metric Leaders - Views (Instagram)") already
    // states the one ranking metric; no per-table caption is drawn any more (spec: "a concise section
    // caption is enough" - the section TITLE now serves as that caption).
    columns: [
      { id: "rank", label: "Rank", numeric: true },
      { id: "label", label: "Partner" },
      { id: "value", label: params.metricLabel, numeric: true },
      ...(hasContext ? [{ id: "context", label: "Context" }] : []),
    ],
    rows: rows.map((r) => ({ rank: r.rank, label: r.label, value: r.value, ...(hasContext ? { context: r.context } : {}) })),
    emptyMessage: "No candidates had a reported value for this metric.",
  };
}
