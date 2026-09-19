import { describe, expect, it } from "vitest";

import { campaignBoardRowDisplay } from "./campaign-board";

describe("campaignBoardRowDisplay", () => {
  it("an exact row keeps the accepted rounded percentage, total and arc", () => {
    const display = campaignBoardRowDisplay({ completed: 3, required: 8, truncated: false });
    expect(display.percentLabel).toBe("38%");
    expect(display.rate).toBeCloseTo(0.375);
    expect(display.requiredLabel).toBe("8");
    expect(display.ariaLabel).toBe("3 of 8 completed");
  });

  it("an omitted truncated flag is exact (existing callers are unchanged)", () => {
    expect(campaignBoardRowDisplay({ completed: 1, required: 2 }).percentLabel).toBe("50%");
  });

  it("a truncated row shows N+, an unavailable percentage and an empty arc - never an exact-looking share", () => {
    const display = campaignBoardRowDisplay({ completed: 40, required: 200, truncated: true });
    expect(display.percentLabel).toBe("—");
    expect(display.rate).toBe(0);
    expect(display.requiredLabel).toBe("200+");
    expect(display.ariaLabel).toContain("percentage unavailable");
    expect(display.percentLabel).not.toMatch(/\d/);
  });

  it("a row with nothing to divide by shows the neutral dash, not NaN%", () => {
    expect(campaignBoardRowDisplay({ completed: 0, required: 0, truncated: false }).percentLabel).toBe("—");
  });
});
