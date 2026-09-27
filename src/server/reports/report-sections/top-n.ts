// Reports Final-Master (spec section 9): a configurable Top-N framework (Top 3 / 5 / 10), ranked by
// exactly one explicit metric (Views, Engagement, Likes, Comments, Output/Post count). The title
// always states the ranking metric - never a generic "Top Content".
import type { ReportTableSection } from "./types";

export const TOP_N_OPTIONS = [3, 5, 10] as const;
export type TopNOption = (typeof TOP_N_OPTIONS)[number];

export type TopNItem = { label: string; metricValue: number | null; url?: string | null; context?: string | null };

export function buildTopNContentTable(params: { title: string; metricLabel: string; items: TopNItem[]; n: TopNOption; platformOrContext?: string }): ReportTableSection {
  const ranked = params.items
    .filter((i): i is TopNItem & { metricValue: number } => i.metricValue !== null && i.metricValue !== undefined)
    .sort((a, b) => b.metricValue - a.metricValue)
    .slice(0, params.n);
  const title = `${params.title} - Top ${params.n} by ${params.metricLabel}${params.platformOrContext ? ` (${params.platformOrContext})` : ""}`;
  return {
    kind: "table",
    sectionType: "top_n_content",
    mode: "EVIDENCE",
    title,
    columns: [
      { id: "rank", label: "Rank", numeric: true },
      { id: "label", label: "Content" },
      { id: "metricValue", label: params.metricLabel, numeric: true },
      { id: "context", label: "Context" },
    ],
    rows: ranked.map((item, index) => ({ rank: index + 1, label: item.label, metricValue: item.metricValue, context: item.context ?? null })),
    emptyMessage: "No Content items had a reported value for this metric.",
  };
}
