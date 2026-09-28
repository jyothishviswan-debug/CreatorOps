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

  // Bug class B fix (this stage's completion report): listPartners' own PartnerDto already carries
  // displayName (confirmed: Export Center's own partners-source.ts already resolves it from this exact
  // DTO) - it was simply never included here, which left partnerRef as the ONLY identifying field and
  // therefore the table's own primary column once buildBaselineSections turned this row into a visible
  // table (the user's own attached partner-portfolio-coverage-v1.pdf showed exactly this: a raw
  // partnerRef column, not a Partner name). No new service call - listPartners is already called above.
  //
  // Reports PDF Composition & Management-Publication Polish (spec section 14): partnerRef itself STAYS
  // on this evidence row (reports.emulator.test.ts's own Record Scope assertions key off
  // `result.rows[].partnerRef` - removing it here broke real, existing scope-enforcement test coverage,
  // not just cosmetic PDF output). The requirement this stage actually needs - "Partner Ref must never
  // appear in the PUBLISHED PDF" - is already satisfied one layer up, at the rendering boundary:
  // buildGenericTable's raw-ref-drop guard (report-sections/helpers.ts) removes any *Ref/*Id column
  // from the rendered table entirely whenever a name-shaped sibling column (partnerDisplayName here)
  // exists, for every renderer (PDF/XLSX/CSV) that consumes this same section model. The evidence layer
  // keeps full traceability; only the published artifact's own table columns are filtered.
  const rows: ReportRow[] = partners.map((p) => ({ partnerDisplayName: p.displayName, status: p.status, tier: p.tier ?? null, region: p.regionIds[0] ?? null, pendingPartnerAccountSetup: p.pendingPartnerAccountSetup, partnerRef: p.partnerRef }));

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
