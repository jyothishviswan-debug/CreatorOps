import { describe, expect, it } from "vitest";

import { activeFilterCount, EMPTY_WORKSPACE_STATE, hasActiveFilters, parseWorkspaceUrlState, toWorkspaceRequest, withFilter, workspaceHref, workspaceStateKey } from "./workspace-query";

describe("parseWorkspaceUrlState", () => {
  it("parses no params into the empty state", () => {
    expect(parseWorkspaceUrlState({})).toEqual({ state: EMPTY_WORKSPACE_STATE, ignored: [] });
  });

  it("parses valid status, counterpartyType, counterpartyRef and commercialPeriod", () => {
    const { state, ignored } = parseWorkspaceUrlState({ status: "draft", counterpartyType: "partner", counterpartyRef: "partner-1", commercialPeriod: "2026-03" });
    expect(state).toEqual({ status: "DRAFT", counterpartyType: "PARTNER", counterpartyRef: "partner-1", commercialPeriod: "2026-03" });
    expect(ignored).toEqual([]);
  });

  it("drops and names an invalid status / counterpartyType / commercialPeriod", () => {
    const { state, ignored } = parseWorkspaceUrlState({ status: "nope", counterpartyType: "bogus", commercialPeriod: "2026-13" });
    expect(state.status).toBeNull();
    expect(state.counterpartyType).toBeNull();
    expect(state.commercialPeriod).toBeNull();
    expect(ignored.sort()).toEqual(["commercialPeriod", "counterpartyType", "status"]);
  });

  it("uses the first value of a repeated param", () => {
    const { state } = parseWorkspaceUrlState({ status: ["draft", "void"] });
    expect(state.status).toBe("DRAFT");
  });
});

describe("workspaceHref / workspaceQueryString", () => {
  it("is the bare path with no filters set", () => {
    expect(workspaceHref()).toBe("/finance/payables");
  });

  it("includes only set filters, in canonical order", () => {
    expect(workspaceHref({ status: "DRAFT", counterpartyType: null, counterpartyRef: null, commercialPeriod: "2026-03" })).toBe("/finance/payables?status=DRAFT&commercialPeriod=2026-03");
  });
});

describe("workspaceStateKey", () => {
  it("is 'all' for the empty state and the query string otherwise", () => {
    expect(workspaceStateKey(EMPTY_WORKSPACE_STATE)).toBe("all");
    expect(workspaceStateKey({ ...EMPTY_WORKSPACE_STATE, status: "VOID" })).toBe("?status=VOID");
  });
});

describe("withFilter / activeFilterCount / hasActiveFilters", () => {
  it("merges a partial change over a base state", () => {
    expect(withFilter(EMPTY_WORKSPACE_STATE, { status: "DRAFT" })).toEqual({ ...EMPTY_WORKSPACE_STATE, status: "DRAFT" });
  });

  it("counts only set filters", () => {
    expect(activeFilterCount(EMPTY_WORKSPACE_STATE)).toBe(0);
    expect(activeFilterCount({ status: "DRAFT", counterpartyType: "PARTNER", counterpartyRef: null, commercialPeriod: null })).toBe(2);
    expect(hasActiveFilters(EMPTY_WORKSPACE_STATE)).toBe(false);
    expect(hasActiveFilters({ ...EMPTY_WORKSPACE_STATE, status: "DRAFT" })).toBe(true);
  });
});

describe("toWorkspaceRequest", () => {
  it("sends only set filters plus the default limit", () => {
    expect(toWorkspaceRequest(EMPTY_WORKSPACE_STATE)).toEqual({ limit: 10 });
  });

  it("carries every set filter and an explicit cursor", () => {
    const state = { status: "DRAFT" as const, counterpartyType: "PARTNER" as const, counterpartyRef: "partner-1", commercialPeriod: "2026-03" };
    expect(toWorkspaceRequest(state, { cursor: "abc", limit: 25 })).toEqual({ limit: 25, status: "DRAFT", counterpartyType: "PARTNER", counterpartyRef: "partner-1", commercialPeriod: "2026-03", cursor: "abc" });
  });

  it("omits an empty cursor", () => {
    expect(toWorkspaceRequest(EMPTY_WORKSPACE_STATE, { cursor: null })).toEqual({ limit: 10 });
  });
});
