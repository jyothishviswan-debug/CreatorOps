import { describe, expect, it } from "vitest";

import {
  addMonths,
  buildMonthOptions,
  calendarWindow,
  classifyReportingPeriod,
  countExclusions,
  deriveAvailableMonths,
  describeExclusions,
  filterRecordsToMonth,
  monthLabel,
  parseMonthParam,
  recordMonth,
  resolveMonth,
  shortMonthLabel,
} from "./reporting-month";

const p = (start: string, end: string) => ({ reportingPeriod: { start, end } });

describe("parseMonthParam - server-side ?month= validation", () => {
  it("accepts exactly YYYY-MM with a real month", () => {
    for (const ok of ["2026-08", "2026-01", "2026-12", "1999-06", "2100-02"]) expect(parseMonthParam(ok)).toEqual({ month: ok, invalid: false });
  });
  it("absent / empty means 'no explicit month' - not invalid", () => {
    for (const none of [undefined, null, ""]) expect(parseMonthParam(none)).toEqual({ month: null, invalid: false });
  });
  it("rejects malformed, out-of-range and edge values as invalid (treated as absent, never guessed)", () => {
    const bad = ["2026-13", "2026-00", "2026-1", "2026-8", "26-08", "2026/08", "2026-08-01", " 2026-08", "2026-08 ", "2026-008", "abcd-ef", "2026-02-30", "0", "null", "2026-1a", "２０２６-08"];
    for (const value of bad) expect(parseMonthParam(value), value).toEqual({ month: null, invalid: true });
  });
  it("rejects non-strings and repeated params (string[]) as invalid", () => {
    for (const value of [["2026-08"], ["2026-08", "2026-09"], 202608, {}, true]) expect(parseMonthParam(value)).toEqual({ month: null, invalid: true });
  });
  it("leap-year handling is a day matter, not a month one: 2024-02 and 2026-02 are both valid months", () => {
    expect(parseMonthParam("2024-02").month).toBe("2024-02");
    expect(parseMonthParam("2026-02").month).toBe("2026-02");
  });
});

describe("classifyReportingPeriod / recordMonth - THE month membership rule", () => {
  it("a period entirely inside one calendar month belongs to it", () => {
    expect(classifyReportingPeriod({ start: "2026-08-01", end: "2026-08-31" })).toEqual({ kind: "month", month: "2026-08" });
    expect(classifyReportingPeriod({ start: "2026-08-15", end: "2026-08-15" })).toEqual({ kind: "month", month: "2026-08" });
    expect(classifyReportingPeriod({ start: "2024-02-01", end: "2024-02-29" })).toEqual({ kind: "month", month: "2024-02" });
  });
  it("uses the LEADING YYYY-MM-DD of each boundary (an ISO timestamp is fine)", () => {
    expect(classifyReportingPeriod({ start: "2026-08-01T00:00:00.000Z", end: "2026-08-31T23:59:59.999Z" })).toEqual({ kind: "month", month: "2026-08" });
    expect(classifyReportingPeriod({ start: "2026-08-01 00:00", end: "2026-08-02 12:00" })).toEqual({ kind: "month", month: "2026-08" });
  });
  it("a period that SPANS more than one month is never forced into one", () => {
    expect(classifyReportingPeriod({ start: "2026-07-15", end: "2026-08-14" })).toEqual({ kind: "spans" });
    expect(classifyReportingPeriod({ start: "2025-12-01", end: "2026-01-31" })).toEqual({ kind: "spans" });
    expect(classifyReportingPeriod({ start: "2026-01-01", end: "2026-12-31" })).toEqual({ kind: "spans" });
  });
  it("no period at all is its own reason", () => {
    expect(classifyReportingPeriod(null)).toEqual({ kind: "no_period" });
    expect(classifyReportingPeriod(undefined)).toEqual({ kind: "no_period" });
  });
  it("unparseable periods are excluded (not a real leading date, garbage, inverted)", () => {
    const bad: [string, string][] = [
      ["Aug 2026", "Aug 2026"],
      ["08/01/2026", "08/31/2026"],
      ["2026-8-1", "2026-8-31"],
      ["2026-13-01", "2026-13-28"],
      ["2026-02-30", "2026-02-30"],
      ["2026-08-011", "2026-08-31"],
      ["2026-08-31", "2026-08-01"],
      ["", ""],
      ["2026-08-01", "not a date"],
    ];
    for (const [start, end] of bad) expect(classifyReportingPeriod({ start, end }), `${start}..${end}`).toEqual({ kind: "unparseable" });
    // 2026 is not a leap year: Feb 29 does not exist; 2024's does.
    expect(classifyReportingPeriod({ start: "2026-02-01", end: "2026-02-29" })).toEqual({ kind: "unparseable" });
    expect(classifyReportingPeriod({ start: "2024-02-01", end: "2024-02-29" })).toEqual({ kind: "month", month: "2024-02" });
  });
  it("recordMonth is null for every excluded class", () => {
    expect(recordMonth(p("2026-08-01", "2026-08-31"))).toBe("2026-08");
    expect(recordMonth(p("2026-07-01", "2026-08-31"))).toBeNull();
    expect(recordMonth({ reportingPeriod: null })).toBeNull();
    expect(recordMonth(p("junk", "junk"))).toBeNull();
  });
});

describe("exclusions are counted per reason and disclosed, never forced into a month", () => {
  const records = [p("2026-08-01", "2026-08-31"), { reportingPeriod: null }, { reportingPeriod: null }, p("2026-07-20", "2026-08-05"), p("garbage", "2026-08-31"), p("2026-09-01", "2026-09-30")];
  it("counts each reason", () => {
    expect(countExclusions(records)).toEqual({ noPeriod: 2, unparseable: 1, spans: 1 });
  });
  it("filterRecordsToMonth keeps ONLY records that lie entirely inside the month", () => {
    expect(filterRecordsToMonth(records, "2026-08")).toEqual([records[0]]);
    expect(filterRecordsToMonth(records, "2026-07")).toEqual([]); // the spanning record is not in July either
    expect(filterRecordsToMonth(records, "2026-09")).toEqual([records[5]]);
  });
  it("describes the disclosure with the right counts and singular/plural", () => {
    expect(describeExclusions({ noPeriod: 0, unparseable: 0, spans: 0 })).toBeNull();
    expect(describeExclusions({ noPeriod: 2, unparseable: 1, spans: 1 })).toBe("4 source records could not be placed in a single reporting month and are not counted in any month (2 with no reporting period, 1 with an unreadable period, 1 spanning more than one month)");
    expect(describeExclusions({ noPeriod: 1, unparseable: 0, spans: 0 })).toBe("1 source record could not be placed in a single reporting month and is not counted in any month (1 with no reporting period)");
  });
});

describe("latest valid month comes from the DATA, never the calendar", () => {
  it("derives newest-first months only from usable single-month periods", () => {
    const records = [p("2019-03-01", "2019-03-31"), p("2019-04-01", "2019-04-30"), p("2019-04-05", "2019-04-06"), { reportingPeriod: null }, p("2019-04-15", "2019-05-15"), p("bad", "bad")];
    expect(deriveAvailableMonths(records)).toEqual(["2019-04", "2019-03"]);
  });
  it("is independent of today: fixtures years in the past and in the future resolve the same way", () => {
    expect(deriveAvailableMonths([p("2001-02-01", "2001-02-28")])).toEqual(["2001-02"]);
    expect(deriveAvailableMonths([p("2099-11-01", "2099-11-30"), p("2098-01-01", "2098-01-31")])).toEqual(["2099-11", "2098-01"]);
    const currentMonth = new Date().toISOString().slice(0, 7);
    expect(deriveAvailableMonths([p("2019-03-01", "2019-03-31")])).not.toContain(currentMonth);
  });
  it("is bounded to the latest 12", () => {
    const records = Array.from({ length: 30 }, (_, i) => {
      const month = addMonths("2024-01", i);
      return p(`${month}-01`, `${month}-28`);
    });
    const months = deriveAvailableMonths(records);
    expect(months).toHaveLength(12);
    expect(months[0]).toBe("2026-06");
    expect(months[11]).toBe("2025-07");
  });
  it("no valid data yields no months", () => {
    expect(deriveAvailableMonths([])).toEqual([]);
    expect(deriveAvailableMonths([{ reportingPeriod: null }, p("2026-01-01", "2026-03-31")])).toEqual([]);
  });
});

describe("resolveMonth - explicit choice always wins", () => {
  it("defaults to the newest month with data only when nothing is explicit", () => {
    expect(resolveMonth(null, ["2026-08", "2026-07"])).toEqual({ month: "2026-08", source: "latest_default" });
  });
  it("an explicit month is NEVER changed - even one without data", () => {
    expect(resolveMonth("2026-05", ["2026-08", "2026-07"])).toEqual({ month: "2026-05", source: "explicit" });
    expect(resolveMonth("2030-01", [])).toEqual({ month: "2030-01", source: "explicit" });
  });
  it("no explicit month and no data resolves to none", () => {
    expect(resolveMonth(null, [])).toEqual({ month: null, source: "none" });
  });
});

describe("buildMonthOptions", () => {
  it("lists the months with data (newest first) and the selected month flagged", () => {
    expect(buildMonthOptions(["2026-08", "2026-07"], "2026-08")).toEqual([
      { month: "2026-08", label: "August 2026", hasData: true, selected: true },
      { month: "2026-07", label: "July 2026", hasData: true, selected: false },
    ]);
  });
  it("includes the explicit month even with no data, kept in descending position", () => {
    const options = buildMonthOptions(["2026-08", "2026-06"], "2026-07");
    expect(options.map((o) => o.month)).toEqual(["2026-08", "2026-07", "2026-06"]);
    expect(options.find((o) => o.month === "2026-07")).toMatchObject({ hasData: false, selected: true });
  });
  it("is empty when there is no data and no resolved month", () => {
    expect(buildMonthOptions([], null)).toEqual([]);
  });
});

describe("labels and month arithmetic", () => {
  it("labels", () => {
    expect(monthLabel("2026-08")).toBe("August 2026");
    expect(monthLabel("2026-01")).toBe("January 2026");
    expect(shortMonthLabel("2026-12")).toBe("Dec 2026");
    expect(monthLabel("garbage")).toBe("garbage");
  });
  it("addMonths crosses year boundaries in both directions", () => {
    expect(addMonths("2026-11", 3)).toBe("2027-02");
    expect(addMonths("2026-02", -3)).toBe("2025-11");
    expect(addMonths("2026-01", -1)).toBe("2025-12");
    expect(addMonths("2026-12", 1)).toBe("2027-01");
  });
  it("calendarWindow is 12 consecutive months ending at the given month, oldest first", () => {
    const window = calendarWindow("2026-03");
    expect(window).toHaveLength(12);
    expect(window[0]).toBe("2025-04");
    expect(window[11]).toBe("2026-03");
  });
});
