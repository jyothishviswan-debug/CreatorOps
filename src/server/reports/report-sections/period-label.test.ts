import { describe, expect, it } from "vitest";

import { formatReportingPeriodLabel, formatYearMonthRange, NO_PERIOD_FILTER_LABEL } from "./period-label";

describe("formatYearMonthRange", () => {
  it("formats a real YYYY-MM key as a human 1-<lastDay> Month Year range", () => {
    expect(formatYearMonthRange("2026-08")).toBe("1–31 August 2026");
    expect(formatYearMonthRange("2026-02")).toBe("1–28 February 2026"); // 2026 is not a leap year.
    expect(formatYearMonthRange("2024-02")).toBe("1–29 February 2024"); // 2024 IS a leap year.
    expect(formatYearMonthRange("2026-04")).toBe("1–30 April 2026");
  });

  it("returns null for anything that is not a genuine YYYY-MM key - never a nonsense date", () => {
    expect(formatYearMonthRange("not-a-period")).toBeNull();
    expect(formatYearMonthRange("2026")).toBeNull();
    expect(formatYearMonthRange("2026-13")).toBeNull();
    expect(formatYearMonthRange("2026-00")).toBeNull();
  });
});

describe("formatReportingPeriodLabel (spec sections 3/16)", () => {
  it("prefers a real YYYY-MM period filter, formatted as a human date range", () => {
    expect(formatReportingPeriodLabel("2026-08", undefined)).toBe("Reporting Period: 1–31 August 2026");
  });

  it("falls back to the raw applied value when it is not a recognizable YYYY-MM key (still real, never invented)", () => {
    expect(formatReportingPeriodLabel("Q3-2026", undefined)).toBe("Reporting Period: Q3-2026");
  });

  it("uses the multi-period label when `periods` is supplied instead", () => {
    expect(formatReportingPeriodLabel(undefined, "2026-06,2026-07,2026-08")).toBe("Reporting Periods: 2026-06,2026-07,2026-08");
  });

  it("falls back to an honest, calm phrase when no period filter was applied at all - never the old implementation-oriented 'full actor scope' string", () => {
    const label = formatReportingPeriodLabel(undefined, undefined);
    expect(label).toBe(`Reporting Period: ${NO_PERIOD_FILTER_LABEL}`);
    expect(label).not.toContain("full actor scope");
    expect(label).not.toContain("actor");
  });

  it("null values behave the same as undefined", () => {
    expect(formatReportingPeriodLabel(null, null)).toBe(`Reporting Period: ${NO_PERIOD_FILTER_LABEL}`);
  });
});
