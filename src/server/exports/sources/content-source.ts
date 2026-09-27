import type { ActorContext } from "@/server/authz/types";
import { listContent } from "@/server/content/content-service";
import type { ContentDto } from "@/server/content/client-dto";

import { mapSourceError } from "../source-errors";
import type { AppliedExportFilters, ExportRow, ExportsServiceResult } from "../types";
import type { FetchRowsOptions } from "./types";

// Composes ONLY Content's own published, already actor-scoped, already-bounded listContent - never a
// raw Firestore read, never a second Content query of this module's own invention.

function joinArray(values: string[]): string {
  return values.join("; ");
}

function projectRow(content: ContentDto): ExportRow {
  return {
    contentRef: content.contentRef,
    campaignRef: content.campaignRef,
    campaignName: content.campaignName,
    assignmentRef: content.assignmentRef,
    partnerRef: content.partnerRef,
    partnerDisplayName: content.partnerDisplayName,
    status: content.status,
    currentRevisionNumber: content.currentRevisionNumber,
    dueAt: content.dueAt,
    openedAt: content.openedAt,
    firstSubmittedAt: content.firstSubmittedAt,
    lastSubmittedAt: content.lastSubmittedAt,
    approvedAt: content.approvedAt,
    regionIds: joinArray(content.regionIds),
    ownerDisplayName: content.ownerDisplayName,
  };
}

export async function fetchContentRows(actor: ActorContext, appliedFilters: AppliedExportFilters, options: FetchRowsOptions): Promise<ExportsServiceResult<{ rows: ExportRow[]; rowCount: number; truncated: boolean }>> {
  const result = await listContent(actor, {
    limit: options.limit,
    status: appliedFilters.status,
    campaignRef: appliedFilters.campaignRef,
    assignmentRef: appliedFilters.assignmentRef,
    partnerRef: appliedFilters.partnerRef,
  });
  if (!result.ok) return mapSourceError(result);

  const rows = result.data.content.map(projectRow);
  return { ok: true, data: { rows, rowCount: rows.length, truncated: result.data.nextCursor !== null } };
}
