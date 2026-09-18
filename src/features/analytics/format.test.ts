import { describe, expect, it } from "vitest";

import { batchStatusTone, formatMetric, matchStateTone, reportingPeriodLabel, shortHash } from "./format";

describe("matchStateTone", () => {
  it("maps each match state to a distinct, non-color-only-meaning tone", () => {
    expect(matchStateTone("MATCHED")).toBe("default");
    expect(matchStateTone("UNMATCHED")).toBe("gray");
    expect(matchStateTone("AMBIGUOUS")).toBe("orange");
  });
});

describe("batchStatusTone", () => {
  it("maps terminal statuses distinctly", () => {
    expect(batchStatusTone("COMPLETED")).toBe("default");
    expect(batchStatusTone("COMPLETED_WITH_ERRORS")).toBe("orange");
    expect(batchStatusTone("FAILED")).toBe("red");
    expect(batchStatusTone("PENDING")).toBe("gray");
  });
});

describe("formatMetric", () => {
  it("never renders a missing metric as 0", () => {
    expect(formatMetric(null)).toBe("—");
  });
  it("renders a real zero literally", () => {
    expect(formatMetric(0)).toBe("0");
  });
  it("formats a real number", () => {
    expect(formatMetric(12345)).toBe("12,345");
  });
});

describe("shortHash", () => {
  it("truncates a long hash, keeps a short one as-is", () => {
    expect(shortHash("abc")).toBe("abc");
    expect(shortHash("0123456789abcdef0123")).toBe("01234567…0123");
  });
});

describe("reportingPeriodLabel", () => {
  it("renders a real period, or an honest unknown label", () => {
    expect(reportingPeriodLabel({ start: "2026-07-01", end: "2026-07-31" })).toBe("2026-07-01 – 2026-07-31");
    expect(reportingPeriodLabel(null)).toBe("Unknown period");
  });
});
