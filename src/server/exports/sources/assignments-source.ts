import type { ActorContext } from "@/server/authz/types";
import { listAssignments } from "@/server/assignments/assignment-service";
import type { AssignmentDto } from "@/server/assignments/client-dto";

import { mapSourceError } from "../source-errors";
import type { AppliedExportFilters, ExportRow, ExportsServiceResult } from "../types";
import type { FetchRowsOptions } from "./types";

// Composes ONLY Assignments' own published, already actor-scoped, already-bounded listAssignments.

function joinArray(values: string[]): string {
  return values.join("; ");
}

function projectRow(assignment: AssignmentDto): ExportRow {
  return {
    assignmentRef: assignment.assignmentRef,
    campaignRef: assignment.campaignRef,
    campaignName: assignment.campaignName,
    partnerRef: assignment.partnerRef,
    partnerDisplayName: assignment.partnerDisplayName,
    partnerAccountLabels: joinArray(assignment.partnerAccountLabels),
    status: assignment.status,
    regionIds: joinArray(assignment.regionIds),
    ownerDisplayName: assignment.ownerDisplayName,
    createdAt: assignment.createdAt,
    updatedAt: assignment.updatedAt,
  };
}

export async function fetchAssignmentsRows(actor: ActorContext, appliedFilters: AppliedExportFilters, options: FetchRowsOptions): Promise<ExportsServiceResult<{ rows: ExportRow[]; rowCount: number; truncated: boolean }>> {
  const result = await listAssignments(actor, {
    limit: options.limit,
    status: appliedFilters.status,
    campaignRef: appliedFilters.campaignRef,
    platform: appliedFilters.platform,
  });
  if (!result.ok) return mapSourceError(result);

  const rows = result.data.assignments.map(projectRow);
  return { ok: true, data: { rows, rowCount: rows.length, truncated: result.data.nextCursor !== null } };
}
