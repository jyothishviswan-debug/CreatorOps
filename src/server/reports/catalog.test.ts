import { describe, expect, it } from "vitest";

import { getReportDefinition, listReportDefinitions } from "./catalog";
import { REPORT_IDS, isReportId } from "./types";

const HIGH_VALUE_IDS = ["campaign_delivery", "campaign_performance", "channel_growth_freshness", "partner_review_evidence", "finance_status", "operations_attention"];
const ADDITIONAL_FULL_EXECUTION_IDS = ["discovery_funnel", "partner_portfolio", "administration_security"];
const MANAGEMENT_SCALE_IDS = ["monthly_partner_performance", "campaign_event_performance", "cross_platform_partner_programme", "long_period_partner_programme"];

describe("Reports catalog - exact ids", () => {
  it("has exactly 13 report ids, matching REPORT_IDS", () => {
    expect(REPORT_IDS).toHaveLength(13);
    expect(listReportDefinitions().map((d) => d.reportId).sort()).toEqual([...REPORT_IDS].sort());
  });

  it("isReportId accepts every catalog id and rejects an arbitrary string", () => {
    for (const id of REPORT_IDS) expect(isReportId(id)).toBe(true);
    expect(isReportId("not_a_real_report")).toBe(false);
    expect(isReportId(123)).toBe(false);
  });

  it("every id in the catalog is unique (no duplicate reportId)", () => {
    const ids = listReportDefinitions().map((d) => d.reportId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("Reports catalog - execution support", () => {
  it("the six section-12 high-value families are fully executed", () => {
    for (const id of HIGH_VALUE_IDS) expect(getReportDefinition(id as never).executionSupport, id).toBe("full");
  });

  it("the three additional families with a real existing source are also fully executed", () => {
    for (const id of ADDITIONAL_FULL_EXECUTION_IDS) expect(getReportDefinition(id as never).executionSupport, id).toBe("full");
  });

  it("Step 19A.1: the four management-scale families now have real, full execution - never a stub", () => {
    for (const id of MANAGEMENT_SCALE_IDS) {
      const def = getReportDefinition(id as never);
      expect(def.executionSupport, id).toBe("full");
      expect(def.maxRows, id).toBeGreaterThan(0);
      expect(def.metrics.length, id).toBeGreaterThan(0);
      expect(def.requiredSourceFeatures.length, id).toBeGreaterThan(0);
    }
  });

  it("exactly 13/13 catalog report entries have full execution - no stub anywhere", () => {
    const all = listReportDefinitions();
    expect(all.filter((d) => d.executionSupport === "full")).toHaveLength(13);
    expect(all.filter((d) => d.executionSupport === "not_yet_implemented")).toHaveLength(0);
  });

  it("Monthly Partner Performance and Long-Period Partner Programme no longer claim a Finance source - the 19A.1 spec's own 'Use:' list for both never mentioned Finance", () => {
    for (const id of ["monthly_partner_performance", "long_period_partner_programme"] as const) {
      const def = getReportDefinition(id);
      expect(def.sourceModules.some((m) => m.includes("finance")), id).toBe(false);
      expect(def.requiredSourceFeatures.includes("finance" as never), id).toBe(false);
    }
  });
});

describe("Reports catalog - definition metadata completeness", () => {
  it("every definition carries a title, purpose, source modules, required source features (or none for a stub), limitations and a positive version", () => {
    for (const def of listReportDefinitions()) {
      expect(def.title.length, def.reportId).toBeGreaterThan(0);
      expect(def.purpose.length, def.reportId).toBeGreaterThan(0);
      expect(def.sourceModules.length, def.reportId).toBeGreaterThan(0);
      expect(def.limitations.length, def.reportId).toBeGreaterThan(0);
      expect(def.version, def.reportId).toBeGreaterThanOrEqual(1);
      if (def.executionSupport === "full") expect(def.requiredSourceFeatures.length, def.reportId).toBeGreaterThan(0);
    }
  });

  it("every full-execution definition declares a positive maxRows bound", () => {
    for (const def of listReportDefinitions()) {
      if (def.executionSupport === "full") expect(def.maxRows, def.reportId).toBeGreaterThan(0);
    }
  });

  it("finance_status requires only the single 'finance' source feature (Agreements/Payables/Invoices/Payments share one FeatureAccess gate)", () => {
    expect(getReportDefinition("finance_status").requiredSourceFeatures).toEqual(["finance"]);
  });

  it("campaign_delivery requires campaigns, assignments AND content - narrower access to any one denies the whole report", () => {
    expect(getReportDefinition("campaign_delivery").requiredSourceFeatures.sort()).toEqual(["assignments", "campaigns", "content"].sort());
  });

  it("every declared filter id is unique per report and uses one of the recognized filter field types", () => {
    const validTypes = new Set(["period", "periodRange", "partnerRef", "partnerAccountRef", "campaignRef", "platform", "status"]);
    for (const def of listReportDefinitions()) {
      const ids = def.supportedFilters.map((f) => f.id);
      expect(new Set(ids).size, def.reportId).toBe(ids.length);
      for (const filter of def.supportedFilters) expect(validTypes.has(filter.type), `${def.reportId}.${filter.id}`).toBe(true);
    }
  });
});

describe("Reports catalog - metric semantics (section 6)", () => {
  it("partner_review_evidence has no blended/composite score metric - Production/Compliance/Performance stay separate sections", () => {
    const def = getReportDefinition("partner_review_evidence");
    const metricIds = def.metrics.map((m) => m.id.toLowerCase());
    for (const forbidden of ["blendedscore", "compositescore", "overallscore"]) expect(metricIds.some((id) => id.includes(forbidden)), def.reportId).toBe(false);
    expect(def.sections.map((s) => s.id).sort()).toEqual(["compliance", "performance", "production"].sort());
  });

  it("finance_status keeps service-base/GST/gross/TDS/expected-net/settlement conceptually distinct - no single metric id claims to combine them", () => {
    const def = getReportDefinition("finance_status");
    const ids = def.metrics.map((m) => m.id);
    expect(ids).toContain("payableTotalAmountMinorSigned");
    expect(ids).toContain("invoiceDeclaredGrossMinor");
    expect(ids).toContain("paymentSettledMinor");
    expect(ids.some((id) => /combined|blended|total(?!AmountMinorSigned)/i.test(id))).toBe(false);
  });

  it("campaign_performance never declares a cross-platform combined metric id", () => {
    const def = getReportDefinition("campaign_performance");
    for (const metric of def.metrics) expect(metric.id.toLowerCase(), metric.id).not.toMatch(/combined|allplatforms|crossplatform/);
  });

  it("campaign_event_performance never declares a cross-platform combined metric id (per-platform only)", () => {
    const def = getReportDefinition("campaign_event_performance");
    for (const metric of def.metrics) expect(metric.id.toLowerCase(), metric.id).not.toMatch(/combined|allplatforms|crossplatform/);
  });

  it("cross_platform_partner_programme keeps every platform metric separate except the ONE documented, explicitly-defined exception (publishedContentTotalAcrossPlatforms)", () => {
    const def = getReportDefinition("cross_platform_partner_programme");
    const combined = def.metrics.filter((m) => /combined|allplatforms|crossplatform|acrossplatforms/i.test(m.id));
    expect(combined.map((m) => m.id)).toEqual(["publishedContentTotalAcrossPlatforms"]);
    const exception = def.metrics.find((m) => m.id === "publishedContentTotalAcrossPlatforms")!;
    expect(exception.meaning.length).toBeGreaterThan(0);
    // followers/views/engagement stay fully per-platform - never a summed/blended id for these.
    for (const base of ["followers", "views", "engagement"]) {
      expect(def.metrics.some((m) => m.id === base), `unexpected unqualified ${base} metric`).toBe(false);
      expect(def.metrics.some((m) => m.id === `${base}_instagram`) || def.metrics.some((m) => m.id.startsWith(`${base}KnownCount_`)), base).toBe(true);
    }
  });

  it("long_period_partner_programme requires an explicit, bounded periods filter - never an open-ended date range", () => {
    const def = getReportDefinition("long_period_partner_programme");
    const periodsFilter = def.supportedFilters.find((f) => f.id === "periods");
    expect(periodsFilter).toBeDefined();
    expect(def.limitations.some((l) => /maximum of 6/.test(l))).toBe(true);
  });

  it("monthly_partner_performance declares no blended score metric", () => {
    const def = getReportDefinition("monthly_partner_performance");
    const metricIds = def.metrics.map((m) => m.id.toLowerCase());
    for (const forbidden of ["blendedscore", "compositescore", "overallscore"]) expect(metricIds.some((id) => id.includes(forbidden)), def.reportId).toBe(false);
  });
});
