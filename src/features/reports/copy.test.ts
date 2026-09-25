import { describe, expect, it } from "vitest";

import { cellDrilldownHref, drilldownHrefFor, formatCellValue, formatDateTime, formatMetricValue, humanizeKey, NO_VALUE_TEXT, periodKeyLabel, REPORT_FAMILY_GROUPS, VIEWER_SAFE_BLOCKED_REPORT_IDS } from "./copy";

// Step 19C closure: pure view-model tests for the Reports UI's own display/formatting logic - the
// same "server/logic-only" convention every other feature directory in this codebase uses (see
// src/features/operations/copy.test.ts's own header comment). This module previously had ZERO unit
// coverage despite carrying the exact honest-state semantics (a missing metric is never 0, never
// blank-implying-zero - see copy.ts's own section 5/6 comment) and the drilldown allowlist Step 19C's
// own "Honest-state closure" and "Drilldown closure" sections require independent proof of.

describe("formatMetricValue (section 5/6: a missing metric is never 0, never blank-implying-zero)", () => {
  it("null is rendered as an explicit 'Not available', never 0 or blank", () => {
    expect(formatMetricValue(null)).toBe("Not available");
  });

  it("a genuine 0 is rendered as the real number 0, distinguished from the null case above", () => {
    expect(formatMetricValue(0)).toBe("0");
  });

  it("formats a finite number with locale grouping", () => {
    expect(formatMetricValue(128000)).toBe("128,000");
  });

  it("passes through a non-finite number verbatim rather than crashing or fabricating a value", () => {
    expect(formatMetricValue(Number.NaN)).toBe("NaN");
  });

  it("renders a YYYY-MM string metric value (e.g. a leader-period metric) in its human label form", () => {
    expect(formatMetricValue("2026-05")).toBe("May 2026");
  });

  it("passes through any other string verbatim", () => {
    expect(formatMetricValue("South Programmes Launch")).toBe("South Programmes Launch");
  });
});

describe("periodKeyLabel", () => {
  it("converts a valid YYYY-MM key to its month name form", () => {
    expect(periodKeyLabel("2026-01")).toBe("January 2026");
    expect(periodKeyLabel("2024-12")).toBe("December 2024");
  });

  it("returns an unrecognized shape verbatim rather than guessing", () => {
    expect(periodKeyLabel("not-a-period")).toBe("not-a-period");
    expect(periodKeyLabel("2026-13")).toBe("2026-13"); // month 13 has no name - falls back to the raw key
  });
});

describe("formatDateTime", () => {
  it("renders the NO_VALUE_TEXT placeholder for null/undefined", () => {
    expect(formatDateTime(null)).toBe(NO_VALUE_TEXT);
    expect(formatDateTime(undefined)).toBe(NO_VALUE_TEXT);
  });

  it("renders the NO_VALUE_TEXT placeholder for an unparseable string rather than 'Invalid Date'", () => {
    expect(formatDateTime("not-a-real-date")).toBe(NO_VALUE_TEXT);
  });

  it("formats a real ISO timestamp into a fixed-locale human string", () => {
    const out = formatDateTime("2026-05-14T09:30:00.000Z");
    expect(out).not.toBe(NO_VALUE_TEXT);
    expect(out).toMatch(/2026/);
  });
});

describe("humanizeKey", () => {
  it("splits camelCase and snake_case keys into a capitalized, spaced label", () => {
    expect(humanizeKey("assignmentRef")).toBe("Assignment ref");
    expect(humanizeKey("matchedContentCount_instagram")).toBe("Matched content count instagram");
    expect(humanizeKey("partnerDisplayName")).toBe("Partner display name");
  });
});

describe("formatCellValue (never crashes, never fabricates - every section row shape is genuinely unknown)", () => {
  it("null/undefined -> the placeholder, never 0 or a fabricated value", () => {
    expect(formatCellValue(null)).toBe(NO_VALUE_TEXT);
    expect(formatCellValue(undefined)).toBe(NO_VALUE_TEXT);
  });

  it("booleans render as Yes/No", () => {
    expect(formatCellValue(true)).toBe("Yes");
    expect(formatCellValue(false)).toBe("No");
  });

  it("a genuine 0 stays 0, distinguished from the null/undefined placeholder case", () => {
    expect(formatCellValue(0)).toBe("0");
  });

  it("numbers use locale grouping; non-finite numbers pass through verbatim", () => {
    expect(formatCellValue(128000)).toBe("128,000");
    expect(formatCellValue(Number.NaN)).toBe("NaN");
  });

  it("a YYYY-MM string renders as its human period label", () => {
    expect(formatCellValue("2026-05")).toBe("May 2026");
  });

  it("a full ISO-8601 timestamp string is formatted the same way generatedAt/evidenceCutoff are - never left as a raw machine string (the exact gap fixed just before Step 19C, in commit f0db286)", () => {
    const out = formatCellValue("2026-05-14T09:30:00.000Z");
    expect(out).not.toMatch(/T\d{2}:\d{2}:\d{2}/); // not the raw ISO shape any more
    expect(out).toMatch(/2026/);
  });

  it("an unrecognized string (a plain label, a ref) passes through verbatim, never guessed", () => {
    expect(formatCellValue("Reports Fixture Campaign")).toBe("Reports Fixture Campaign");
    expect(formatCellValue("seed-partner-archived")).toBe("seed-partner-archived");
  });

  it("a TargetReference-shaped object (Operations' own raw DTO shape) renders as TYPE + ref", () => {
    expect(formatCellValue({ targetType: "PARTNER", targetRef: "creator-house" })).toBe("PARTNER creator-house");
  });

  it("an empty array renders as the placeholder, never an empty-looking blank", () => {
    expect(formatCellValue([])).toBe(NO_VALUE_TEXT);
  });

  it("an array of primitives is joined with formatted values", () => {
    expect(formatCellValue([1, 2, null])).toBe(`1, 2, ${NO_VALUE_TEXT}`);
  });

  it("an array of objects renders as a compact 'N item(s)' count, never a fabricated summary", () => {
    expect(formatCellValue([{ a: 1 }, { b: 2 }])).toBe("2 item(s)");
  });

  it("a plain object (no known shape) renders as real JSON, never a silent drop", () => {
    expect(formatCellValue({ foo: "bar", n: 1 })).toBe(JSON.stringify({ foo: "bar", n: 1 }));
  });

  it("a circular object cannot crash the renderer - falls back to the placeholder", () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    expect(formatCellValue(circular)).toBe(NO_VALUE_TEXT);
  });
});

describe("drilldownHrefFor / cellDrilldownHref (a conservative allowlist - never a guess at an unfamiliar ref shape)", () => {
  it("an allowlisted column key with a non-empty string value produces the real detail route", () => {
    expect(drilldownHrefFor("partnerRef", "creator-house")).toBe("/partners/creator-house");
    expect(drilldownHrefFor("campaignRef", "seed-campaign-planned")).toBe("/campaigns/seed-campaign-planned");
    expect(drilldownHrefFor("contentRef", "seed-content-approved")).toBe("/content/seed-content-approved");
    expect(drilldownHrefFor("assignmentRef", "seed-assignment-content-fulfilled")).toBe("/assignments/seed-assignment-content-fulfilled");
    expect(drilldownHrefFor("reviewRef", "some-review-ref")).toBe("/partner-reviews/some-review-ref");
    expect(drilldownHrefFor("vendorRef", "some-vendor-ref")).toBe("/vendors/some-vendor-ref");
  });

  it("URL-encodes a ref value that needs it - never an unescaped raw ref dropped into a path", () => {
    expect(drilldownHrefFor("partnerRef", "a/weird ref")).toBe(`/partners/${encodeURIComponent("a/weird ref")}`);
  });

  it("an unfamiliar column key never becomes an invented route", () => {
    expect(drilldownHrefFor("someRandomKey", "creator-house")).toBeNull();
    expect(drilldownHrefFor("status", "ACTIVE")).toBeNull();
  });

  it("a non-string or empty value never becomes a link", () => {
    expect(drilldownHrefFor("partnerRef", null)).toBeNull();
    expect(drilldownHrefFor("partnerRef", 123)).toBeNull();
    expect(drilldownHrefFor("partnerRef", "")).toBeNull();
    expect(drilldownHrefFor("partnerRef", true)).toBeNull();
  });

  it("cellDrilldownHref maps a known TargetReference targetType to its real route", () => {
    expect(cellDrilldownHref("target", { targetType: "PARTNER", targetRef: "creator-house" })).toBe("/partners/creator-house");
    expect(cellDrilldownHref("target", { targetType: "CAMPAIGN", targetRef: "seed-campaign-planned" })).toBe("/campaigns/seed-campaign-planned");
    expect(cellDrilldownHref("target", { targetType: "PARTNER_REVIEW", targetRef: "some-review" })).toBe("/partner-reviews/some-review");
  });

  it("cellDrilldownHref never invents a route for an unmapped targetType - plain text, never a broken link", () => {
    expect(cellDrilldownHref("target", { targetType: "SOMETHING_UNKNOWN", targetRef: "x" })).toBeNull();
  });

  it("cellDrilldownHref falls back to the plain column-key allowlist for a non-TargetReference value", () => {
    expect(cellDrilldownHref("partnerRef", "creator-house")).toBe("/partners/creator-house");
    expect(cellDrilldownHref("someOtherKey", "creator-house")).toBeNull();
  });
});

describe("VIEWER_SAFE_BLOCKED_REPORT_IDS / REPORT_FAMILY_GROUPS (client-side echoes, never the authority)", () => {
  it("carries exactly the same two blocked report ids report-service.ts's own VIEWER_SAFE_BLOCKED_REPORT_IDS declares", () => {
    expect([...VIEWER_SAFE_BLOCKED_REPORT_IDS].sort()).toEqual(["administration_security", "finance_status"].sort());
  });

  it("groups all 13 report ids exactly once each - no duplicate, no omission", () => {
    const all = REPORT_FAMILY_GROUPS.flatMap((g) => g.reportIds);
    expect(all).toHaveLength(13);
    expect(new Set(all).size).toBe(13);
  });
});
