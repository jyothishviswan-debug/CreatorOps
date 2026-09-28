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

  // Bug class B fix: LeadDto already carries displayName - included here so leadRef is never the only
  // identifying field on this row (this array is not currently surfaced as its own baseline table since
  // `sections.byLifecycle` below is a count map rather than an array-of-rows, but the row projection
  // itself must still carry a resolved name, consistent with every other family's rows array, in case a
  // future change surfaces per-lead rows here).
  const rows: ReportRow[] = leads.map((lead) => ({ displayName: lead.displayName, lifecycle: lead.lifecycle, region: lead.regionIds[0] ?? null, sourceType: lead.source?.type ?? null, leadRef: lead.leadRef }));

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
