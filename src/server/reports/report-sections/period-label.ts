// Reports PDF Composition & Management-Publication Polish (spec section 3): a single, shared formatter
// for a human, management-facing reporting-period label - used both on the PDF cover (buildCoverSection
// in helpers.ts) and in the PDF running header (generate-artifacts.ts's periodLine) so the two never
// drift apart. Replaces the old implementation-oriented fallback string "Period: full actor scope" and
// the raw "Period: 2026-08" machine-key display with a genuine date-range/monthly label when the
// applied filter is recognizably a YYYY-MM period key, and an honest, calm phrase otherwise - never a
// fabricated region/scope claim (spec: "if region/portfolio is not a real report parameter, omit it
// instead of inventing it").
const YEAR_MONTH_PATTERN = /^(\d{4})-(\d{2})$/;

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// "1-31 August 2026" style range for a real YYYY-MM period key - the exact shape the reference Monthly
// report's own cover uses ("Reporting Period: 1 - 31 August 2026" in spirit; en dash here for a cleaner
// PDF glyph). Returns null when `raw` is not a genuine YYYY-MM key, so the caller can fall back to
// showing the raw applied value as-is rather than a nonsense date.
export function formatYearMonthRange(raw: string): string | null {
  const match = YEAR_MONTH_PATTERN.exec(raw);
  if (!match) return null;
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  if (monthIndex < 0 || monthIndex > 11) return null;
  const monthName = MONTH_NAMES[monthIndex];
  const lastDay = new Date(year, monthIndex + 1, 0).getDate();
  return `1–${lastDay} ${monthName} ${year}`;
}

// The one honest fallback phrase used whenever no period filter was actually applied - replaces the
// prior implementation-oriented "Period: full actor scope" string (spec section 16: no internal/query
// vocabulary in finalized artifact content).
export const NO_PERIOD_FILTER_LABEL = "All available reporting data";

export function formatReportingPeriodLabel(period: string | undefined | null, periods: string | undefined | null): string {
  if (period) {
    const range = formatYearMonthRange(period);
    return `Reporting Period: ${range ?? period}`;
  }
  if (periods) return `Reporting Periods: ${periods}`;
  return `Reporting Period: ${NO_PERIOD_FILTER_LABEL}`;
}
