import type { ActorContext } from "@/server/authz/types";
import { listPartnerReviewHeads } from "@/server/partner-reviews/partner-review-list-service";
import type { PartnerReviewHeadDto } from "@/server/partner-reviews/client-dto";

import { mapSourceError } from "../source-errors";
import type { AppliedExportFilters, ExportRow, ExportsServiceResult } from "../types";
import type { FetchRowsOptions } from "./types";

// Composes ONLY Partner Reviews' own published, already actor-scoped, already-bounded, evidence-free
// listPartnerReviewHeads - never the per-review evidence/detail service, never a raw Firestore read.

function projectRow(head: PartnerReviewHeadDto): ExportRow {
  return {
    reviewRef: head.reviewRef,
    partnerRef: head.partnerRef,
    partnerDisplayName: head.partnerDisplayName,
    periodKey: head.periodKey,
    periodStart: head.periodStart,
    periodEnd: head.periodEnd,
    latestStatus: head.latestStatus,
    currentFinalizedVersion: head.currentFinalizedVersion,
    openVersion: head.openVersion,
    createdAt: head.createdAt,
    updatedAt: head.updatedAt,
  };
}

export async function fetchPartnerReviewsRows(actor: ActorContext, appliedFilters: AppliedExportFilters, options: FetchRowsOptions): Promise<ExportsServiceResult<{ rows: ExportRow[]; rowCount: number; truncated: boolean }>> {
  const result = await listPartnerReviewHeads(actor, {
    limit: options.limit,
    status: appliedFilters.status,
    partnerRef: appliedFilters.partnerRef,
    periodKey: appliedFilters.periodKey,
  });
  if (!result.ok) return mapSourceError(result);

  const rows = result.data.heads.map(projectRow);
  return { ok: true, data: { rows, rowCount: rows.length, truncated: result.data.nextCursor !== null } };
}
