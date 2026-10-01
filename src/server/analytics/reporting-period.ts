import type { AnalyticsReportingPeriod } from "./types";

// Finding #66 (user-decided): derives a content row's reportingPeriod from its OWN postDateTimeIso -
// rather than leaving every row to share one, often-absent, actor-supplied batch-level period (confirmed:
// the real import UI never even collects one).
//
// WHICH CALENDAR MONTH - re-verified against the existing, explicit product rule before writing this
// (never invented independently here): CreatorOps' Agreement/Partner Review period system is ALREADY,
// explicitly, UTC-calendar-based - see partner-reviews/period.ts's own header comment verbatim: "every
// period boundary and every 'event date' in this module is a UTC calendar date... There is no local-
// timezone interpretation anywhere." That module's own toUtcDate() (used to place an Assignment's dueAt/
// createdAt into a review period) does exactly what this function does: parse the value to a precise
// instant, then read that instant's UTC calendar date - never the server process's own local timezone
// (Date.prototype.getMonth()/getFullYear(), unpredictable across dev machines, CI and production - the
// exact failure mode this finding exists to close), and never a fixed non-UTC "business timezone" (no
// such setting exists anywhere in this codebase - confirmed by direct search). policy-adapter.ts's own
// monthBounds() (which Agreement version governs a given review period) is UTC-bounded the same way. So
// "the same calendar period represented by its authoritative publication timestamp" - the rule this
// finding must honor - IS, in this product, the UTC calendar month of that timestamp's own precise
// instant; this function's derivation is that SAME toUtcDate() rule, restated for a whole month instead
// of a single day, never a rule invented independently for content-source reporting periods alone. A
// timestamp near a month boundary in a non-UTC source offset (e.g. 2026-10-01T00:15:00+05:30, whose UTC
// instant is 2026-09-30T18:45:00Z) therefore belongs to the UTC month its instant falls in (September in
// that example) - not the source offset's own local calendar date - exactly as an Assignment's dueAt in
// the same offset would place identically via toUtcDate(). See reporting-period.test.ts's own explicit
// boundary-crossing tests (UTC/IST/negative-offset/zone-less) proving this precisely.
//
// Every accepted postDateTimeIso is already a precise, unambiguous UTC instant by the time it reaches
// here in the real pipeline - metric-registry.ts's parseSupportedDateTime folds the SOURCE value's own
// offset (or its documented, explicit "no zone means UTC" policy) into the parse itself, and
// Date.prototype.toISOString() always normalizes to UTC. But this function does NOT rely solely on that -
// see the zone-less handling below, which enforces the SAME "no zone means UTC" policy independently, so
// this function is correct on its own terms rather than only accidentally correct because of how its one
// current caller happens to invoke it.
//
// CAUGHT DURING VERIFICATION: a bare `Date.parse`/`new Date(...)` on an ISO date-TIME string with NO
// explicit zone is - per the ECMA-262 Date Time String Format grammar - interpreted as the SERVER
// process's own LOCAL time, not UTC (confirmed by direct testing: the exact same zone-less string parses
// to different UTC instants under different TZ env values). This is precisely the failure mode this
// finding exists to close, and metric-registry.ts's own parseSupportedDateTime already defends against it
// by explicitly appending "Z" itself when a date-time string carries no zone (never trusting the native
// grammar's local-time default). The same explicit normalization is applied here, independently.
const ISO_DATE_TIME_NO_ZONE_PATTERN = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)$/;

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function daysInUtcMonth(year: number, month: number): number {
  // month is 1-12; day 0 of the FOLLOWING month is the last day of THIS one.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function deriveReportingPeriodFromPostDateTime(postDateTimeIso: string): AnalyticsReportingPeriod | null {
  const trimmed = postDateTimeIso.trim();
  const noZoneMatch = ISO_DATE_TIME_NO_ZONE_PATTERN.exec(trimmed);
  const normalized = noZoneMatch ? `${trimmed}Z` : trimmed;

  const ms = Date.parse(normalized);
  if (Number.isNaN(ms)) return null;
  const instant = new Date(ms);
  const year = instant.getUTCFullYear();
  const month = instant.getUTCMonth() + 1;
  return {
    start: `${year}-${pad2(month)}-01`,
    end: `${year}-${pad2(month)}-${pad2(daysInUtcMonth(year, month))}`,
  };
}
