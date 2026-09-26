import { describe, expect, it } from "vitest";

import { getExportTargetDefinition } from "./catalog";
import { parseAppliedExportFilters } from "./filters";

const partners = getExportTargetDefinition("partners");

describe("parseAppliedExportFilters - requested filter keys never grant access", () => {
  it("keeps only keys declared in the target's own supportedFilters", () => {
    const applied = parseAppliedExportFilters({ status: "ACTIVE", region: "Kerala", notARealFilter: "x" }, partners);
    expect(applied).toEqual({ status: "ACTIVE", region: "Kerala" });
  });

  it("drops a non-string value", () => {
    const applied = parseAppliedExportFilters({ status: 123 as unknown as string }, partners);
    expect(applied).toEqual({});
  });

  it("drops an empty or overlong value", () => {
    const applied = parseAppliedExportFilters({ status: "   ", region: "x".repeat(500) }, partners);
    expect(applied).toEqual({});
  });

  it("returns {} for undefined/non-object input", () => {
    expect(parseAppliedExportFilters(undefined, partners)).toEqual({});
    expect(parseAppliedExportFilters(null as unknown as undefined, partners)).toEqual({});
  });

  it("trims a valid value", () => {
    const applied = parseAppliedExportFilters({ status: "  ACTIVE  " }, partners);
    expect(applied).toEqual({ status: "ACTIVE" });
  });
});
