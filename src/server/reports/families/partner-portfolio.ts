import type { ActorContext } from "@/server/authz/types";
import { listPartners } from "@/server/partners/partner-service";

import { buildReportResult } from "../result-builder";
import { mapSourceError } from "../source-errors";
import type { AppliedReportFilters, ReportResult, ReportRow, ReportsServiceResult } from "../types";

// Partner Portfolio (section 4) - Partner status/tier/region counts, sourced through Partners' own
// already actor-scoped, bounded listPartners.
const PAGE_SIZE = 100;

export async function runPartnerPortfolioReport(actor: ActorContext, appliedFilters: AppliedReportFilters): Promise<ReportsServiceResult<ReportResult>> {
  const generatedAt = new Date().toISOString();
  const status = appliedFilters.status as "ACTIVE" | "INACTIVE" | "BLACKLISTED" | "ARCHIVED" | undefined;

  const partnersResult = await listPartners(actor, { limit: PAGE_SIZE, status });
  if (!partnersResult.ok) return mapSourceError(partnersResult);

  const partners = partnersResult.data.partners;
  const activeCount = partners.filter((p) => p.status === "ACTIVE").length;
  const blacklistedCount = partners.filter((p) => p.status === "BLACKLISTED").length;
  const pendingAccountSetupCount = partners.filter((p) => p.pendingPartnerAccountSetup).length;

  const rows: ReportRow[] = partners.map((p) => ({ partnerRef: p.partnerRef, status: p.status, tier: p.tier ?? null, region: p.regionIds[0] ?? null, pendingPartnerAccountSetup: p.pendingPartnerAccountSetup }));

  return {
    ok: true,
    data: buildReportResult({
      reportId: "partner_portfolio",
      generatedAt,
      evidenceCutoff: generatedAt,
      appliedFilters,
      scopeSummary: { basis: "actor-scope (listPartners)", note: "Every actor-scoped Partner for the applied filters." },
      metrics: { partnerCount: partners.length, activeCount, blacklistedCount, pendingAccountSetupCount },
      rows,
      sections: { byStatus: rows },
      truncated: partnersResult.data.nextCursor !== null,
      rowCount: rows.length,
      provenance: [{ sourceModule: "partners", sourceFunction: "listPartners", recordCount: partners.length }],
    }),
  };
}
