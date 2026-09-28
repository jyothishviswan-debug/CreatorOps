import { describe, expect, it } from "vitest";

import { getReportDefinition } from "../../catalog";
import type { ReportResult, ReportRow } from "../../types";
import type { ReportCoverSection, ReportTableSection } from "../types";
import { buildMonthlyPartnerPerformanceSections } from "./monthly-partner-performance";

// Reports PDF Composition & Management-Publication Polish: unit coverage for the rebuilt Monthly Partner
// Performance section builder - spec sections 5 (human-facing performance columns), 8 (Source-Metric
// Leaders across Output/Views/Engagement/Likes/Comments), 9 (per-Partner View-Band Distribution matrix),
// 10 (bounded multi-Partner Top Content), 13 (safe-state Partner Account Directory).
function baseResult(overrides: Partial<ReportResult>): ReportResult {
  return {
    reportId: "monthly_partner_performance",
    definitionVersion: 1,
    generatedAt: "2026-09-01T00:00:00.000Z",
    evidenceCutoff: "2026-08-31T00:00:00.000Z",
    appliedFilters: { period: "2026-08" },
    scopeSummary: { basis: "test", note: "test scope" },
    metrics: { partnerCount: 2, accountCoverageCount_instagram: 2, publishedContentCount_instagram: 3, views_instagram: 48_310_000, engagement_instagram: 2_920_000, staleAccountCount_instagram: 0, finalizedReviewCount: 0, withComplianceEvidenceCount: 0, withPerformanceEvidenceCount: 0 },
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

function performanceRow(partnerRef: string, partnerDisplayName: string, platform: "instagram" | "youtube", overrides: Partial<ReportRow> = {}): ReportRow {
  return {
    partnerRef,
    partnerDisplayName,
    platform,
    periodKey: "2026-08",
    accountCount: 1,
    staleAccountCount: 0,
    publishedContentCount: 3,
    contentWithMetricsCount: 3,
    followersSnapshot: null,
    views: 10_000,
    likes: 500,
    comments: 20,
    engagement: 520,
    hasFinalizedReview: false,
    hasComplianceEvidence: null,
    hasPerformanceEvidence: null,
    openPartner: "Open Partner",
    openPartnerHref: `/analytics/partner/${partnerRef}?platform=${platform}`,
    ...overrides,
  };
}

function isTable(section: { kind: string }): section is ReportTableSection {
  return section.kind === "table";
}

describe("buildMonthlyPartnerPerformanceSections", () => {
  const definition = getReportDefinition("monthly_partner_performance");

  it("cover shows a human period label and a real, non-fabricated platforms line", () => {
    const result = baseResult({ rows: [performanceRow("p1", "Acme Creators", "instagram")] });
    const sections = buildMonthlyPartnerPerformanceSections(definition, result, "Monthly Partner Performance");
    const cover = sections[0] as ReportCoverSection;
    expect(cover.kind).toBe("cover");
    expect(cover.periodLine).toBe("Reporting Period: 1–31 August 2026");
    expect(cover.platformsLine).toBe("Instagram");
  });

  it("the Instagram Partner Performance table shows only human-facing columns - no Partner Ref, periodKey, or internal has-flags", () => {
    const result = baseResult({ rows: [performanceRow("p1", "Acme Creators", "instagram", { followersSnapshot: 125_000 })] });
    const sections = buildMonthlyPartnerPerformanceSections(definition, result, "Monthly Partner Performance");
    const table = sections.find((s) => isTable(s) && s.title === "Instagram Partner Performance") as ReportTableSection;
    expect(table).toBeDefined();
    const columnIds = table.columns.map((c) => c.id);
    expect(columnIds).toEqual(["partnerDisplayName", "publishedContentCount", "contentWithMetricsCount", "followersSnapshot", "views", "likes", "comments", "engagement", "openPartner"]);
    expect(columnIds).not.toContain("partnerRef");
    expect(columnIds).not.toContain("periodKey");
    expect(columnIds).not.toContain("hasFinalizedReview");
    expect(columnIds).not.toContain("hasComplianceEvidence");
    expect(columnIds).not.toContain("openPartnerHref");
  });

  it("the performance table's own note never contains implementation-oriented prose (spec section 16) - found live in a real generated PDF, not just a synthetic fixture", () => {
    const result = baseResult({ rows: [performanceRow("p1", "Acme Creators", "instagram")] });
    const sections = buildMonthlyPartnerPerformanceSections(definition, result, "Monthly Partner Performance");
    const table = sections.find((s) => isTable(s) && s.title === "Instagram Partner Performance") as ReportTableSection;
    expect(table.note ?? "").not.toContain("Partner row(s)");
    expect(table.note ?? "").not.toMatch(/tracked .* account or matched content in this run/);
  });

  it("omits the Followers/Subscribers column entirely when unavailable for every row - never renders an all-Not-available column", () => {
    const result = baseResult({ rows: [performanceRow("p1", "Acme Creators", "instagram", { followersSnapshot: null })] });
    const sections = buildMonthlyPartnerPerformanceSections(definition, result, "Monthly Partner Performance");
    const table = sections.find((s) => isTable(s) && s.title === "Instagram Partner Performance") as ReportTableSection;
    expect(table.columns.map((c) => c.id)).not.toContain("followersSnapshot");
  });

  it("Source-Metric Leaders covers Output, Views, Engagement, Likes and Comments as SEPARATE tables (spec section 8)", () => {
    const result = baseResult({ rows: [performanceRow("p1", "Acme Creators", "instagram"), performanceRow("p2", "Beta Studio", "instagram", { views: 5000, likes: 100, comments: 5, engagement: 105 })] });
    const sections = buildMonthlyPartnerPerformanceSections(definition, result, "Monthly Partner Performance");
    const leaderTitles = sections.filter((s) => isTable(s) && s.sectionType === "source_metric_leaders").map((s) => (s as ReportTableSection).title);
    for (const metric of ["Output (Published Content)", "Views", "Engagement", "Likes", "Comments"]) {
      expect(leaderTitles.some((t) => t.includes(metric) && t.includes("Instagram"))).toBe(true);
    }
    // No blended-score note repeated under every table (spec section 8).
    const leaderTables = sections.filter((s) => isTable(s) && s.sectionType === "source_metric_leaders") as ReportTableSection[];
    for (const table of leaderTables) expect(table.note ?? "").not.toContain("blended score");
  });

  it("View-Band Distribution is a per-Partner Content-item-count matrix, not a Band -> Partner-count table (spec section 9)", () => {
    const result = baseResult({
      rows: [performanceRow("p1", "Acme Creators", "instagram"), performanceRow("p2", "Beta Studio", "instagram")],
      sections: {
        viewsByPartnerPlatform: {
          instagram: { p1: [500, 2_000, null], p2: [1_200_000] },
          youtube: {},
        },
        topContentCandidatesByPlatform: { instagram: [], youtube: [] },
        partnerRoster: [
          { partnerRef: "p1", partnerDisplayName: "Acme Creators" },
          { partnerRef: "p2", partnerDisplayName: "Beta Studio" },
        ],
      },
    });
    const sections = buildMonthlyPartnerPerformanceSections(definition, result, "Monthly Partner Performance");
    const matrix = sections.find((s) => isTable(s) && s.title === "Instagram View/Performance-Band Distribution") as ReportTableSection;
    expect(matrix).toBeDefined();
    expect(matrix.columns[0]!.id).toBe("partnerDisplayName");
    expect(matrix.columns.length).toBe(16); // Partner + 15 bands.
    const p1Row = matrix.rows.find((r) => r.partnerDisplayName === "Acme Creators")!;
    expect(p1Row["0-1K"]).toBe(1); // the 500 value.
    expect(p1Row["1K-5K"]).toBe(1); // the 2,000 value.
    // The null value is excluded, never counted as 0-1K.
    const totalCounted = matrix.columns.slice(1).reduce((sum, col) => sum + (typeof p1Row[col.id] === "number" ? (p1Row[col.id] as number) : 0), 0);
    expect(totalCounted).toBe(2);
    const p2Row = matrix.rows.find((r) => r.partnerDisplayName === "Beta Studio")!;
    expect(p2Row["1M-5M"]).toBe(1); // the 1,200,000 value.
    expect(matrix.note ?? "").not.toContain("views_standard");
    expect(matrix.note ?? "").not.toContain("Band");
  });

  it("multi-Partner Top Content works without a partnerRef filter (spec section 10) - real rows, human-facing columns, honest empty message", () => {
    const result = baseResult({
      rows: [performanceRow("p1", "Acme Creators", "instagram"), performanceRow("p2", "Beta Studio", "instagram")],
      sections: {
        viewsByPartnerPlatform: { instagram: {}, youtube: {} },
        topContentCandidatesByPlatform: {
          instagram: [
            { partnerDisplayName: "Acme Creators", publishedAt: "2026-08-10T00:00:00.000Z", views: 50_000, likes: 900, comments: 40, engagement: 940, openPost: "Open Post", openPostHref: "https://instagram.com/p/1", openPartner: null, openPartnerHref: null },
            { partnerDisplayName: "Beta Studio", publishedAt: "2026-08-12T00:00:00.000Z", views: 20_000, likes: 300, comments: 10, engagement: 310, openPost: "Open Post", openPostHref: "https://instagram.com/p/2", openPartner: null, openPartnerHref: null },
          ],
          youtube: [],
        },
        partnerRoster: [
          { partnerRef: "p1", partnerDisplayName: "Acme Creators" },
          { partnerRef: "p2", partnerDisplayName: "Beta Studio" },
        ],
      },
    });
    const sections = buildMonthlyPartnerPerformanceSections(definition, result, "Monthly Partner Performance");
    const topByViews = sections.find((s) => isTable(s) && s.title === "Instagram - Top 5 by Views") as ReportTableSection;
    expect(topByViews).toBeDefined();
    expect(topByViews.unavailableReason).toBeUndefined();
    expect(topByViews.rows.length).toBe(2);
    expect(topByViews.rows[0]!.partnerDisplayName).toBe("Acme Creators"); // ranked first - higher views.
    expect(topByViews.columns.map((c) => c.id)).toEqual(["rank", "partnerDisplayName", "date", "views", "likes", "comments", "engagement", "openPost"]);
    // Never mentions the old implementation restriction.
    expect(JSON.stringify(topByViews)).not.toContain("partnerRef");

    const topByViewsYoutube = sections.find((s) => isTable(s) && s.title === "YouTube - Top 5 by Views") as ReportTableSection;
    expect(topByViewsYoutube.rows.length).toBe(0);
    expect(topByViewsYoutube.emptyMessage).toBe("No qualifying YouTube content was available for this reporting period.");
  });

  it("Partner Account Directory uses safe states (Tracked/Stale/N/A), never a raw Partner Ref, and includes every roster Partner even with zero coverage", () => {
    const result = baseResult({
      rows: [performanceRow("p1", "Acme Creators", "instagram"), performanceRow("p2", "Beta Studio", "youtube", { staleAccountCount: 1 })],
      sections: {
        viewsByPartnerPlatform: { instagram: {}, youtube: {} },
        topContentCandidatesByPlatform: { instagram: [], youtube: [] },
        partnerRoster: [
          { partnerRef: "p1", partnerDisplayName: "Acme Creators" },
          { partnerRef: "p2", partnerDisplayName: "Beta Studio" },
          { partnerRef: "p3", partnerDisplayName: "Gamma Collective" }, // zero coverage on both platforms.
        ],
      },
    });
    const sections = buildMonthlyPartnerPerformanceSections(definition, result, "Monthly Partner Performance");
    const directory = sections.find((s) => isTable(s) && s.title === "Partner Account Directory / Appendix") as ReportTableSection;
    expect(directory).toBeDefined();
    expect(directory.columns.map((c) => c.id)).not.toContain("partnerRef");
    const acme = directory.rows.find((r) => r.partnerDisplayName === "Acme Creators")!;
    expect(acme.instagram).toBe("Tracked");
    expect(acme.youtube).toBe("N/A");
    const beta = directory.rows.find((r) => r.partnerDisplayName === "Beta Studio")!;
    expect(beta.youtube).toBe("Stale"); // staleAccountCount (1) >= accountCount (1).
    const gamma = directory.rows.find((r) => r.partnerDisplayName === "Gamma Collective")!;
    expect(gamma.instagram).toBe("N/A");
    expect(gamma.youtube).toBe("N/A");
    expect(JSON.stringify(directory.rows)).not.toMatch(/p1|p2|p3/);
  });

  it("KPI hierarchy: headline metrics grid excludes Review-evidence counters, which get their own secondary section (spec section 11)", () => {
    const result = baseResult({ rows: [performanceRow("p1", "Acme Creators", "instagram")], metrics: { partnerCount: 1, accountCoverageCount_instagram: 1, views_instagram: 48_310_000, finalizedReviewCount: 3, withComplianceEvidenceCount: 2, withPerformanceEvidenceCount: 1 } });
    const sections = buildMonthlyPartnerPerformanceSections(definition, result, "Monthly Partner Performance");
    const headline = sections.find((s) => s.kind === "kpi_summary" && s.title === "Partner Count, Coverage, Output, Views & Engagement");
    expect(headline).toBeDefined();
    if (headline && headline.kind === "kpi_summary") {
      expect(headline.items.some((i) => i.label.includes("Finalized Review"))).toBe(false);
      // Large aggregate values are abbreviated management-style (spec section 11).
      const viewsItem = headline.items.find((i) => i.label.toLowerCase().includes("views"));
      expect(viewsItem?.value).toBe("48.3M");
    }
    const secondary = sections.find((s) => s.kind === "kpi_summary" && s.title === "Partner Review Evidence Coverage");
    expect(secondary).toBeDefined();
  });
});
