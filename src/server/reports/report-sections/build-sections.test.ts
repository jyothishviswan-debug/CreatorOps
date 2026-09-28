import { describe, expect, it } from "vitest";

import { getReportDefinition } from "../catalog";
import { getReportTemplateDefinition } from "../report-templates";
import type { ReportResult } from "../types";
import { buildEvidenceSections } from "./build-sections";
import type { ReportTableSection } from "./types";

// Reports PDF Composition & Management-Publication Polish (spec section 14): Partner Portfolio /
// Coverage no longer shows Partner Ref, and its "By Status" table uses the compact human-facing shape.
function portfolioResult(overrides: Partial<ReportResult>): ReportResult {
  return {
    reportId: "partner_portfolio",
    definitionVersion: 1,
    generatedAt: "2026-08-31T00:00:00.000Z",
    evidenceCutoff: "2026-08-31T00:00:00.000Z",
    appliedFilters: {},
    scopeSummary: { basis: "actor-scope (listPartners)", note: "Every actor-scoped Partner for the applied filters." },
    metrics: { partnerCount: 2, activeCount: 2, blacklistedCount: 0, pendingAccountSetupCount: 0 },
    rows: [],
    sections: {},
    limitations: [],
    truncated: false,
    rowCount: 0,
    maxRows: 100,
    provenance: [{ sourceModule: "partners", sourceFunction: "listPartners", recordCount: 2 }],
    ...overrides,
  } as ReportResult;
}

describe("Partner Portfolio / Coverage template (spec section 14)", () => {
  const definition = getReportDefinition("partner_portfolio");
  const template = getReportTemplateDefinition("partner_portfolio_coverage");

  it("declares portrait orientation (spec section 2)", () => {
    expect(template.orientation).toBe("portrait");
  });

  it("the By Status table never shows a Partner Ref column, and drops an all-unavailable Tier column", () => {
    const byStatus = [
      { partnerDisplayName: "Acme Creators", status: "ACTIVE", tier: null, region: "Kerala", pendingPartnerAccountSetup: false },
      { partnerDisplayName: "Beta Studio", status: "ACTIVE", tier: null, region: "Maharashtra", pendingPartnerAccountSetup: true },
    ];
    const result = portfolioResult({ rows: byStatus, sections: { byStatus } });
    const sections = buildEvidenceSections("partner_portfolio_coverage", definition, result);
    const table = sections.find((s): s is ReportTableSection => s.kind === "table" && s.title === "By Status");
    expect(table).toBeDefined();
    const columnIds = table!.columns.map((c) => c.id);
    expect(columnIds).not.toContain("partnerRef");
    expect(columnIds).not.toContain("tier"); // all-null in this fixture - dropped, not shown as all-"Not available".
    expect(columnIds).toContain("partnerDisplayName");
    expect(columnIds).toContain("status");
    expect(columnIds).toContain("region");
    expect(columnIds).toContain("pendingPartnerAccountSetup");
  });

  it("keeps the Tier column when at least one Partner actually has a tier value", () => {
    const byStatus = [
      { partnerDisplayName: "Acme Creators", status: "ACTIVE", tier: "GOLD", region: "Kerala", pendingPartnerAccountSetup: false },
      { partnerDisplayName: "Beta Studio", status: "ACTIVE", tier: null, region: "Maharashtra", pendingPartnerAccountSetup: true },
    ];
    const result = portfolioResult({ rows: byStatus, sections: { byStatus } });
    const sections = buildEvidenceSections("partner_portfolio_coverage", definition, result);
    const table = sections.find((s): s is ReportTableSection => s.kind === "table" && s.title === "By Status");
    expect(table!.columns.map((c) => c.id)).toContain("tier");
  });
});

describe("Monthly Partner Performance template orientation (spec section 2)", () => {
  it("declares landscape orientation - the ONE template that does", () => {
    const monthly = getReportTemplateDefinition("monthly_partner_performance");
    expect(monthly.orientation).toBe("landscape");
    for (const id of ["campaign_event_performance_detailed", "campaign_event_performance_compact", "weekly_rapid_response_programme", "cross_platform_partner_programme", "long_period_partner_programme", "partner_portfolio_coverage", "campaign_delivery", "channel_growth_freshness", "partner_review_evidence", "finance_status", "operations_attention", "discovery_funnel", "administration_security"] as const) {
      expect(getReportTemplateDefinition(id).orientation, `${id} should stay portrait`).toBe("portrait");
    }
  });
});
