import { createHash } from "node:crypto";

// Step 13A: the ONE place that defines a review period and a review's
// deterministic identity. Pure - no I/O.
//
// Timezone rule: every period boundary and every "event date" in this
// module is a UTC calendar date (YYYY-MM-DD). A month starts on the first
// day at 00:00:00.000 UTC and ends on its last day at 23:59:59.999 UTC
// (`periodEnd` is the last day, inclusive). There is no local-timezone
// interpretation anywhere.

export type ReviewPeriod = { periodKey: string; periodStart: string; periodEnd: string };

const PERIOD_KEY_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

// Number of days in the given month (month is 1-12), leap-year correct.
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

// Strictly parses a `YYYY-MM` key (a real month, four-digit year) and
// derives the explicit first/last UTC calendar dates. Returns null for
// anything that is not exactly a valid key (no trimming, no coercion).
export function derivePeriod(periodKey: unknown): ReviewPeriod | null {
  if (typeof periodKey !== "string") return null;
  const match = PERIOD_KEY_PATTERN.exec(periodKey);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  if (year < 1970) return null;

  return {
    periodKey,
    periodStart: `${match[1]}-${match[2]}-01`,
    periodEnd: `${match[1]}-${match[2]}-${pad2(daysInMonth(year, month))}`,
  };
}

// The current UTC calendar date (YYYY-MM-DD) for a given instant.
export function utcDateOf(instant: Date): string {
  return instant.toISOString().slice(0, 10);
}

// A review may not be generated for a month that has not started yet.
export function isFuturePeriod(period: ReviewPeriod, now: Date): boolean {
  return period.periodStart > utcDateOf(now);
}

// Deterministic, opaque, stable review identity: one Partner + one period.
// It is also the head document id, so concurrent first generations collapse
// onto the same document. The hash is over the partnerRef (an opaque
// random ref) and the validated period key.
export function reviewRefFor(partnerRef: string, periodKey: string): string {
  return `pr_${createHash("sha256").update(`${partnerRef}|${periodKey}`).digest("hex").slice(0, 20)}`;
}

export function isValidReviewRef(value: unknown): value is string {
  return typeof value === "string" && /^pr_[0-9a-f]{20}$/.test(value);
}

const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

// Parses a leading `YYYY-MM-DD` (a real calendar date) out of a date-only
// string or an ISO-8601 date-time string. Returns null when the value is
// not confidently a date. Used for reporting-period bounds, whose format
// Analytics does not enforce.
export function parseLeadingUtcDate(value: string): string | null {
  const head = value.trim().slice(0, 10);
  const match = DATE_ONLY_PATTERN.exec(head);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  return head;
}

// The UTC calendar date an ISO instant (or date-only string) falls on.
// A date-only value is its own date; a date-time is converted to UTC.
export function toUtcDate(value: string): string | null {
  const trimmed = value.trim();
  if (DATE_ONLY_PATTERN.test(trimmed)) return parseLeadingUtcDate(trimmed);
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
  return utcDateOf(parsed);
}

// The instant an Assignment/Content due value denotes: a date-only value
// (`YYYY-MM-DD`) is due at the END of that UTC day; a full date-time is
// due at exactly that instant. Returns null when unparseable.
export function dueInstantMs(value: string): number | null {
  const trimmed = value.trim();
  if (DATE_ONLY_PATTERN.test(trimmed)) {
    const date = parseLeadingUtcDate(trimmed);
    if (!date) return null;
    return Date.parse(`${date}T23:59:59.999Z`);
  }
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? null : parsed;
}

// True when the inclusive UTC-date range [start, end] overlaps the period
// (boundaries inclusive on both sides). Ranges with start > end are
// invalid and never overlap.
export function dateRangeOverlapsPeriod(start: string, end: string, period: ReviewPeriod): boolean {
  if (start > end) return false;
  return start <= period.periodEnd && end >= period.periodStart;
}
