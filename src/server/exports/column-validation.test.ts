import { describe, expect, it } from "vitest";

import { validateRequestedColumns } from "./column-validation";
import { getExportTargetDefinition } from "./catalog";

const partners = getExportTargetDefinition("partners");

describe("validateRequestedColumns - server-authoritative column checks", () => {
  it("falls back to the target's own default columns when none are requested", () => {
    const result = validateRequestedColumns(partners, undefined);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.columnIds).toEqual(partners.defaultColumnIds);
  });

  it("accepts a valid subset, in deterministic catalog order regardless of request order", () => {
    const result = validateRequestedColumns(partners, ["status", "partnerRef", "displayName"]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const expectedOrder = partners.columns.map((c) => c.id).filter((id) => result.columnIds.includes(id));
      expect(result.columnIds).toEqual(expectedOrder);
      expect(result.columnIds).toEqual(["partnerRef", "displayName", "status"]);
    }
  });

  it("rejects an unknown column id outright (does not silently drop it)", () => {
    const result = validateRequestedColumns(partners, ["displayName", "panNumber"]);
    expect(result.ok).toBe(false);
  });

  it("rejects a raw internal/hidden field name reached by guessing (not on the allowlist)", () => {
    const result = validateRequestedColumns(partners, ["sourceDiscovery", "originLeadRefs", "legalName"]);
    expect(result.ok).toBe(false);
  });

  it("rejects a duplicate column id", () => {
    const result = validateRequestedColumns(partners, ["displayName", "displayName"]);
    expect(result.ok).toBe(false);
  });

  it("rejects an empty array", () => {
    const result = validateRequestedColumns(partners, []);
    expect(result.ok).toBe(false);
  });

  it("rejects a non-array payload", () => {
    const result = validateRequestedColumns(partners, "displayName");
    expect(result.ok).toBe(false);
  });

  it("rejects a non-string entry", () => {
    const result = validateRequestedColumns(partners, [123]);
    expect(result.ok).toBe(false);
  });

  it("a column valid for one target is rejected for a different target that does not declare it", () => {
    const campaigns = getExportTargetDefinition("campaigns");
    const result = validateRequestedColumns(campaigns, ["partnerRef"]);
    expect(result.ok).toBe(false);
  });
});
