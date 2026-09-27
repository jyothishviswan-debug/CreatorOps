import type { ActorContext } from "@/server/authz/types";
import { listCampaigns } from "@/server/campaigns/campaign-service";
import type { CampaignDto } from "@/server/campaigns/client-dto";

import { mapSourceError } from "../source-errors";
import type { AppliedExportFilters, ExportRow, ExportsServiceResult } from "../types";
import type { FetchRowsOptions } from "./types";

// Composes ONLY Campaigns' own published, already actor-scoped, already-bounded listCampaigns.

function joinArray(values: string[]): string {
  return values.join("; ");
}

function projectRow(campaign: CampaignDto): ExportRow {
  return {
    campaignRef: campaign.campaignRef,
    name: campaign.name,
    objective: campaign.objective,
    status: campaign.status,
    platforms: joinArray(campaign.platforms),
    startDate: campaign.startDate,
    endDate: campaign.endDate,
    regionIds: joinArray(campaign.regionIds),
    ownerDisplayName: campaign.ownerDisplayName,
    defaultReviewPolicy: campaign.defaultReviewPolicy,
    createdAt: campaign.createdAt,
    updatedAt: campaign.updatedAt,
  };
}

export async function fetchCampaignsRows(actor: ActorContext, appliedFilters: AppliedExportFilters, options: FetchRowsOptions): Promise<ExportsServiceResult<{ rows: ExportRow[]; rowCount: number; truncated: boolean }>> {
  const result = await listCampaigns(actor, {
    limit: options.limit,
    status: appliedFilters.status,
    region: appliedFilters.region,
    platform: appliedFilters.platform,
  });
  if (!result.ok) return mapSourceError(result);

  const rows = result.data.campaigns.map(projectRow);
  return { ok: true, data: { rows, rowCount: rows.length, truncated: result.data.nextCursor !== null } };
}
