// Step 12D: pure, unit-testable display helpers for the Instagram / YouTube
// Analytics views - display shaping only, never re-derives a stored value.
import type { PlatformViewId } from "@/server/analytics/platform-view-metrics";

const DATE_LOCALE = "en-GB";

// "12 Aug 2026" from a record's REAL posted date-time (UTC, so the server
// render is stable regardless of the host time zone). `null` for a missing or
// unparseable value - the caller then falls back to the reporting period,
// never to an invented date.
export function formatPublishedDate(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(DATE_LOCALE, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}

// Data Explorer deep link for a platform view. Only query parameters the
// Explorer page genuinely honors are ever emitted: `platform` (normalized ids
// only - see parseExplorerPlatformParam) and `recordKind`.
export function platformExplorerHref(platform: PlatformViewId, recordKind: "content" | "channel" = "content"): string {
  const params = new URLSearchParams({ platform, recordKind });
  return `/analytics/explorer?${params.toString()}`;
}

// ---- Trend chart geometry -------------------------------------------------------
// Same viewBox/plot area as the accepted TrendGrid (x 0..260, baseline y=98,
// 85 units of height), but scaled to the series' OWN maximum (TrendGrid's
// fixed /20 scale is tuned to its demo data) and with GAPS: a `null` period is
// never plotted and never joins its neighbours - the line breaks there.
export const TREND_PLOT_WIDTH = 260;
const TREND_BASELINE_Y = 98;
const TREND_PLOT_HEIGHT = 85;

export type TrendPlotPoint = { x: number; y: number; value: number };

export function computeTrendGeometry(values: (number | null)[]): { segments: TrendPlotPoint[][]; points: TrendPlotPoint[] } {
  const realValues = values.filter((value): value is number => value !== null);
  const max = realValues.length > 0 ? Math.max(...realValues) : 0;
  const xFor = (index: number) => (values.length > 1 ? (index * TREND_PLOT_WIDTH) / (values.length - 1) : TREND_PLOT_WIDTH / 2);
  const yFor = (value: number) => (max > 0 ? TREND_BASELINE_Y - (value / max) * TREND_PLOT_HEIGHT : TREND_BASELINE_Y);

  const segments: TrendPlotPoint[][] = [];
  const points: TrendPlotPoint[] = [];
  let current: TrendPlotPoint[] = [];
  values.forEach((value, index) => {
    if (value === null) {
      if (current.length > 0) segments.push(current);
      current = [];
      return;
    }
    const point = { x: xFor(index), y: yFor(value), value };
    points.push(point);
    current.push(point);
  });
  if (current.length > 0) segments.push(current);
  return { segments, points };
}

export type TrendChange = { latestIndex: number; latest: number; changePct: number | null };

// The series' latest REAL point, and its change vs the IMMEDIATELY preceding
// period - only when that neighbour is itself a real, non-zero value (a gap or
// zero baseline yields `null`, never NaN/Infinity and never a fabricated delta).
export function describeLatestTrendChange(values: (number | null)[]): TrendChange | null {
  let latestIndex = -1;
  for (let i = values.length - 1; i >= 0; i--) {
    if (values[i] !== null) {
      latestIndex = i;
      break;
    }
  }
  if (latestIndex < 0) return null;
  const latest = values[latestIndex]!;
  const previous = latestIndex > 0 ? values[latestIndex - 1] : null;
  const changePct = previous != null && previous !== 0 ? ((latest - previous) / previous) * 100 : null;
  return { latestIndex, latest, changePct };
}
