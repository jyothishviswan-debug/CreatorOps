import { describe, expect, it } from "vitest";

import { deriveReportingPeriodFromPostDateTime } from "./reporting-period";

// Finding #66 (user-decided): reportingPeriod is derived from a content row's own postDateTimeIso - the
// UTC calendar month containing that instant, NEVER the server's local timezone. postDateTimeIso is
// always already UTC-normalized (see metric-registry.ts's parseSupportedDateTime), so these tests exercise
// the derivation directly against already-parsed UTC instants, plus the offset/IST month-boundary cases
// the user explicitly asked to be covered (a post whose OWN wall-clock offset places it on one side of a
// month boundary must land in the calendar month its own UTC instant actually falls in - deterministically,
// regardless of what timezone the server process happens to run in).
describe("deriveReportingPeriodFromPostDateTime", () => {
  it("returns the first/last day of the UTC calendar month containing the instant", () => {
    expect(deriveReportingPeriodFromPostDateTime("2026-01-15T10:00:00.000Z")).toEqual({ start: "2026-01-01", end: "2026-01-31" });
    expect(deriveReportingPeriodFromPostDateTime("2026-02-01T00:00:00.000Z")).toEqual({ start: "2026-02-01", end: "2026-02-28" });
  });

  it("is leap-year correct", () => {
    expect(deriveReportingPeriodFromPostDateTime("2024-02-15T00:00:00.000Z")).toEqual({ start: "2024-02-01", end: "2024-02-29" });
    expect(deriveReportingPeriodFromPostDateTime("2025-02-15T00:00:00.000Z")).toEqual({ start: "2025-02-01", end: "2025-02-28" });
  });

  it("returns null for an unparseable value - never a guessed/fabricated period", () => {
    expect(deriveReportingPeriodFromPostDateTime("not a date")).toBeNull();
    expect(deriveReportingPeriodFromPostDateTime("")).toBeNull();
  });

  // A post whose ORIGINAL source offset places its own wall-clock date on the last day of a month, but
  // whose UTC instant is still comfortably within that same UTC day - the common, non-boundary case.
  it("IST late-in-the-month post: the UTC instant (still the same UTC calendar day) lands in the same month", () => {
    // 2026-01-31T23:30:00+05:30 IST == 2026-01-31T18:00:00Z UTC.
    const iso = new Date("2026-01-31T23:30:00+05:30").toISOString();
    expect(iso).toBe("2026-01-31T18:00:00.000Z");
    expect(deriveReportingPeriodFromPostDateTime(iso)).toEqual({ start: "2026-01-01", end: "2026-01-31" });
  });

  // The genuine boundary-crossing case: a post whose SOURCE wall-clock date (in its own +05:30 offset) is
  // already the 1st of the next month, but whose UTC instant is still the last UTC calendar day of the
  // PREVIOUS month. The derivation is defined over the UTC instant (deterministic, environment-independent)
  // - so this post is bucketed into the earlier UTC month, consistently, no matter which timezone the
  // server process itself is configured with.
  it("IST early-next-month post: the UTC instant crosses back into the PREVIOUS UTC month - deterministic either way", () => {
    // 2026-02-01T02:00:00+05:30 IST == 2026-01-31T20:30:00Z UTC.
    const iso = new Date("2026-02-01T02:00:00+05:30").toISOString();
    expect(iso).toBe("2026-01-31T20:30:00.000Z");
    expect(deriveReportingPeriodFromPostDateTime(iso)).toEqual({ start: "2026-01-01", end: "2026-01-31" });
  });

  // A UTC-offset post exactly at a month boundary (00:00:00Z on the 1st) lands in the NEW month - the
  // boundary itself is inclusive of the month it opens, exactly like ReviewPeriod's own periodStart rule.
  it("exactly at 00:00:00Z on the 1st lands in the new month, not the previous one", () => {
    expect(deriveReportingPeriodFromPostDateTime("2026-03-01T00:00:00.000Z")).toEqual({ start: "2026-03-01", end: "2026-03-31" });
  });

  // A UTC-negative-offset (e.g. US Pacific, -08:00) post near month-end: same deterministic UTC-instant
  // rule applies regardless of which direction the source offset points.
  it("a negative-offset (US Pacific) post near month-end resolves by its own UTC instant, not the offset's local date", () => {
    // 2026-01-31T20:00:00-08:00 PST == 2026-02-01T04:00:00Z UTC - the source's own LOCAL date is still
    // Jan 31, but its UTC instant has already crossed into February.
    const iso = new Date("2026-01-31T20:00:00-08:00").toISOString();
    expect(iso).toBe("2026-02-01T04:00:00.000Z");
    expect(deriveReportingPeriodFromPostDateTime(iso)).toEqual({ start: "2026-02-01", end: "2026-02-28" });
  });

  it("never depends on the server's local timezone - the same instant always derives the same period regardless of process TZ", () => {
    const iso = "2026-06-30T23:59:59.999Z";
    const first = deriveReportingPeriodFromPostDateTime(iso);
    const second = deriveReportingPeriodFromPostDateTime(iso);
    expect(first).toEqual(second);
    expect(first).toEqual({ start: "2026-06-01", end: "2026-06-30" });
  });

  // The user's own exact example, verified precisely: a source timestamp whose own wall-clock offset
  // reads as October 1st must NOT silently become a September post - unless (as is genuinely the case
  // here, confirmed against partner-reviews/period.ts's own explicit "UTC calendar, no local-timezone
  // interpretation anywhere" rule and policy-adapter.ts's own UTC-bounded review periods) the product HAS
  // explicitly defined its Agreement/Partner Review reporting periods in UTC. Given that product rule,
  // this instant's UTC calendar date (Sep 30) IS the correct, honest answer - the same placement an
  // Assignment's own dueAt in this exact offset would get via period.ts's toUtcDate().
  it("boundary example: 2026-10-01T00:15:00+05:30 (source wall-clock Oct 1) lands in SEPTEMBER, its own UTC instant's month - per the product's explicit UTC-calendar rule", () => {
    const iso = new Date("2026-10-01T00:15:00+05:30").toISOString();
    expect(iso).toBe("2026-09-30T18:45:00.000Z");
    expect(deriveReportingPeriodFromPostDateTime(iso)).toEqual({ start: "2026-09-01", end: "2026-09-30" });
  });
});

// Findings #66 - explicit boundary-category coverage requested during verification, each proving the
// SAME UTC-calendar rule partner-reviews/period.ts already establishes for every other period placement
// in this codebase (toUtcDate/monthBounds) - never a rule invented independently here.
describe("boundary categories (explicit, per-category coverage)", () => {
  it("category 1 - UTC timestamp exactly at a month boundary: 23:59:59.999Z on the last day stays in that month; 00:00:00.000Z on the 1st is already the new month", () => {
    expect(deriveReportingPeriodFromPostDateTime("2026-04-30T23:59:59.999Z")).toEqual({ start: "2026-04-01", end: "2026-04-30" });
    expect(deriveReportingPeriodFromPostDateTime("2026-05-01T00:00:00.000Z")).toEqual({ start: "2026-05-01", end: "2026-05-31" });
  });

  it("category 2 - a +05:30 (IST) timestamp crossing the UTC month boundary: the source's own local calendar date already reads the 1st, but its UTC instant is still the last day of the PREVIOUS month", () => {
    // 2026-07-01T03:00:00+05:30 IST == 2026-06-30T21:30:00Z UTC.
    const iso = new Date("2026-07-01T03:00:00+05:30").toISOString();
    expect(iso).toBe("2026-06-30T21:30:00.000Z");
    expect(deriveReportingPeriodFromPostDateTime(iso)).toEqual({ start: "2026-06-01", end: "2026-06-30" });
  });

  it("category 3 - a negative-offset timestamp crossing the UTC month boundary: the source's own local calendar date still reads the LAST day of a month, but its UTC instant has already crossed into the NEXT month", () => {
    // 2026-08-31T22:00:00-05:00 (US Central) == 2026-09-01T03:00:00Z UTC.
    const iso = new Date("2026-08-31T22:00:00-05:00").toISOString();
    expect(iso).toBe("2026-09-01T03:00:00.000Z");
    expect(deriveReportingPeriodFromPostDateTime(iso)).toEqual({ start: "2026-09-01", end: "2026-09-30" });
  });

  it("category 4 - a timezone-less date-time input is treated as UTC under the existing rule (metric-registry.ts's own documented zone-less policy), NEVER the server process's own local timezone", () => {
    // Deliberately a RAW zone-less string (never pre-converted via .toISOString()) - proving this
    // function enforces the zone-less-means-UTC rule independently, not merely benefiting from a caller
    // that already normalized it. A bare Date.parse of this exact string is genuinely TZ-dependent
    // (confirmed by direct testing: it resolves to a different UTC instant under different process TZ
    // values) - this function must never inherit that dependency.
    expect(deriveReportingPeriodFromPostDateTime("2026-11-30T23:30:00")).toEqual({ start: "2026-11-01", end: "2026-11-30" });
    expect(deriveReportingPeriodFromPostDateTime("2026-12-01T00:15:00")).toEqual({ start: "2026-12-01", end: "2026-12-31" });
    // A zone-less value already produces the SAME result as its own explicit "Z" spelling - this function
    // treats "no zone" and "Z" identically, per the documented policy.
    expect(deriveReportingPeriodFromPostDateTime("2026-11-30T23:30:00")).toEqual(deriveReportingPeriodFromPostDateTime("2026-11-30T23:30:00Z"));
  });

  it("category 4 (continued) - a date-only (no time component) value is UTC midnight, unaffected by this fix (already correct natively)", () => {
    expect(deriveReportingPeriodFromPostDateTime("2026-11-30")).toEqual({ start: "2026-11-01", end: "2026-11-30" });
  });
});
