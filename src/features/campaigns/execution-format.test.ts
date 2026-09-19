import { describe, expect, it } from "vitest";

import { approvedOfTotalLabel, deliveryStateUnavailableNote, exceptionsNote, lowerBoundLabel, toCampaignBoardRows, truncationNote } from "./execution-format";

// Step 12C.2: exact vs truncated presentation of Campaign Overview's
// execution slots. Exact figures are unchanged; a truncated portfolio only
// ever produces lower-bound ("N+") text and never an exact-looking share.

describe("lowerBoundLabel / approvedOfTotalLabel", () => {
  it("exact figures are plain numbers", () => {
    expect(lowerBoundLabel(7, false)).toBe("7");
    expect(approvedOfTotalLabel(3, 10, false)).toBe("3 of 10");
    expect(approvedOfTotalLabel(0, 0, false)).toBe("0 of 0");
  });

  it("truncated figures get a + suffix on the incomplete total", () => {
    expect(lowerBoundLabel(7, true)).toBe("7+");
    expect(approvedOfTotalLabel(3, 200, true)).toBe("3 of 200+");
  });
});

describe("truncationNote / deliveryStateUnavailableNote", () => {
  it("are null when nothing is truncated", () => {
    expect(truncationNote(0)).toBeNull();
    expect(deliveryStateUnavailableNote(0)).toBeNull();
  });

  it("state the bound and the number of Campaigns, singular and plural", () => {
    expect(truncationNote(1)).toBe("Showing the first 200 obligations for 1 Campaign; counts are lower bounds.");
    expect(truncationNote(3)).toBe("Showing the first 200 obligations for 3 Campaigns; counts are lower bounds.");
    expect(deliveryStateUnavailableNote(1)).toBe("Unavailable: 1 active Campaign has more than 200 obligations.");
    expect(deliveryStateUnavailableNote(2)).toBe("Unavailable: 2 active Campaigns have more than 200 obligations.");
  });
});

describe("exceptionsNote", () => {
  it("keeps the accepted exact wording", () => {
    expect(exceptionsNote([], false)).toBe("No execution exceptions right now");
    expect(exceptionsNote([1], false)).toBe("1 exception across 1 category");
    expect(exceptionsNote([2, 3], false)).toBe("5 exceptions across 2 categories");
  });

  it("marks the total as a lower bound when truncated", () => {
    expect(exceptionsNote([1], true)).toBe("1+ exceptions across 1 category");
    expect(exceptionsNote([2, 3], true)).toBe("5+ exceptions across 2 categories");
  });
});

describe("toCampaignBoardRows", () => {
  it("maps rows one-to-one and carries each row's own truncated flag (exact rows stay exact)", () => {
    expect(
      toCampaignBoardRows([
        { campaignName: "Exact", approvedCount: 3, totalCount: 10, truncated: false },
        { campaignName: "Big", approvedCount: 40, totalCount: 200, truncated: true },
      ]),
    ).toEqual([
      { name: "Exact", completed: 3, required: 10, truncated: false },
      { name: "Big", completed: 40, required: 200, truncated: true },
    ]);
  });
});
