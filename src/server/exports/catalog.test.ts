import { describe, expect, it } from "vitest";

import { getExportTargetDefinition, listExportTargetDefinitions } from "./catalog";
import { EXPORT_TARGET_IDS } from "./types";

describe("export target catalog", () => {
  it("has exactly the declared target ids, each with a non-empty column allowlist and at least one default column", () => {
    const definitions = listExportTargetDefinitions();
    expect(definitions.map((d) => d.targetId).sort()).toEqual([...EXPORT_TARGET_IDS].sort());
    for (const def of definitions) {
      expect(def.columns.length).toBeGreaterThan(0);
      expect(def.defaultColumnIds.length).toBeGreaterThan(0);
      // Every default column id must actually be one of the target's own declared columns.
      const columnIds = new Set(def.columns.map((c) => c.id));
      for (const id of def.defaultColumnIds) expect(columnIds.has(id), `${def.targetId}: default column "${id}" is not declared`).toBe(true);
      expect(def.allowedFormats.length).toBeGreaterThan(0);
      expect(def.maxRows).toBeGreaterThan(0);
      expect(def.requiredSourceFeatures.length).toBeGreaterThan(0);
    }
  });

  it("getExportTargetDefinition returns the matching definition for each id", () => {
    for (const id of EXPORT_TARGET_IDS) {
      expect(getExportTargetDefinition(id).targetId).toBe(id);
    }
  });

  it("no target offers a generic unrestricted collection export - every column id is an explicit, small allowlist entry", () => {
    for (const def of listExportTargetDefinitions()) {
      expect(def.columns.length).toBeLessThan(20);
    }
  });
});
