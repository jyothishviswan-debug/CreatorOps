import { describe, expect, it } from "vitest";

import { getReportDefinition } from "../catalog";
import { extractPdfText } from "../report-artifacts/pdf-text-extract.test-support";
import { generateReportPdf } from "../report-artifacts/pdf-renderer";
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

// Reports PDF Composition & Management-Publication Polish (spec sections 16/25): a real end-to-end
// regression - assemble the REAL Monthly Partner Performance sections through the REAL builder
// (buildEvidenceSections, exactly as generate-artifacts.ts does), render them through the REAL
// generateReportPdf, and scan the REAL rendered PDF text for every forbidden implementation-oriented
// phrase spec section 16/25 name. This is deliberately NOT a synthetic pdf-renderer.ts fixture (see
// pdf-renderer.test.ts's own "PDF-content guard" test) - it exists because a synthetic fixture cannot
// catch a real family/builder that still emits forbidden prose live: exactly what happened here
// ("N Partner row(s) with a tracked ... account or matched content in this run." was still being drawn
// into real generated PDFs after this stage's own synthetic-fixture guard test was already passing -
// found via live artifact inspection, not by any test, and fixed in the same change that added this one).
describe("Monthly Partner Performance - real rendered PDF contains no forbidden implementation prose (spec sections 16/25)", () => {
  it("scans the REAL generated PDF text (not a synthetic fixture) for every forbidden phrase", async () => {
    const definition = getReportDefinition("monthly_partner_performance");
    const template = getReportTemplateDefinition("monthly_partner_performance");
    const result: ReportResult = {
      reportId: "monthly_partner_performance",
      definitionVersion: 1,
      generatedAt: "2026-09-01T00:00:00.000Z",
      evidenceCutoff: "2026-08-31T00:00:00.000Z",
      appliedFilters: { period: "2026-08" },
      scopeSummary: { basis: "test", note: "test scope" },
      metrics: { partnerCount: 1, accountCoverageCount_instagram: 1, publishedContentCount_instagram: 1, views_instagram: 10_000, engagement_instagram: 520, staleAccountCount_instagram: 0, finalizedReviewCount: 0, withComplianceEvidenceCount: 0, withPerformanceEvidenceCount: 0 },
      rows: [
        {
          partnerRef: "p1",
          partnerDisplayName: "Acme Creators",
          platform: "instagram",
          periodKey: "2026-08",
          accountCount: 1,
          staleAccountCount: 0,
          publishedContentCount: 1,
          contentWithMetricsCount: 1,
          followersSnapshot: null,
          views: 10_000,
          likes: 500,
          comments: 20,
          engagement: 520,
          hasFinalizedReview: false,
          hasComplianceEvidence: null,
          hasPerformanceEvidence: null,
          openPartner: "Open Partner",
          openPartnerHref: "/analytics/partner/p1?platform=instagram",
        },
      ],
      sections: {
        viewsByPartnerPlatform: { instagram: { p1: [10_000] }, youtube: {} },
        topContentCandidatesByPlatform: { instagram: [], youtube: [] },
        partnerRoster: [{ partnerRef: "p1", partnerDisplayName: "Acme Creators" }],
      },
      limitations: [],
      truncated: false,
      rowCount: 1,
      maxRows: 100,
      provenance: [],
    } as unknown as ReportResult;

    const sections = buildEvidenceSections("monthly_partner_performance", definition, result);
    const bytes = await generateReportPdf(sections, {
      templateTitle: template.title,
      reportPurpose: `CreatorOps — ${template.title}`,
      scopeLine: result.scopeSummary.note,
      periodLine: "Reporting Period: 1–31 August 2026",
      generatedAtLine: `Generated: ${result.generatedAt}`,
      evidenceCutoffLine: `Evidence cutoff: ${result.evidenceCutoff}`,
      versionLabel: "Version 1 - FINALIZED",
      finalizedLine: "Finalized 2026-09-01T00:00:00.000Z",
      templateId: "monthly_partner_performance",
      orientation: template.orientation,
    });
    const text = await extractPdfText(bytes);
    const forbidden = ["[DRAFT]", "full actor scope", "Partner row(s)", "partnerRef", "views_standard", "renderer verification", "bounded, single-Partner", "wide-table rendering", "centered cell alignment"];
    for (const phrase of forbidden) {
      expect(text, `real rendered Monthly PDF must not contain "${phrase}"`).not.toContain(phrase);
    }
  });
});
