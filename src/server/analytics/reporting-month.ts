// Step 12F: the pure, dependency-free "reporting month" rules behind the
// Partners Analytics workspace (and the optional ?month= of the Partner drill-
// down). Nothing here touches Firestore, a clock or an ActorContext, so every
// branch is directly Vitest-testable with synthetic input - and NOTHING here
// ever reads the current date: a "latest month" is always derived from the
// records' own imported reporting periods, never from the calendar.
//
// THE month membership rule (locked, one place):
//   A source record belongs to month M (`YYYY-MM`) iff it has a usable reporting
//   period that lies ENTIRELY within calendar month M - the period's start and
//   end (each parsed by their leading `YYYY-MM-DD`, exactly as the accepted
//   period helpers read them) fall in the same calendar month.
//   A record with NO reporting period, an UNPARSEABLE one (not a real leading
//   date, or end before start) or one that SPANS more than one calendar month is
//   NEVER forced into a month: it is excluded from month views and DISCLOSED,
//   with a count per reason.
// "Valid Analytics data" (for defaulting to the latest month) is exactly a record
// with a usable single-month period.

export const MONTH_PARAM_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

export const MAX_MONTH_OPTIONS = 12;

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] as const;

// ---- ?month= --------------------------------------------------------------------

export type ParsedMonthParam = {
  // The validated `YYYY-MM`, or null when absent / invalid.
  month: string | null;
  // true when a value WAS supplied but is not a valid month (garbage, a repeated
  // param, an out-of-range month): the caller treats it as absent and says so.
  invalid: boolean;
};

// Server-side validation of the raw query value (Next hands `string | string[] |
// undefined`). An absent / empty value is simply "no explicit month"; anything
// else that is not exactly `YYYY-MM` is invalid and NEVER interpreted.
export function parseMonthParam(input: unknown): ParsedMonthParam {
  if (input === undefined || input === null || input === "") return { month: null, invalid: false };
  if (typeof input === "string" && MONTH_PARAM_PATTERN.test(input)) return { month: input, invalid: false };
  return { month: null, invalid: true };
}

export function isValidMonthKey(value: unknown): value is string {
  return typeof value === "string" && MONTH_PARAM_PATTERN.test(value);
}

// ---- Labels / arithmetic ---------------------------------------------------------------

// "August 2026" - throws nothing: a non-month key is returned as-is.
export function monthLabel(month: string): string {
  if (!isValidMonthKey(month)) return month;
  return `${MONTH_NAMES[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
}

// "Aug 2026" - compact axis / column label.
export function shortMonthLabel(month: string): string {
  if (!isValidMonthKey(month)) return month;
  return `${MONTH_NAMES[Number(month.slice(5, 7)) - 1]!.slice(0, 3)} ${month.slice(0, 4)}`;
}

export function addMonths(month: string, delta: number): string {
  const year = Number(month.slice(0, 4));
  const zeroBased = Number(month.slice(5, 7)) - 1 + delta;
  const nextYear = year + Math.floor(zeroBased / 12);
  const nextMonth = ((zeroBased % 12) + 12) % 12;
  return `${String(nextYear).padStart(4, "0")}-${String(nextMonth + 1).padStart(2, "0")}`;
}

// `count` consecutive calendar months ending at (and including) `latest`, oldest
// first. A continuous calendar axis means a month without data is a visible GAP,
// never silently skipped (which would draw a line across the missing month).
export function calendarWindow(latest: string, count = MAX_MONTH_OPTIONS): string[] {
  return Array.from({ length: count }, (_, index) => addMonths(latest, index - (count - 1)));
}

// ---- Period -> month ------------------------------------------------------------------

export type ReportingPeriodInput = { start: string; end: string } | null | undefined;

export type PeriodMonthClass = { kind: "month"; month: string } | { kind: "no_period" } | { kind: "unparseable" } | { kind: "spans" };

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

// The leading `YYYY-MM-DD` of a period boundary: `2026-08-03` and
// `2026-08-03T10:00:00Z` parse; `08/03/2026`, `2026-8-3`, `2026-13-01`,
// `2026-02-30` and `2026-08-011` do not.
function leadingDateKey(value: unknown): { month: string; key: string } | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?=$|[T ])/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  return { month: `${match[1]}-${match[2]}`, key: `${match[1]}-${match[2]}-${match[3]}` };
}

export function classifyReportingPeriod(period: ReportingPeriodInput): PeriodMonthClass {
  if (!period) return { kind: "no_period" };
  const start = leadingDateKey(period.start);
  const end = leadingDateKey(period.end);
  if (!start || !end || end.key < start.key) return { kind: "unparseable" };
  return start.month === end.month ? { kind: "month", month: start.month } : { kind: "spans" };
}

export type RecordWithPeriod = { reportingPeriod: ReportingPeriodInput };

// The month a record belongs to, or null (excluded from every month view).
export function recordMonth(record: RecordWithPeriod): string | null {
  const classified = classifyReportingPeriod(record.reportingPeriod);
  return classified.kind === "month" ? classified.month : null;
}

export type MonthExclusions = { noPeriod: number; unparseable: number; spans: number };

export const NO_EXCLUSIONS: MonthExclusions = { noPeriod: 0, unparseable: 0, spans: 0 };

export function totalExcluded(excluded: MonthExclusions): number {
  return excluded.noPeriod + excluded.unparseable + excluded.spans;
}

export function addExclusions(a: MonthExclusions, b: MonthExclusions): MonthExclusions {
  return { noPeriod: a.noPeriod + b.noPeriod, unparseable: a.unparseable + b.unparseable, spans: a.spans + b.spans };
}

// Counts, per reason, the records that can NEVER be placed in a month.
export function countExclusions(records: RecordWithPeriod[]): MonthExclusions {
  const counts = { noPeriod: 0, unparseable: 0, spans: 0 };
  for (const record of records) {
    const classified = classifyReportingPeriod(record.reportingPeriod);
    if (classified.kind === "no_period") counts.noPeriod++;
    else if (classified.kind === "unparseable") counts.unparseable++;
    else if (classified.kind === "spans") counts.spans++;
  }
  return counts;
}

// The disclosure sentence for records that cannot be placed in a month (null = none).
export function describeExclusions(excluded: MonthExclusions): string | null {
  const total = totalExcluded(excluded);
  if (total === 0) return null;
  const reasons: string[] = [];
  if (excluded.noPeriod > 0) reasons.push(`${excluded.noPeriod} with no reporting period`);
  if (excluded.unparseable > 0) reasons.push(`${excluded.unparseable} with an unreadable period`);
  if (excluded.spans > 0) reasons.push(`${excluded.spans} spanning more than one month`);
  return `${total} source record${total === 1 ? "" : "s"} could not be placed in a single reporting month and ${total === 1 ? "is" : "are"} not counted in any month (${reasons.join(", ")})`;
}

// ONLY the records that belong to `month` (never an approximation).
export function filterRecordsToMonth<T extends RecordWithPeriod>(records: T[], month: string): T[] {
  return records.filter((record) => recordMonth(record) === month);
}

// ---- Availability ----------------------------------------------------------------------

// The distinct months that have >= 1 valid record, NEWEST FIRST, bounded. Derived
// purely from the records' own periods - never from today's date.
export function deriveAvailableMonths(records: RecordWithPeriod[], limit = MAX_MONTH_OPTIONS): string[] {
  const months = new Set<string>();
  for (const record of records) {
    const month = recordMonth(record);
    if (month) months.add(month);
  }
  return [...months].sort().reverse().slice(0, limit);
}

export type MonthResolution = {
  // The month the view is rendered for (null = no reporting month with data yet
  // and no explicit month).
  month: string | null;
  // "explicit": the user's own valid ?month= (never changed); "latest_default":
  // the latest month with valid data in the current context; "none".
  source: "explicit" | "latest_default" | "none";
};

// An explicit, valid month ALWAYS wins - even when it has no data (the page then
// shows Unavailable + coverage, it never silently jumps to another month). Only
// when NO explicit month exists does the default follow the data.
export function resolveMonth(explicit: string | null, available: string[]): MonthResolution {
  if (explicit) return { month: explicit, source: "explicit" };
  if (available.length > 0) return { month: available[0]!, source: "latest_default" };
  return { month: null, source: "none" };
}

export type MonthOption = { month: string; label: string; hasData: boolean; selected: boolean };

// The month selector's options: up to the latest 12 months WITH data (descending)
// plus the explicit month even when it has none (flagged `hasData: false`, kept in
// its descending position).
export function buildMonthOptions(available: string[], resolved: string | null): MonthOption[] {
  const months = [...available];
  if (resolved && !months.includes(resolved)) months.push(resolved);
  months.sort().reverse();
  return months.map((month) => ({ month, label: monthLabel(month), hasData: available.includes(month), selected: month === resolved }));
}
