import { describe, expect, it } from "vitest";

import { dateRangeOverlapsPeriod, derivePeriod, dueInstantMs, isFuturePeriod, isValidReviewRef, parseLeadingUtcDate, reviewRefFor, toUtcDate } from "./period";

describe("derivePeriod", () => {
  it("derives explicit first/last UTC dates for an ordinary month", () => {
    expect(derivePeriod("2026-03")).toEqual({ periodKey: "2026-03", periodStart: "2026-03-01", periodEnd: "2026-03-31" });
    expect(derivePeriod("2026-04")).toEqual({ periodKey: "2026-04", periodStart: "2026-04-01", periodEnd: "2026-04-30" });
    expect(derivePeriod("2026-12")).toEqual({ periodKey: "2026-12", periodStart: "2026-12-01", periodEnd: "2026-12-31" });
  });

  it("handles leap years correctly (Feb 29 only in a real leap year, incl. the 1900/2000 century rules)", () => {
    expect(derivePeriod("2024-02")?.periodEnd).toBe("2024-02-29");
    expect(derivePeriod("2026-02")?.periodEnd).toBe("2026-02-28");
    expect(derivePeriod("2000-02")?.periodEnd).toBe("2000-02-29");
    expect(derivePeriod("2100-02")?.periodEnd).toBe("2100-02-28");
  });

  it("rejects anything that is not exactly a valid YYYY-MM key (no trimming, no coercion)", () => {
    for (const bad of ["2026-13", "2026-00", "2026-1", "26-03", "2026/03", "2026-03-01", " 2026-03", "2026-03 ", "", "abc", "0000-01", "1969-12"]) {
      expect(derivePeriod(bad)).toBeNull();
    }
    for (const bad of [null, undefined, 202603, {}, []]) expect(derivePeriod(bad)).toBeNull();
  });

  it("period boundaries are contiguous month-to-month (end + 1 day == next start), across a year boundary", () => {
    const dec = derivePeriod("2026-12")!;
    const jan = derivePeriod("2027-01")!;
    expect(Date.parse(`${dec.periodEnd}T00:00:00Z`) + 86_400_000).toBe(Date.parse(`${jan.periodStart}T00:00:00Z`));
  });
});

describe("isFuturePeriod", () => {
  it("is true only for a period that has not started yet (the current month is allowed)", () => {
    const now = new Date("2026-05-15T12:00:00Z");
    expect(isFuturePeriod(derivePeriod("2026-06")!, now)).toBe(true);
    expect(isFuturePeriod(derivePeriod("2026-05")!, now)).toBe(false);
    expect(isFuturePeriod(derivePeriod("2026-04")!, now)).toBe(false);
  });
});

describe("reviewRefFor - deterministic Partner + month identity", () => {
  it("is stable for the same Partner + period and opaque (pr_ + 20 hex)", () => {
    const a = reviewRefFor("partner-abc", "2026-03");
    expect(a).toBe(reviewRefFor("partner-abc", "2026-03"));
    expect(a).toMatch(/^pr_[0-9a-f]{20}$/);
    expect(isValidReviewRef(a)).toBe(true);
  });

  it("differs by Partner and by period", () => {
    expect(reviewRefFor("partner-abc", "2026-03")).not.toBe(reviewRefFor("partner-abc", "2026-04"));
    expect(reviewRefFor("partner-abc", "2026-03")).not.toBe(reviewRefFor("partner-abd", "2026-03"));
  });

  it("does not leak the partnerRef or period in the handle, and rejects malformed handles", () => {
    const ref = reviewRefFor("partner-abc", "2026-03");
    expect(ref).not.toContain("partner-abc");
    expect(ref).not.toContain("2026");
    for (const bad of ["", "pr_", "pr_XYZ", "pr_" + "a".repeat(19), "pr_" + "a".repeat(21), "x/y", "../partnerReviews", 5, null]) expect(isValidReviewRef(bad)).toBe(false);
  });
});

describe("date helpers", () => {
  it("parseLeadingUtcDate accepts real calendar dates (date-only or ISO datetime) and rejects impossible ones", () => {
    expect(parseLeadingUtcDate("2026-03-05")).toBe("2026-03-05");
    expect(parseLeadingUtcDate("2026-03-05T23:59:59.000Z")).toBe("2026-03-05");
    expect(parseLeadingUtcDate("2024-02-29")).toBe("2024-02-29");
    for (const bad of ["2026-02-29", "2026-13-01", "2026-00-10", "2026-04-31", "March 5", "", "26-03-05"]) expect(parseLeadingUtcDate(bad)).toBeNull();
  });

  it("toUtcDate converts an instant to its UTC calendar date (an offset instant can cross a UTC date boundary)", () => {
    expect(toUtcDate("2026-03-31T23:30:00-05:00")).toBe("2026-04-01");
    expect(toUtcDate("2026-03-31T23:30:00Z")).toBe("2026-03-31");
    expect(toUtcDate("2026-03-05")).toBe("2026-03-05");
    expect(toUtcDate("not a date")).toBeNull();
  });

  it("dueInstantMs treats a date-only value as due at the END of that UTC day and a datetime as that exact instant", () => {
    expect(dueInstantMs("2026-03-05")).toBe(Date.parse("2026-03-05T23:59:59.999Z"));
    expect(dueInstantMs("2026-03-05T10:00:00Z")).toBe(Date.parse("2026-03-05T10:00:00Z"));
    expect(dueInstantMs("garbage")).toBeNull();
  });
});

describe("dateRangeOverlapsPeriod - inclusive boundaries", () => {
  const period = derivePeriod("2026-03")!;

  it("overlaps when the range is inside, straddles either edge, or covers the whole period", () => {
    expect(dateRangeOverlapsPeriod("2026-03-10", "2026-03-12", period)).toBe(true);
    expect(dateRangeOverlapsPeriod("2026-02-20", "2026-03-01", period)).toBe(true);
    expect(dateRangeOverlapsPeriod("2026-03-31", "2026-04-15", period)).toBe(true);
    expect(dateRangeOverlapsPeriod("2026-01-01", "2026-12-31", period)).toBe(true);
  });

  it("touching a single boundary day counts (inclusive on both sides)", () => {
    expect(dateRangeOverlapsPeriod("2026-02-01", "2026-03-01", period)).toBe(true);
    expect(dateRangeOverlapsPeriod("2026-03-31", "2026-03-31", period)).toBe(true);
  });

  it("does not overlap when entirely before/after, and an inverted range never overlaps", () => {
    expect(dateRangeOverlapsPeriod("2026-02-01", "2026-02-28", period)).toBe(false);
    expect(dateRangeOverlapsPeriod("2026-04-01", "2026-04-30", period)).toBe(false);
    expect(dateRangeOverlapsPeriod("2026-03-20", "2026-03-10", period)).toBe(false);
  });
});
