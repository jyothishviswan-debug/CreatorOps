import type { ActorContext } from "@/server/authz/types";
import { listPartners } from "@/server/partners/partner-service";
import type { PartnerDto } from "@/server/partners/client-dto";

import { mapSourceError } from "../source-errors";
import type { AppliedExportFilters, ExportRow, ExportsServiceResult } from "../types";
import type { FetchRowsOptions } from "./types";

// Composes ONLY Partners' own published, already actor-scoped, already-bounded listPartners - never
// a raw Firestore read, never a second Partner query of this module's own invention.

function joinArray(values: string[]): string {
  return values.join("; ");
}

function projectRow(partner: PartnerDto): ExportRow {
  return {
    partnerRef: partner.partnerRef,
    displayName: partner.displayName,
    status: partner.status,
    tier: partner.tier,
    priority: partner.priority,
    regionIds: joinArray(partner.regionIds),
    categoryIds: joinArray(partner.categoryIds),
    email: partner.email,
    phone: partner.phone,
    ownerDisplayName: partner.ownerDisplayName,
    pendingPartnerAccountSetup: partner.pendingPartnerAccountSetup,
    createdAt: partner.createdAt,
    updatedAt: partner.updatedAt,
  };
}

export async function fetchPartnersRows(actor: ActorContext, appliedFilters: AppliedExportFilters, options: FetchRowsOptions): Promise<ExportsServiceResult<{ rows: ExportRow[]; rowCount: number; truncated: boolean }>> {
  const result = await listPartners(actor, {
    limit: options.limit,
    status: appliedFilters.status,
    region: appliedFilters.region,
  });
  if (!result.ok) return mapSourceError(result);

  const rows = result.data.partners.map(projectRow);
  return { ok: true, data: { rows, rowCount: rows.length, truncated: result.data.nextCursor !== null } };
}
