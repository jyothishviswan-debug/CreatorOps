import type { ReportDefinition, ReportResult, ReportRow } from "../types";
import { formatReportingPeriodLabel } from "./period-label";
import type { ReportCoverSection, ReportKpiItem, ReportKpiSummarySection, ReportTableSection, TableColumn } from "./types";

// Shared, small formatting/assembly helpers used by every template's section builder - kept here
// rather than duplicated per-builder, per spec section 6's "do not hand-code seven unrelated PDFs".
export function titleCaseFromCamel(id: string): string {
  const spaced = id.replace(/_/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function formatMetricValue(value: number | string | null): string {
  if (value === null) return "Not available";
  if (typeof value === "number") return Number.isInteger(value) ? value.toLocaleString("en-IN") : value.toLocaleString("en-IN", { maximumFractionDigits: 2 });
  return value;
}

// Spec section 3: a human, management-facing cover - `platformsLine` is a genuinely source-backed
// "platforms included"/region-portfolio line (e.g. "Instagram + YouTube", or "South Region · Instagram
// + YouTube" if a real region parameter existed) and is OMITTED (not passed) unless a caller can back it
// with a real report parameter/evidence fact - never fabricated here.
export function buildCoverSection(params: { definition: ReportDefinition; templateTitle: string; result: ReportResult; scopeLine?: string; platformsLine?: string }): ReportCoverSection {
  return {
    kind: "cover",
    sectionType: "cover",
    mode: "EVIDENCE",
    title: params.templateTitle,
    subtitle: params.definition.purpose,
    scopeLine: params.scopeLine ?? params.result.scopeSummary.note,
    periodLine: formatReportingPeriodLabel(params.result.appliedFilters.period, params.result.appliedFilters.periods),
    platformsLine: params.platformsLine,
    generatedAtLine: `Generated: ${params.result.generatedAt}`,
    evidenceCutoffLine: `Evidence cutoff: ${params.result.evidenceCutoff}`,
  };
}

export function buildKpiSummaryFromMetrics(title: string, metrics: Record<string, number | string | null>): ReportKpiSummarySection {
  const items: ReportKpiItem[] = Object.entries(metrics).map(([id, value]) => ({ label: titleCaseFromCamel(id), value: formatMetricValue(value), unavailable: value === null }));
  return { kind: "kpi_summary", sectionType: "kpi_summary", mode: "EVIDENCE", title, items };
}

// Bug class B (this stage's completion report): a raw internal *Ref/*Id field must never be a
// table's PRIMARY (first, most prominent) column when a resolved displayName/title/label-shaped
// sibling field exists on the same row - see e.g. Operations' target-display.ts / Task detail's
// "Task reference" row, and Notes/Meetings' own equivalent "raw ref is a labeled secondary field,
// never the primary label" discipline. Fixed HERE, generically, rather than per-family, since the
// same generic column-selection logic (buildGenericTable/buildBaselineSections) is what let a raw ref
// become a table's own first column in the first place - see families/partner-portfolio.ts's
// partnerRef and the "Cross-Platform Partner Contribution" table for the two shapes this fixes.
const REF_ID_SUFFIX = /(?:Ref|Id)$/;
const NAME_FIELD_PATTERN = /(?:DisplayName|Name)$/i;

export function isRawRefColumnId(id: string): boolean {
  return REF_ID_SUFFIX.test(id);
}

export function isNameColumnId(id: string): boolean {
  return (NAME_FIELD_PATTERN.test(id) || id === "title" || id === "label") && !isRawRefColumnId(id);
}

// Reorders a raw list of row-object keys for DISPLAY only (never mutates the row data itself): the
// first genuinely name-shaped column becomes the primary (first) column, every raw *Ref/*Id column is
// demoted to the end as a narrow secondary column, and every other field keeps its original relative
// order in between. A row with no name-shaped column at all (nothing to promote) is returned
// unchanged - this never REMOVES a ref column, only demotes it, so traceability is preserved.
export function orderColumnsForDisplay(columnIds: string[]): string[] {
  const nameId = columnIds.find(isNameColumnId);
  if (!nameId) return columnIds;
  const refIds = columnIds.filter((id) => isRawRefColumnId(id) && id !== nameId);
  if (refIds.length === 0) return columnIds;
  const rest = columnIds.filter((id) => id !== nameId && !refIds.includes(id));
  return [nameId, ...rest, ...refIds];
}

function isPrimitiveCellValue(value: unknown): value is string | number | boolean | null {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

// Spec section 7: a column id ending in this suffix is a PAIRED link-target field (e.g. `postUrlHref`,
// `partnerAnalyticsHref`) that supplies a cell's clickable URL while a sibling human-label column (e.g.
// `postUrl` itself carrying the literal text "Open Post") supplies the cell's VISIBLE text - see
// pdf-renderer.ts's drawTable. The Href field must never be rendered as its own column (it would either
// show a raw URL as ordinary text, which spec section 7 forbids, or a meaningless duplicate), but it
// does stay on the row object itself so drawTable can look it up.
const HREF_SUFFIX = /Href$/;
function isLinkTargetColumnId(id: string): boolean {
  return HREF_SUFFIX.test(id);
}

// Spec section 6 ("Remove raw refs from all published PDFs ... main tables, appendices, footers, link
// labels, case-study sections, data directories all included") and section 14 ("do not fill a
// management PDF with an all-Not-available column if it contributes no information"): a column is
// dropped ENTIRELY (not merely demoted to the end, which orderColumnsForDisplay already did and still
// does for anything that slips through this) when it is a raw *Ref/*Id column with a real name/label
// sibling already promoted to the primary column, or when every row's value for it is null. Both
// checks are conservative: a *Ref/*Id column with NO name-shaped sibling (nothing to promote instead)
// is still demoted-but-kept via orderColumnsForDisplay, since dropping the only identifying field would
// leave a genuinely unlabeled row; an all-null column is only dropped when there is at least one row to
// judge it by, and at least one OTHER column would remain (never dropped down to zero columns).
function dropUninformativeColumns(columnIds: string[], bounded: ReportRow[]): string[] {
  const nameId = columnIds.find(isNameColumnId);
  const withoutLinkTargets = columnIds.filter((id) => !isLinkTargetColumnId(id));
  const withoutRawRefs = nameId ? withoutLinkTargets.filter((id) => id === nameId || !isRawRefColumnId(id)) : withoutLinkTargets;
  if (bounded.length === 0) return withoutRawRefs;
  const withoutAllNull = withoutRawRefs.filter((id) => !bounded.every((r) => r[id] === null));
  return withoutAllNull.length > 0 ? withoutAllNull : withoutRawRefs;
}

// Generic row->table conversion used by the baseline template treatment (see build-sections.ts) and
// by any full builder that has an already-shaped ReportRow[] section it wants to show verbatim.
export function buildGenericTable(title: string, rows: ReportRow[], options?: { note?: string; maxRows?: number; sectionType?: ReportTableSection["sectionType"] }): ReportTableSection {
  const cap = options?.maxRows ?? 100;
  const bounded = rows.slice(0, cap);
  const rawColumnIds = bounded.length > 0 ? Object.keys(bounded[0]!) : [];
  // Defense in depth (this stage's own root-cause finding for Finance Status / Operations Attention:
  // a family executor accidentally passing a nested-object field, e.g. `counterparty: {type,ref,
  // displayName}` or `target: {targetType,targetRef}`, straight into a table row) - a column is only
  // ever shown when EVERY row's value for it is a genuine scalar; one that fails this check is dropped
  // from the table entirely rather than crashing the PDF renderer's text layout or printing
  // "[object Object]". The family executors themselves are also fixed to never produce this shape
  // (see families/finance-status.ts and families/operations-attention.ts) - this is a second,
  // independent guard, not a substitute for that fix.
  const safeColumnIds = rawColumnIds.filter((id) => bounded.every((r) => isPrimitiveCellValue(r[id])));
  const informativeColumnIds = dropUninformativeColumns(safeColumnIds, bounded);
  const columnIds = orderColumnsForDisplay(informativeColumnIds);
  const columns: TableColumn[] = columnIds.map((id) => ({ id, label: titleCaseFromCamel(id), numeric: bounded.every((r) => typeof r[id] === "number" || r[id] === null) }));
  return {
    kind: "table",
    sectionType: options?.sectionType ?? "ranked_table",
    mode: "EVIDENCE",
    title,
    note: rows.length > cap ? `Showing the first ${cap} of ${rows.length} rows.` : options?.note,
    columns,
    rows: bounded,
    emptyMessage: "No rows in this run.",
  };
}
