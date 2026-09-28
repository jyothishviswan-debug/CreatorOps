import { describe, expect, it } from "vitest";

import type { ReportDefinition, ReportResult } from "../types";
import { buildCoverSection, buildGenericTable } from "./helpers";

// Reports PDF Composition & Management-Publication Polish (spec sections 6/14): buildGenericTable's
// raw-ref-drop and all-unavailable-column-omission behavior - the ONE place every baseline-treatment
// template's PDF/XLSX/CSV table columns are decided, so this guard applies globally, not per-template.
describe("buildGenericTable - raw-ref suppression (spec section 6)", () => {
  it("drops a *Ref/*Id column entirely (not merely demotes it) when a name-shaped sibling column exists", () => {
    const table = buildGenericTable("Partners", [{ partnerDisplayName: "Acme Creators", partnerRef: "e055235f-128c-4b79-bd74-9741e576f554", status: "ACTIVE" }]);
    expect(table.columns.map((c) => c.id)).not.toContain("partnerRef");
    expect(table.columns.map((c) => c.id)).toEqual(["partnerDisplayName", "status"]);
    // Every renderer (pdf-renderer.ts's drawTable, xlsx-renderer.ts's sheetFromTable, csv-renderer.ts)
    // projects a row through `columns` ONLY, never through the row object's own raw keys - so a
    // COLUMNS-ONLY projection (what actually reaches a published artifact) never surfaces partnerRef,
    // even though it is still present on the underlying row object itself (by design: the same row
    // still backs `result.rows`/evidence-layer consumers elsewhere in the pipeline).
    const rendered = table.rows.map((row) => Object.fromEntries(table.columns.map((c) => [c.id, row[c.id] ?? null])));
    expect(JSON.stringify(rendered)).not.toContain("e055235f-128c-4b79-bd74-9741e576f554");
  });

  it("keeps a *Ref/*Id column when it is the ONLY identifying field on the row (nothing to promote instead)", () => {
    const table = buildGenericTable("Content", [{ contentRef: "content-abc-123", status: "APPROVED" }]);
    expect(table.columns.map((c) => c.id)).toContain("contentRef");
  });

  it("never renders a <col>Href paired link-target column as its own visible column", () => {
    const table = buildGenericTable("Top Content", [{ partnerDisplayName: "Acme Creators", openPost: "Open Post", openPostHref: "https://example.com/p/1" }]);
    expect(table.columns.map((c) => c.id)).toEqual(["partnerDisplayName", "openPost"]);
    expect(table.columns.map((c) => c.id)).not.toContain("openPostHref");
    // The Href field is still present on the ROW (pdf-renderer.ts's drawTable looks it up directly) -
    // only the COLUMN is suppressed.
    expect(table.rows[0]!.openPostHref).toBe("https://example.com/p/1");
  });
});

describe("buildGenericTable - all-unavailable column omission (spec section 14)", () => {
  it("drops a column entirely when every row's value for it is null - it contributes no information", () => {
    const table = buildGenericTable("Partners", [
      { partnerDisplayName: "Acme Creators", status: "ACTIVE", tier: null },
      { partnerDisplayName: "Beta Studio", status: "INACTIVE", tier: null },
    ]);
    expect(table.columns.map((c) => c.id)).not.toContain("tier");
  });

  it("keeps a column that has at least one non-null value, even if most rows are null", () => {
    const table = buildGenericTable("Partners", [
      { partnerDisplayName: "Acme Creators", tier: "GOLD" },
      { partnerDisplayName: "Beta Studio", tier: null },
    ]);
    expect(table.columns.map((c) => c.id)).toContain("tier");
  });

  it("never drops every column down to zero, even if every field on every row happens to be null", () => {
    const table = buildGenericTable("Empty-ish", [{ partnerDisplayName: "Acme Creators", tier: null, region: null }]);
    expect(table.columns.length).toBeGreaterThan(0);
    expect(table.columns.map((c) => c.id)).toContain("partnerDisplayName");
  });
});

function definition(): ReportDefinition {
  return { reportId: "partner_portfolio", title: "Partner Portfolio", purpose: "test", recordScopeNote: "test", supportedFilters: [], metrics: [], sections: [], limitations: [] } as unknown as ReportDefinition;
}

function result(overrides: Partial<ReportResult>): ReportResult {
  return {
    reportId: "partner_portfolio",
    definitionVersion: 1,
    generatedAt: "2026-08-31T00:00:00.000Z",
    evidenceCutoff: "2026-08-31T00:00:00.000Z",
    appliedFilters: {},
    scopeSummary: { basis: "test", note: "test scope note" },
    metrics: {},
    rows: [],
    sections: {},
    limitations: [],
    truncated: false,
    rowCount: 0,
    maxRows: 100,
    provenance: [],
    ...overrides,
  } as ReportResult;
}

describe("buildCoverSection - human period label (spec section 3)", () => {
  it("formats a real YYYY-MM period filter as a human date range", () => {
    const section = buildCoverSection({ definition: definition(), templateTitle: "Monthly Partner Performance", result: result({ appliedFilters: { period: "2026-08" } }) });
    expect(section.periodLine).toBe("Reporting Period: 1–31 August 2026");
  });

  it("falls back to an honest, non-technical phrase when no period filter was applied - never 'full actor scope'", () => {
    const section = buildCoverSection({ definition: definition(), templateTitle: "Monthly Partner Performance", result: result({ appliedFilters: {} }) });
    expect(section.periodLine).not.toContain("full actor scope");
    expect(section.periodLine).toBe("Reporting Period: All available reporting data");
  });

  it("omits platformsLine when the caller supplies none - never fabricates a region/platform claim", () => {
    const section = buildCoverSection({ definition: definition(), templateTitle: "Partner Portfolio", result: result({}) });
    expect(section.platformsLine).toBeUndefined();
  });
});
