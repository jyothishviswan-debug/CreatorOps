import { describe, expect, it } from "vitest";

import { activeFilterCount, EMPTY_WORKSPACE_STATE, hasActiveFilters, parseWorkspaceUrlState, toWorkspaceRequest, withFilter, workspaceHref, workspaceQueryString, workspaceStateKey } from "./workspace-query";

describe("parseWorkspaceUrlState", () => {
  it("returns the empty state for no params", () => {
    expect(parseWorkspaceUrlState(undefined)).toEqual({ state: EMPTY_WORKSPACE_STATE, ignored: [] });
    expect(parseWorkspaceUrlState({})).toEqual({ state: EMPTY_WORKSPACE_STATE, ignored: [] });
  });

  it("parses every valid filter", () => {
    const { state, ignored } = parseWorkspaceUrlState({ status: "RECORDED", counterpartyType: "VENDOR", counterpartyRef: "vnd_1", invoiceRef: "inv_1" });
    expect(state).toEqual({ status: "RECORDED", counterpartyType: "VENDOR", counterpartyRef: "vnd_1", invoiceRef: "inv_1" });
    expect(ignored).toEqual([]);
  });

  it("uppercases status/type before matching", () => {
    const { state } = parseWorkspaceUrlState({ status: "draft", counterpartyType: "partner" });
    expect(state.status).toBe("DRAFT");
    expect(state.counterpartyType).toBe("PARTNER");
  });

  it("ignores invalid enum values and reports them", () => {
    const { state, ignored } = parseWorkspaceUrlState({ status: "NOT_A_STATUS", counterpartyType: "NOT_A_TYPE" });
    expect(state.status).toBeNull();
    expect(state.counterpartyType).toBeNull();
    expect(ignored).toEqual(["status", "counterpartyType"]);
  });

  it("takes the first value and trims whitespace for array/text params", () => {
    const { state } = parseWorkspaceUrlState({ counterpartyRef: ["  vnd_1  ", "vnd_2"], invoiceRef: "  inv_9  " });
    expect(state.counterpartyRef).toBe("vnd_1");
    expect(state.invoiceRef).toBe("inv_9");
  });

  it("drops a blank text filter", () => {
    const { state } = parseWorkspaceUrlState({ counterpartyRef: "   ", invoiceRef: "" });
    expect(state.counterpartyRef).toBeNull();
    expect(state.invoiceRef).toBeNull();
  });
});

describe("workspaceQueryString / workspaceHref / workspaceStateKey", () => {
  it("round-trips through the query string", () => {
    const state = withFilter(EMPTY_WORKSPACE_STATE, { status: "CONFIRMED", invoiceRef: "inv_1" });
    const href = workspaceHref(state);
    expect(href).toBe("/finance/payments?status=CONFIRMED&invoiceRef=inv_1");
    expect(parseWorkspaceUrlState(Object.fromEntries(new URL(`https://x${href}`).searchParams)).state).toEqual(state);
  });

  it("returns 'all' as the state key for the empty state", () => {
    expect(workspaceStateKey(EMPTY_WORKSPACE_STATE)).toBe("all");
    expect(workspaceQueryString(EMPTY_WORKSPACE_STATE)).toBe("");
  });
});

describe("activeFilterCount / hasActiveFilters", () => {
  it("counts only non-null filters", () => {
    expect(activeFilterCount(EMPTY_WORKSPACE_STATE)).toBe(0);
    expect(hasActiveFilters(EMPTY_WORKSPACE_STATE)).toBe(false);
    const state = withFilter(EMPTY_WORKSPACE_STATE, { status: "DRAFT", counterpartyRef: "prt_1" });
    expect(activeFilterCount(state)).toBe(2);
    expect(hasActiveFilters(state)).toBe(true);
  });
});

describe("toWorkspaceRequest", () => {
  it("maps state + options to the request shape, omitting null filters", () => {
    const state = withFilter(EMPTY_WORKSPACE_STATE, { status: "FAILED" });
    expect(toWorkspaceRequest(state)).toEqual({ limit: 10, status: "FAILED" });
    expect(toWorkspaceRequest(state, { cursor: "abc", limit: 25 })).toEqual({ limit: 25, status: "FAILED", cursor: "abc" });
  });

  it("omits cursor when not provided", () => {
    expect(toWorkspaceRequest(EMPTY_WORKSPACE_STATE)).toEqual({ limit: 10 });
  });
});
