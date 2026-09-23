import { describe, expect, it } from "vitest";

import {
  activeFilterCount,
  EMPTY_WORKSPACE_STATE,
  hasActiveFilters,
  isCommercialPeriod,
  parseWorkspaceUrlState,
  toWorkspaceRequest,
  withFilter,
  workspaceHref,
  workspaceQueryString,
  workspaceStateKey,
} from "./workspace-query";

describe("parseWorkspaceUrlState", () => {
  it("returns the empty state for no params", () => {
    expect(parseWorkspaceUrlState(undefined)).toEqual({ state: EMPTY_WORKSPACE_STATE, ignored: [] });
    expect(parseWorkspaceUrlState({})).toEqual({ state: EMPTY_WORKSPACE_STATE, ignored: [] });
  });

  it("parses every valid filter", () => {
    const { state, ignored } = parseWorkspaceUrlState({ status: "SUBMITTED", counterpartyType: "VENDOR", counterpartyRef: "vnd_1", commercialPeriod: "2026-03", reconciliationState: "MISMATCH" });
    expect(state).toEqual({ status: "SUBMITTED", counterpartyType: "VENDOR", counterpartyRef: "vnd_1", commercialPeriod: "2026-03", reconciliationState: "MISMATCH" });
    expect(ignored).toEqual([]);
  });

  it("uppercases status/type/reconciliation before matching", () => {
    const { state } = parseWorkspaceUrlState({ status: "draft", counterpartyType: "partner", reconciliationState: "match" });
    expect(state.status).toBe("DRAFT");
    expect(state.counterpartyType).toBe("PARTNER");
    expect(state.reconciliationState).toBe("MATCH");
  });

  it("ignores invalid enum values and reports them", () => {
    const { state, ignored } = parseWorkspaceUrlState({ status: "NOT_A_STATUS", commercialPeriod: "2026-13" });
    expect(state.status).toBeNull();
    expect(state.commercialPeriod).toBeNull();
    expect(ignored).toEqual(["status", "commercialPeriod"]);
  });

  it("takes the first value of a repeated param and trims it", () => {
    const { state } = parseWorkspaceUrlState({ counterpartyRef: ["  ref_1  ", "ref_2"] });
    expect(state.counterpartyRef).toBe("ref_1");
  });
});

describe("isCommercialPeriod", () => {
  it("accepts YYYY-MM only", () => {
    expect(isCommercialPeriod("2026-01")).toBe(true);
    expect(isCommercialPeriod("2026-12")).toBe(true);
    expect(isCommercialPeriod("2026-13")).toBe(false);
    expect(isCommercialPeriod("2026-1")).toBe(false);
  });
});

describe("workspaceQueryString / workspaceHref / workspaceStateKey", () => {
  it("is empty for the empty state", () => {
    expect(workspaceQueryString(EMPTY_WORKSPACE_STATE)).toBe("");
    expect(workspaceHref()).toBe("/finance/invoices");
    expect(workspaceStateKey(EMPTY_WORKSPACE_STATE)).toBe("all");
  });

  it("carries every active filter, and nothing else", () => {
    const state = withFilter(EMPTY_WORKSPACE_STATE, { status: "APPROVED", reconciliationState: "BLOCKED" });
    expect(workspaceQueryString(state)).toBe("?status=APPROVED&reconciliationState=BLOCKED");
    expect(workspaceHref(state)).toBe("/finance/invoices?status=APPROVED&reconciliationState=BLOCKED");
    expect(workspaceStateKey(state)).toBe("?status=APPROVED&reconciliationState=BLOCKED");
  });
});

describe("activeFilterCount / hasActiveFilters", () => {
  it("counts each non-null filter", () => {
    expect(activeFilterCount(EMPTY_WORKSPACE_STATE)).toBe(0);
    expect(hasActiveFilters(EMPTY_WORKSPACE_STATE)).toBe(false);
    const state = withFilter(EMPTY_WORKSPACE_STATE, { status: "DRAFT", counterpartyType: "PARTNER" });
    expect(activeFilterCount(state)).toBe(2);
    expect(hasActiveFilters(state)).toBe(true);
  });
});

describe("toWorkspaceRequest", () => {
  it("defaults to the page limit and includes only set filters", () => {
    expect(toWorkspaceRequest(EMPTY_WORKSPACE_STATE)).toEqual({ limit: 10 });
  });

  it("passes every filter and an explicit cursor/limit through", () => {
    const state = withFilter(EMPTY_WORKSPACE_STATE, { status: "VOID", counterpartyRef: "ref_1", commercialPeriod: "2026-02", reconciliationState: "MATCH" });
    expect(toWorkspaceRequest(state, { cursor: "abc", limit: 25 })).toEqual({ limit: 25, status: "VOID", counterpartyRef: "ref_1", commercialPeriod: "2026-02", reconciliationState: "MATCH", cursor: "abc" });
  });
});
