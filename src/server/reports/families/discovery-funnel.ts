import type { ActorContext } from "@/server/authz/types";
import { listLeads } from "@/server/discovery/lead-service";

import { buildReportResult } from "../result-builder";
import { mapSourceError } from "../source-errors";
import type { AppliedReportFilters, ReportResult, ReportRow, ReportsServiceResult } from "../types";

// Discovery Funnel (section 4) - Lead lifecycle-stage counts, sourced through Discovery's own
// already actor-scoped, bounded listLeads.
const PAGE_SIZE = 100;

export async function runDiscoveryFunnelReport(actor: ActorContext, appliedFilters: AppliedReportFilters): Promise<ReportsServiceResult<ReportResult>> {
  const generatedAt = new Date().toISOString();
  const platform = appliedFilters.platform;

  const leadsResult = await listLeads(actor, { limit: PAGE_SIZE, platform });
  if (!leadsResult.ok) return mapSourceError(leadsResult);

  const leads = leadsResult.data.leads;
  const byLifecycle: Record<string, number> = {};
  for (const lead of leads) byLifecycle[lead.lifecycle] = (byLifecycle[lead.lifecycle] ?? 0) + 1;

  const convertedCount = byLifecycle["CONVERTED"] ?? 0;
  const watchlistCount = byLifecycle["WATCHLIST"] ?? 0;
  const rejectedOrArchivedCount = (byLifecycle["REJECTED"] ?? 0) + (byLifecycle["ARCHIVED"] ?? 0);

  const rows: ReportRow[] = leads.map((lead) => ({ leadRef: lead.leadRef, lifecycle: lead.lifecycle, region: lead.regionIds[0] ?? null, sourceType: lead.source?.type ?? null }));

  return {
    ok: true,
    data: buildReportResult({
      reportId: "discovery_funnel",
      generatedAt,
      evidenceCutoff: generatedAt,
      appliedFilters,
      scopeSummary: { basis: "actor-scope (listLeads)", note: "Every actor-scoped Lead for the applied filters." },
      metrics: { leadCount: leads.length, convertedCount, watchlistCount, rejectedOrArchivedCount },
      rows,
      sections: { byLifecycle },
      truncated: leadsResult.data.nextCursor !== null,
      rowCount: rows.length,
      provenance: [{ sourceModule: "discovery", sourceFunction: "listLeads", recordCount: leads.length }],
    }),
  };
}
