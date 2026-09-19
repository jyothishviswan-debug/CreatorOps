import { describe, expect, it } from "vitest";

import { analyticsReadinessLabel, assignmentsTotalLabel, countLabel, partnersLabel, plural } from "./downstream-format";

describe("plural / count labels", () => {
  it("uses singular for exactly one and plural otherwise", () => {
    expect(plural(1, "Partner")).toBe("Partner");
    expect(plural(0, "Partner")).toBe("Partners");
    expect(plural(2, "Partner")).toBe("Partners");
  });

  it("renders honest totals with correct singular/plural", () => {
    expect(assignmentsTotalLabel(1, false)).toBe("1 Assignment");
    expect(assignmentsTotalLabel(0, false)).toBe("0 Assignments");
    expect(assignmentsTotalLabel(7, false)).toBe("7 Assignments");
    expect(partnersLabel(1, false)).toBe("1 Partner");
    expect(partnersLabel(3, false)).toBe("3 Partners");
  });

  it("renders a lower-bound '200+' when the server bound was hit", () => {
    expect(countLabel(200, true)).toBe("200+");
    expect(assignmentsTotalLabel(200, true)).toBe("200+ Assignments");
    expect(partnersLabel(12, true)).toBe("12+ Partners");
  });
});

describe("analyticsReadinessLabel", () => {
  it("says so when there are no Content records at all", () => {
    expect(analyticsReadinessLabel({ hasLinkedSourceRecords: false, matchedCount: 0, unmatchedCount: 0 })).toBe("No Content records yet");
  });

  it("says no source data is linked when Content exists but nothing matched", () => {
    expect(analyticsReadinessLabel({ hasLinkedSourceRecords: false, matchedCount: 0, unmatchedCount: 4 })).toBe("No source data linked yet");
  });

  it("reports N of M when some Content has matched data, with correct grammar", () => {
    expect(analyticsReadinessLabel({ hasLinkedSourceRecords: true, matchedCount: 3, unmatchedCount: 1 })).toBe("3 of 4 Content records have matched data");
    expect(analyticsReadinessLabel({ hasLinkedSourceRecords: true, matchedCount: 1, unmatchedCount: 2 })).toBe("1 of 3 Content records has matched data");
    expect(analyticsReadinessLabel({ hasLinkedSourceRecords: true, matchedCount: 1, unmatchedCount: 0 })).toBe("1 of 1 Content record has matched data");
  });
});
