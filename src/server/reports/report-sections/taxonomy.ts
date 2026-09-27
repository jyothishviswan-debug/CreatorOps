// Reports Final-Master (spec section 3): controlled report taxonomy. A Content item may belong to
// MORE than one Narrative/Topic (and, in principle, more than one Content Pillar) - so topic totals
// may legitimately overlap and are never silently treated as additive/exclusive. Taxonomy is a
// REPORTING/labeling concept only - it never owns Content lifecycle truth (section 3's own "Taxonomy
// does not own Content lifecycle truth").
export const REPORT_TAXONOMY_DIMENSIONS = ["programme", "initiative_event", "narrative_topic", "content_pillar", "content_format", "campaign_phase"] as const;
export type ReportTaxonomyDimension = (typeof REPORT_TAXONOMY_DIMENSIONS)[number];

export type TaggedItem = { itemId: string; tags: string[]; metricValue: number | null };

export type TaxonomyBreakdownRow = { tag: string; itemCount: number; metricSum: number | null };

export type TaxonomyBreakdownResult = {
  rows: TaxonomyBreakdownRow[];
  totalDistinctItems: number;
  sumAcrossTags: number;
  overlapPresent: boolean;
  overlapNote: string;
};

// Builds a per-tag breakdown of a dimension (e.g. narrative_topic) that EXPLICITLY discloses overlap:
// `sumAcrossTags` can legitimately exceed `totalDistinctItems` when items carry more than one tag -
// this is never hidden or "corrected" by only counting each item once.
export function buildTaxonomyBreakdown(items: TaggedItem[]): TaxonomyBreakdownResult {
  const byTag = new Map<string, { itemCount: number; metricSum: number | null }>();
  for (const item of items) {
    for (const tag of item.tags) {
      const entry = byTag.get(tag) ?? { itemCount: 0, metricSum: null };
      entry.itemCount += 1;
      if (item.metricValue !== null) entry.metricSum = (entry.metricSum ?? 0) + item.metricValue;
      byTag.set(tag, entry);
    }
  }
  const rows: TaxonomyBreakdownRow[] = [...byTag.entries()].map(([tag, v]) => ({ tag, itemCount: v.itemCount, metricSum: v.metricSum }));
  const sumAcrossTags = rows.reduce((sum, r) => sum + r.itemCount, 0);
  const totalDistinctItems = items.length;
  const overlapPresent = sumAcrossTags > totalDistinctItems;
  return {
    rows,
    totalDistinctItems,
    sumAcrossTags,
    overlapPresent,
    overlapNote: overlapPresent
      ? `A Content item may belong to more than one Narrative/Topic - the ${sumAcrossTags} tag-assignments above come from only ${totalDistinctItems} distinct items. Topic totals are NOT additive; do not sum them to reconstruct a total.`
      : "No item in this run carries more than one tag for this dimension in this run.",
  };
}
