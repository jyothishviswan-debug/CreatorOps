import { describe, expect, it } from "vitest";

import { DISCOVERY_REGIONS } from "@/server/discovery/types";

import { narrowingRegions, selectsEveryRegion } from "./region-filter";

describe("region filter: every State/UT selected is no narrowing", () => {
  it("only the full canonical list (any case, extra free-text regions allowed) counts as 'All regions'", () => {
    const every = [...DISCOVERY_REGIONS];
    expect(selectsEveryRegion(every)).toBe(true);
    expect(selectsEveryRegion(every.map((region) => region.toUpperCase()))).toBe(true);
    expect(selectsEveryRegion([...every, "Custom Land"])).toBe(true);
    expect(selectsEveryRegion(every.slice(1))).toBe(false);
    expect(selectsEveryRegion([])).toBe(false);
  });

  it("narrowingRegions is empty for 'All regions' and otherwise the selection itself", () => {
    expect(narrowingRegions([...DISCOVERY_REGIONS])).toEqual([]);
    expect(narrowingRegions(["Kerala", "Goa"])).toEqual(["Kerala", "Goa"]);
    expect(narrowingRegions([])).toEqual([]);
  });
});
