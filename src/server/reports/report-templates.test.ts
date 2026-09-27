import { describe, expect, it } from "vitest";

import { getReportDefinition, listReportDefinitions } from "./catalog";
import { getReportTemplateDefinition, listReportTemplateDefinitions, REPORT_TEMPLATE_IDS } from "./report-templates";

describe("report template catalog (spec sections 5 + 21)", () => {
  it("has at least the 7 required management templates, plus the reconciled originals (spec section 21)", () => {
    expect(REPORT_TEMPLATE_IDS.length).toBeGreaterThanOrEqual(7);
    expect(listReportTemplateDefinitions().length).toBe(REPORT_TEMPLATE_IDS.length);
  });

  it("every one of the 13 catalog reportIds is reachable through at least one template (spec section 21: reconcile ALL 13)", () => {
    const reachableReportIds = new Set(listReportTemplateDefinitions().map((t) => t.reportId));
    for (const definition of listReportDefinitions()) {
      expect(reachableReportIds.has(definition.reportId), `${definition.reportId} has no template`).toBe(true);
    }
  });

  it("every template maps to a real, existing ReportDefinition (reportId)", () => {
    const validReportIds = new Set(listReportDefinitions().map((d) => d.reportId));
    for (const template of listReportTemplateDefinitions()) {
      expect(validReportIds.has(template.reportId), `${template.templateId} -> ${template.reportId}`).toBe(true);
      expect(() => getReportDefinition(template.reportId)).not.toThrow();
    }
  });

  it("every template declares at least one artifact format", () => {
    for (const template of listReportTemplateDefinitions()) {
      expect(template.artifactFormats.length).toBeGreaterThan(0);
    }
  });

  it("getReportTemplateDefinition round-trips every id", () => {
    for (const id of REPORT_TEMPLATE_IDS) {
      expect(getReportTemplateDefinition(id).templateId).toBe(id);
    }
  });

  it("Campaign / Event Performance Detailed and Compact share the SAME underlying reportId (disclosed architecture: one family, two publication templates)", () => {
    expect(getReportTemplateDefinition("campaign_event_performance_detailed").reportId).toBe("campaign_event_performance");
    expect(getReportTemplateDefinition("campaign_event_performance_compact").reportId).toBe("campaign_event_performance");
  });

  it("every template discloses its treatment (full vs baseline) explicitly", () => {
    for (const template of listReportTemplateDefinitions()) {
      expect(["full", "baseline"]).toContain(template.treatment);
    }
  });
});
